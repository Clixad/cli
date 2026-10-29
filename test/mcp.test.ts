/**
 * The MCP client, against a real server.
 *
 * The server is written into a temp file by the test and spoken to over stdio,
 * which is the point: this is a protocol implementation, and the only test that
 * proves a protocol implementation is one that completes the handshake. Mocking
 * the transport would test the shape of our own types.
 *
 * The other half is the failure behaviour, which matters more than the happy
 * path here. The config points at other people's programs — a wrong path, an
 * unset key, a package that no longer publishes — and none of that may stop a
 * coding agent from opening.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMcpTool, ToolError, type ToolContext } from "../src/tools.ts";
import type { ImageAttachment } from "../src/client.ts";
import type { PermissionRequest } from "../src/permissions.ts";
import {
  McpHub,
  expandEnv,
  isMcpToolName,
  loadMcpConfig,
  qualifiedToolName,
  renderContent,
} from "../src/mcp.ts";

let root: string;
const hubs: McpHub[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-mcp-"));
});
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()));
  rmSync(root, { recursive: true, force: true });
});

async function connect(servers: Record<string, unknown>): Promise<McpHub> {
  const hub = await McpHub.connect(servers as never, { root, timeoutMs: 10_000 });
  hubs.push(hub);
  return hub;
}

/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC, three methods.
 *
 * `echo` returns what it was given, `boom` reports a tool-level failure the way
 * the protocol says to — in the *result*, with `isError`, not as a JSON-RPC
 * error — because telling those two apart is something the client has to do.
 */
function writeServer(name = "server.mjs", opts: { failInit?: boolean } = {}): string {
  const path = join(root, name);
  writeFileSync(
    path,
    `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;            // a notification
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") {
      ${opts.failInit ? 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no thanks" } }) + "\\n");' : 'reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } });'}
      continue;
    }
    if (msg.method === "tools/list") {
      reply({ tools: [
        { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "boom", description: "Always fails" },
        { name: "picture", description: "Returns an image" },
      ] });
      continue;
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "boom") { reply({ content: [{ type: "text", text: "it went wrong" }], isError: true }); continue; }
      if (name === "picture") { reply({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }); continue; }
      reply({ content: [{ type: "text", text: "echo:" + (args && args.text) }] });
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } }) + "\\n");
  }
});
`,
    "utf8",
  );
  return path;
}

describe("loadMcpConfig", () => {
  it("reads .mcp.json from the project root", () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "echo", args: ["hi"] } } }));
    const loaded = loadMcpConfig(root);
    expect(loaded.servers.demo).toEqual({ type: "stdio", command: "echo", args: ["hi"] });
    expect(loaded.errors).toEqual([]);
  });

  it("lets a project config override a personal one by name", () => {
    mkdirSync(join(root, ".clixad"), { recursive: true });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "shared" } } }));
    writeFileSync(join(root, ".clixad/mcp.json"), JSON.stringify({ mcpServers: { db: { command: "mine" } } }));
    expect((loadMcpConfig(root).servers.db as { command: string }).command).toBe("mine");
  });

  it("names a broken config instead of silently doing nothing", () => {
    // A trailing comma that quietly disables the feature is indistinguishable
    // from a feature that does not work.
    writeFileSync(join(root, ".mcp.json"), '{ "mcpServers": { "a": { "command": "x" }, } }');
    const loaded = loadMcpConfig(root);
    expect(loaded.errors[0]).toMatch(/\.mcp\.json/);
    expect(Object.keys(loaded.servers)).toEqual([]);
  });

  it("rejects a server with neither a command nor a url, and keeps the rest", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { bad: { note: "nothing here" }, good: { command: "ok" } } }),
    );
    const loaded = loadMcpConfig(root);
    expect(loaded.errors.join()).toMatch(/"bad" needs either a "command" or a "url"/);
    expect(Object.keys(loaded.servers)).toEqual(["good"]);
  });

  it("takes an http server and refuses a non-http url", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { web: { type: "http", url: "https://example.com/mcp" }, bad: { url: "ftp://x/" } } }),
    );
    const loaded = loadMcpConfig(root);
    expect(loaded.servers.web).toMatchObject({ type: "http", url: "https://example.com/mcp" });
    expect(loaded.errors.join()).toMatch(/must use http or https/);
  });

  it("returns nothing at all when there is no config, without complaining", () => {
    const loaded = loadMcpConfig(root);
    expect(loaded.servers).toEqual({});
    expect(loaded.errors).toEqual([]);
  });
});

