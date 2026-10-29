/**
 * MCP as the REPL actually wires it: a config in the workspace, servers
 * connected in the background after mount, their tools advertised on the next
 * model call, and `/mcp` reporting what happened.
 *
 * Its own file because it changes the working directory — `App` reads
 * `process.cwd()` as the workspace root, and a chdir inside a file whose other
 * tests also read it would make them depend on their own order.
 *
 * The property worth the setup: connecting is never on the startup path. These
 * are other people's programs, and a coding agent must open whether or not
 * somebody's server starts today.
 */
import React from "react"; // classic JSX transform needs React in scope
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { messageText } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};

const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 1800,
  ledger: [],
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let root: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "clixad-tui-mcp-"));
  process.chdir(root);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

/** A server that answers the handshake and offers one tool. */
function writeFixture(): string {
  const path = join(root, "server.mjs");
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
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: {} });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "lookup", description: "Look something up" }] });
    else reply({ content: [{ type: "text", text: "looked it up" }] });
  }
});
`,
    "utf8",
  );
  return path;
}

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

/** Records the tool schema of every model call, so we can see what was offered. */
function stubClient(turns: Pick<ChatTurn, "message" | "finishReason">[]) {
  let i = 0;
  const advertised: string[][] = [];
  const sent: ChatMessage[][] = [];
  const client = {
    models: async () => [],
    wallet: async () => wallet,
    async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      advertised.push(((opts.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name));
      const turn = turns[i++];
      if (!turn) throw new Error("no scripted turn left");
      for (const chunk of messageText(turn.message).match(/.{1,6}/gs) ?? []) opts.onDelta?.(chunk);
      return { ...turn, creditsCharged: 7, balance: 4981 };
    },
  } as unknown as GatewayClient;
  return { client, advertised, sent };
}

const say = (text: string) => ({ message: { role: "assistant" as const, content: text }, finishReason: "stop" });

describe("MCP in the REPL", () => {
  it("connects after mount, names the server, and offers its tools to the model", async () => {
    writeConfig({ demo: { command: process.execPath, args: [writeFixture()] } });
    const { client, advertised } = stubClient([say("hello")]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);

    await tick(600);
    expect(strip(lastFrame() ?? "")).toContain("mcp: demo (1 tools)");

    stdin.write("say hello");
    await tick();
    stdin.write("\r");
    await tick(200);

    // Namespaced, so two servers with a `lookup` each stay apart.
    expect(advertised[0]).toContain("mcp__demo__lookup");
    expect(advertised[0]).toContain("read_file");
  });

  it("lists the connected servers on /mcp", async () => {
    writeConfig({ demo: { command: process.execPath, args: [writeFixture()] } });
    const { client } = stubClient([]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await tick(600);

    stdin.write("/mcp");
    await tick();
    stdin.write("\r");
    await tick(150);
    const out = strip(lastFrame() ?? "");
    expect(out).toMatch(/demo\s+ready\s+stdio\s+1 tool/);
  });

  it("opens anyway when a server cannot start, and says why", async () => {
    // The failure that must never be fatal: a wrong path, an unset key, an npx
    // package that no longer publishes.
    writeConfig({ ghost: { command: "definitely-not-a-real-binary-xyz" } });
    const { client } = stubClient([say("still working")]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await tick(600);

    expect(strip(lastFrame() ?? "")).toContain("mcp: ghost did not start");
    // And the REPL is perfectly usable.
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick(200);
    expect(strip(lastFrame() ?? "")).toContain("still working");
  });

  it("names a config it could not parse", async () => {
    // A trailing comma that silently disables the feature is indistinguishable
    // from a feature that does not work.
    writeFileSync(join(root, ".mcp.json"), '{ "mcpServers": { "a": { "command": "x" }, } }', "utf8");
    const { client } = stubClient([]);
    const { lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await tick(200);
    expect(strip(lastFrame() ?? "")).toContain("mcp config —");
  });

  it("says nothing at all when there is no config", async () => {
    const { client } = stubClient([]);
    const { lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await tick(200);
    // Asserted on the two notices the effect can push, not on the substring
    // "mcp": the welcome banner carries a *randomly chosen* tip, one of which is
    // `/mcp`, so the broader check failed roughly one run in eight.
    const frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("mcp:");
    expect(frame).not.toContain("mcp config");
    expect(frame).not.toContain("did not start");
  });
});