describe("expandEnv", () => {
  it("substitutes an environment variable so a key need not live in the file", () => {
    process.env.CLIXAD_TEST_MCP_TOKEN = "s3cret";
    expect(expandEnv("Bearer ${CLIXAD_TEST_MCP_TOKEN}")).toBe("Bearer s3cret");
    delete process.env.CLIXAD_TEST_MCP_TOKEN;
  });

  it("leaves an unset variable written out, so the failure is readable", () => {
    // `Bearer ` fails with a 401 nobody can explain; this fails with the name.
    expect(expandEnv("Bearer ${CLIXAD_DEFINITELY_UNSET}")).toBe("Bearer ${CLIXAD_DEFINITELY_UNSET}");
  });
});

describe("tool names", () => {
  it("namespaces by server and stays inside the OpenAI function grammar", () => {
    expect(qualifiedToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(qualifiedToolName("my server", "do it!")).toBe("mcp__my_server__do_it_");
    expect(qualifiedToolName("x".repeat(60), "y".repeat(60))).toHaveLength(64);
  });

  it("recognises its own names and nothing else", () => {
    expect(isMcpToolName("mcp__a__b")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
  });
});

describe("renderContent", () => {
  it("joins text parts and collects images separately", () => {
    const out = renderContent([
      { type: "text", text: "one" },
      { type: "image", data: "abc", mimeType: "image/jpeg" },
      { type: "text", text: "two" },
    ]);
    expect(out.text).toBe("one\n[image: image/jpeg]\ntwo");
    expect(out.images).toEqual([{ data: "abc", mimeType: "image/jpeg" }]);
  });

  it("falls back to structured content when there are no parts", () => {
    expect(renderContent([], { rows: 2 }).text).toBe('{\n  "rows": 2\n}');
  });

  it("reads an embedded resource's text", () => {
    expect(renderContent([{ type: "resource", resource: { uri: "file:///a", text: "inside" } }]).text).toBe("inside");
  });
});

describe("a connected server", () => {
  it("completes the handshake, lists tools and calls one", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    expect(hub.status()).toEqual([{ name: "fixture", state: "ready", transport: "stdio", toolCount: 3 }]);
    expect(hub.tools().map((t) => t.qualified)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__boom",
      "mcp__fixture__picture",
    ]);

    const result = await hub.call("mcp__fixture__echo", { text: "hello" });
    expect(result.text).toBe("echo:hello");
  });

  it("advertises each tool in the OpenAI function shape, marked as MCP", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    const schema = hub.toolSchemas() as { function: { name: string; description: string; parameters: unknown } }[];
    const echo = schema.find((t) => t.function.name === "mcp__fixture__echo")!;
    expect(echo.function.description).toContain("[MCP: fixture]");
    expect(echo.function.parameters).toEqual({ type: "object", properties: { text: { type: "string" } } });
    // A tool that declares no schema still needs a `parameters` object, or a
    // strict provider rejects the whole request rather than the one tool.
    expect(schema.find((t) => t.function.name === "mcp__fixture__boom")!.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("turns a tool's own failure into a throw, not a result that reads as success", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    await expect(hub.call("mcp__fixture__boom", {})).rejects.toThrow("it went wrong");
  });

  it("hands back images so the caller can show them to the model", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    const result = await hub.call("mcp__fixture__picture", {});
    expect(result.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  it("names the tools it does have when asked for one it does not", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    await expect(hub.call("mcp__fixture__nope", {})).rejects.toThrow(/mcp__fixture__echo/);
  });

  it("keeps two servers' identically-named tools apart", async () => {
    const hub = await connect({
      one: { command: process.execPath, args: [writeServer("one.mjs")] },
      two: { command: process.execPath, args: [writeServer("two.mjs")] },
    });
    const names = hub.tools().map((t) => t.qualified);
    expect(names).toContain("mcp__one__echo");
    expect(names).toContain("mcp__two__echo");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a server that does not come up", () => {
  it("is a failed status, not a thrown error", async () => {
    // Other people's programs. A missing binary must not stop the REPL opening.
    const hub = await connect({ ghost: { command: "definitely-not-a-real-binary-xyz" } });
    expect(hub.status()[0]!.state).toBe("failed");
    expect(hub.tools()).toEqual([]);
  });

  it("carries the reason, so /mcp can say what went wrong", async () => {
    const hub = await connect({ grumpy: { command: process.execPath, args: [writeServer("grumpy.mjs", { failInit: true })] } });
    expect(hub.status()[0]!.state).toBe("failed");
    expect(hub.status()[0]!.error).toContain("no thanks");
  });

  it("does not hold up the servers that do work", async () => {
    const hub = await connect({
      ghost: { command: "definitely-not-a-real-binary-xyz" },
      fixture: { command: process.execPath, args: [writeServer()] },
    });
    expect(hub.status().find((s) => s.name === "fixture")!.state).toBe("ready");
    expect(hub.tools()).toHaveLength(3);
  });

  it("refuses a call to a server that failed rather than hanging", async () => {
    const hub = await connect({ ghost: { command: "definitely-not-a-real-binary-xyz" } });
    await expect(hub.call("mcp__ghost__anything", {})).rejects.toThrow(/no MCP servers are connected|unknown MCP tool/);
  });
});

describe("an empty hub", () => {
  it("is what a run with no config gets, and it answers everything", async () => {
    const hub = McpHub.empty();
    expect(hub.tools()).toEqual([]);
    expect(hub.toolSchemas()).toEqual([]);
    expect(hub.status()).toEqual([]);
    await expect(hub.close()).resolves.toBeUndefined();
  });
});

describe("calling an MCP tool through the agent", () => {
  /** Records what was put to the gate, and answers with `allowed`. */
  function recordingPermit(allowed: boolean) {
    const seen: PermissionRequest[] = [];
    return {
      seen,
      permit: async (req: PermissionRequest) => {
        seen.push(req);
        return allowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, reason: "the user denied it", notice: "denied by you" } as const);
      },
    };
  }

  const ctx = (mcp: McpHub, over: Partial<ToolContext> = {}): ToolContext => ({ root, mcp, ...over });

  it("asks permission per tool, not per server", async () => {
    // We advertise these without knowing what they do — the server decides what
    // `create_issue` means — and `search_issues` may well be its neighbour on
    // the same connection. So approving one is never approving the other.
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    const { seen, permit } = recordingPermit(true);
    await runMcpTool(ctx(hub, { permit }), "mcp__fixture__echo", { text: "hi" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signature).toBe("mcp:mcp__fixture__echo");
    expect(seen[0]!.summary).toBe("echo via the fixture MCP server");
    // The arguments are the preview, because they are what the user is agreeing to.
    expect(seen[0]!.preview).toContain('"text": "hi"');
  });

  it("calls nothing when the user says no", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    const { permit } = recordingPermit(false);
    await expect(runMcpTool(ctx(hub, { permit }), "mcp__fixture__echo", { text: "hi" })).rejects.toThrow(ToolError);
  });

  it("returns the text, and attaches an image the tool produced", async () => {
    const attached: ImageAttachment[] = [];
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    const out = await runMcpTool(ctx(hub, { attach: (image) => attached.push(image) }), "mcp__fixture__picture", {});
    expect(attached).toEqual([{ mimeType: "image/png", data: "aGk=", label: "picture via the fixture MCP server (image)" }]);
    expect(out).toContain("the image follows this tool result");
  });

  it("turns a server's own failure into a tool error the model can read", async () => {
    const hub = await connect({ fixture: { command: process.execPath, args: [writeServer()] } });
    await expect(runMcpTool(ctx(hub), "mcp__fixture__boom", {})).rejects.toThrow(ToolError);
    await expect(runMcpTool(ctx(hub), "mcp__fixture__boom", {})).rejects.toThrow("it went wrong");
  });

  it("says so when no servers are connected at all", async () => {
    await expect(runMcpTool({ root }, "mcp__ghost__x", {})).rejects.toThrow(/no MCP servers are connected/);
  });
});
