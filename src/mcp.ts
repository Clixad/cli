/**
 * MCP — the way this agent reaches anything that is not a file or a URL.
 *
 * Model Context Protocol servers are small programs that expose tools: a
 * database, a browser, an issue tracker, a design tool. The protocol is
 * JSON-RPC 2.0 over one of two transports, and the whole of what a client has to
 * do is `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
 * That is genuinely all of it, which is why this is a file rather than a
 * dependency: the CLI ships standalone through npx and every dependency is
 * weight on someone else's `npm install`.
 *
 * Three rules hold the design together.
 *
 * **A server that will not start is a warning, never a crash.** The config
 * points at other people's programs — a wrong path, an unset key, an npx
 * package that no longer publishes — and none of that may stop a coding agent
 * from opening. A failed server is reported in `/mcp` and its tools are simply
 * absent.
 *
 * **Every MCP tool goes through the permission gate.** We advertise these tools
 * to a model without knowing what they do; the name says `create_issue` and the
 * server decides what that means. So they are gated like `run_command` — asked
 * once, "always" remembered per session — and, like the write tools, they are
 * removed from the schema entirely in plan mode rather than merely refused.
 *
 * **Names are namespaced and sanitised.** `mcp__<server>__<tool>` keeps two
 * servers with a `search` tool apart, and OpenAI's function-name grammar
 * (`[A-Za-z0-9_-]{1,64}`) is narrower than MCP's, so a name that does not fit is
 * rewritten and de-duplicated rather than sent and rejected.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long a server gets to answer `initialize` and `tools/list`. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** How long one `tools/call` may take. Overridable with CLIXAD_MCP_TIMEOUT. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Protocol revision we speak. Servers negotiate down; we accept what they answer. */
export const PROTOCOL_VERSION = "2025-06-18";
/** Characters of one tool result kept. The rest is a metered context. */
export const MAX_RESULT_CHARS = 60_000;
/** Lines of a server's stderr kept for diagnosis when it fails. */
const MAX_STDERR_LINES = 20;

export class McpError extends Error {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export function isHttpConfig(c: McpServerConfig): c is McpHttpConfig {
  return (c as McpHttpConfig).url !== undefined;
}

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
  /** Files that contributed, nearest last — the same order they were merged in. */
  sources: string[];
  /** Files that exist but could not be used, with why. Surfaced by `/mcp`. */
  errors: string[];
}

/**
 * Where a config may live, least specific first.
 *
 * `.mcp.json` at the project root is the name the wider ecosystem settled on and
 * is usually committed, so a repo can ship the servers it expects. The two under
 * `.clixad/` and `~/.clixad/` are ours and are for the servers *you* use
 * everywhere. Later files win per server name, so a project may override a
 * personal one without editing it.
 */
export function mcpConfigPaths(root: string): string[] {
  return [join(homedir(), ".clixad", "mcp.json"), join(root, ".mcp.json"), join(root, ".clixad", "mcp.json")];
}

/** Read and merge the config files that exist. Never throws. */
export function loadMcpConfig(root: string): LoadedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};
  const sources: string[] = [];
  const errors: string[] = [];

  for (const path of mcpConfigPaths(root)) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // Named, not swallowed: a config with a trailing comma that silently does
      // nothing is indistinguishable from a feature that does not work.
      errors.push(`${short(path)}: ${(err as Error).message}`);
      continue;
    }
    const declared = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (declared === undefined) {
      errors.push(`${short(path)}: no "mcpServers" object`);
      continue;
    }
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
      errors.push(`${short(path)}: "mcpServers" must be an object`);
      continue;
    }
    sources.push(short(path));
    for (const [name, raw] of Object.entries(declared as Record<string, unknown>)) {
      const config = validateServer(name, raw);
      if (typeof config === "string") errors.push(`${short(path)}: ${config}`);
      else servers[name] = config;
    }
  }
  return { servers, sources, errors };
}

/** A validated server config, or the reason it is not one. */
function validateServer(name: string, raw: unknown): McpServerConfig | string {
  if (typeof raw !== "object" || raw === null) return `server "${name}" is not an object`;
  const c = raw as Record<string, unknown>;
  if (typeof c.url === "string") {
    let url: URL;
    try {
      url = new URL(expandEnv(c.url));
    } catch {
      return `server "${name}" has an invalid url`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return `server "${name}" must use http or https`;
    return {
      type: c.type === "sse" ? "sse" : "http",
      url: url.toString(),
      ...(isStringMap(c.headers) ? { headers: expandMap(c.headers) } : {}),
    };
  }
  if (typeof c.command !== "string" || !c.command.trim()) {
    return `server "${name}" needs either a "command" or a "url"`;
  }
  const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string") : undefined;
  return {
    type: "stdio",
    command: expandEnv(c.command),
    ...(args ? { args: args.map(expandEnv) } : {}),
    ...(isStringMap(c.env) ? { env: expandMap(c.env) } : {}),
    ...(typeof c.cwd === "string" ? { cwd: c.cwd } : {}),
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

/**
 * Expand `${VAR}` from the environment.
 *
 * The alternative is putting an API key in a file that is often committed. An
 * unset variable is left as written rather than replaced with an empty string:
 * a header reading `Bearer ${GITHUB_TOKEN}` fails with something you can read,
 * where `Bearer ` fails with a 401 nobody can explain.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => process.env[name] ?? whole);
}

function expandMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandEnv(v)]));
}

function short(path: string): string {
  return path.replace(homedir(), "~");
}

// ---------------------------------------------------------------------------
// JSON-RPC transports
// ---------------------------------------------------------------------------

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
}

interface Transport {
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
  /** Diagnostics for a server that failed — stderr for stdio, empty for http. */
  diagnostics(): string;
}

/** JSON-RPC over a child process's stdin/stdout, one message per line. */
class StdioTransport implements Transport {
  private child: ChildProcess;
  private buffer = "";
  private stderr: string[] = [];
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private exited?: string;

  constructor(config: McpStdioConfig, root: string) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd ?? root,
      // The server's own env plus ours. `shell: false` on purpose: the command
      // and its args are already separate, so there is nothing for a shell to
      // re-split, and a path with a space in it would be split if there were.
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // npx and friends are .cmd shims on Windows, which CreateProcess cannot
      // run without a shell. Everywhere else this stays off.
      shell: process.platform === "win32",
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      // Many servers log normally on stderr; keep only a tail, for failures.
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderr.push(line.trim());
        if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
      }
    });
    this.child.on("error", (err) => this.fail(`could not start: ${err.message}`));
    this.child.on("close", (code) => this.fail(`server exited with code ${code ?? "null"}`));
  }

  private fail(reason: string): void {
    this.exited ??= reason;
    // A dead server must not leave a caller awaiting a reply that can never come.
    for (const [, p] of this.pending) p.reject(new McpError(reason));
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        // Servers that print a banner on stdout exist. Ignore anything that is
        // not JSON rather than tearing the connection down over it.
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // a notification from the server
      const waiting = this.pending.get(Number(msg.id));
      if (!waiting) continue;
      this.pending.delete(Number(msg.id));
      if (msg.error) waiting.reject(new McpError(msg.error.message ?? `error ${msg.error.code ?? ""}`.trim()));
      else waiting.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.exited) return Promise.reject(new McpError(this.exited));
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))),
        timeoutMs,
      );
      const onAbort = () => settle(() => reject(new McpError("cancelled")));
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
      });
      this.child.stdin?.write(payload, (err) => {
        if (err) settle(() => reject(new McpError(`write failed: ${err.message}`)));
      });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.exited) return;
    this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close(): Promise<void> {
    this.exited ??= "closed";
    this.pending.clear();
    // Closing stdin is how a well-behaved MCP server is asked to stop; the kill
    // is the backstop for one that does not take the hint.
    try {
      this.child.stdin?.end();
    } catch {
      /* already gone */
    }
    const child = this.child;
    if (child.exitCode === null && child.signalCode === null) {
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref();
    }
  }

  diagnostics(): string {
    return this.stderr.join("\n");
  }
}

/**
 * JSON-RPC over Streamable HTTP.
 *
 * One POST per request. The server may answer with a plain JSON body or with an
 * SSE stream carrying the response as an event, and which one it picks is its
 * choice per request — so both are handled on every call rather than negotiated
 * once. `Mcp-Session-Id` is echoed back on every later request when the server
 * issues one; without it a stateful server treats each call as a new client.
 */
class HttpTransport implements Transport {
  private session?: string;
  private seq = 0;
  private closed = false;

  constructor(private config: McpHttpConfig) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    try {
      return await fetch(this.config.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (timer.signal.aborted && !signal?.aborted) {
        throw new McpError(`no response within ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new McpError(`request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new McpError("closed");
    const id = ++this.seq;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    const issued = res.headers.get("mcp-session-id");
    if (issued) this.session = issued;
    if (!res.ok) throw new McpError(`http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const msg = type.includes("text/event-stream")
      ? await readSseResponse(res, id)
      : ((await res.json().catch(() => null)) as RpcResponse | null);
    if (!msg) throw new McpError(`${method}: no JSON-RPC response in the reply`);
    if (msg.error) throw new McpError(msg.error.message ?? `error ${msg.error.code ?? ""}`.trim());
    return msg.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    // A notification has no id and no reply worth waiting on; a server that is
    // slow to accept it must not hold up the connection.
    await this.post({ jsonrpc: "2.0", method, params }, 10_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  diagnostics(): string {
    return "";
  }
}

/** Pull the response with the matching id out of an SSE body. */
async function readSseResponse(res: Response, id: number): Promise<RpcResponse | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim()) as RpcResponse;
            // The stream may carry progress notifications first; ours is the
            // one wearing our id.
            if (msg.id !== undefined && Number(msg.id) === id) return msg;
          } catch {
            /* keep reading */
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Servers and the hub
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  /** The name the model sees: `mcp__<server>__<tool>`. */
  qualified: string;
  server: string;
  /** The name the server knows it by, which is what `tools/call` is sent. */
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpState = "connecting" | "ready" | "failed" | "closed";

export interface McpStatus {
  name: string;
  state: McpState;
  transport: "stdio" | "http";
  toolCount: number;
  error?: string;
}

/** Text and any images one `tools/call` returned. */
export interface McpToolResult {
  text: string;
  images: { data: string; mimeType: string }[];
}

export class McpServerConnection {
  state: McpState = "connecting";
  error?: string;
  tools: McpToolInfo[] = [];
  private transport: Transport;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    root: string,
  ) {
    this.transport = isHttpConfig(config) ? new HttpTransport(config) : new StdioTransport(config, root);
  }

  get kind(): "stdio" | "http" {
    return isHttpConfig(this.config) ? "http" : "stdio";
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    try {
      await this.transport.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "clixad", version: "1" },
        },
        timeoutMs,
      );
      // Required by the spec before any other request; a strict server refuses
      // `tools/list` without it.
      await this.transport.notify("notifications/initialized", {});
      const listed = (await this.transport.request("tools/list", {}, timeoutMs)) as {
        tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
      };
      this.tools = (listed?.tools ?? [])
        .filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
          typeof t?.name === "string" && t.name.length > 0,
        )
        .map((t) => ({
          qualified: "", // assigned by the hub, which is what can see collisions
          server: this.name,
          name: t.name,
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema } : {}),
        }));
      this.state = "ready";
    } catch (err) {
      this.state = "failed";
      const diagnostics = this.transport.diagnostics();
      this.error = (err as Error).message + (diagnostics ? `\n  ${diagnostics.split("\n").slice(-3).join("\n  ")}` : "");
      await this.transport.close().catch(() => undefined);
    }
  }

  async call(tool: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpToolResult> {
    if (this.state !== "ready") throw new McpError(`server "${this.name}" is ${this.state}`);
    const raw = (await this.transport.request(
      "tools/call",
      { name: tool, arguments: args ?? {} },
      timeoutMs,
      signal,
    )) as {
      content?: unknown[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const result = renderContent(raw?.content, raw?.structuredContent);
    // The protocol reports a tool's own failure in the *result*, not as a
    // JSON-RPC error — it is the tool saying no, not the transport breaking —
    // and the model has to be told which of the two happened.
    if (raw?.isError) throw new McpError(result.text || "the tool reported an error");
    return result;
  }

  async close(): Promise<void> {
    this.state = "closed";
    await this.transport.close().catch(() => undefined);
  }
}

/** MCP's content array → the text a tool result is, plus any images. */
export function renderContent(content: unknown, structured?: unknown): McpToolResult {
  const images: { data: string; mimeType: string }[] = [];
  const parts: string[] = [];

  for (const item of Array.isArray(content) ? content : []) {
    const part = item as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown; resource?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string") {
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      images.push({ data: part.data, mimeType });
      parts.push(`[image: ${mimeType}]`);
      continue;
    }
    if (part?.type === "resource") {
      const res = part.resource as { text?: unknown; uri?: unknown } | undefined;
      if (typeof res?.text === "string") parts.push(res.text);
      else if (typeof res?.uri === "string") parts.push(`[resource: ${res.uri}]`);
      continue;
    }
    // An unknown part is still information; JSON is better than dropping it.
    if (part !== undefined) parts.push(JSON.stringify(part));
  }

  if (!parts.length && structured !== undefined) parts.push(JSON.stringify(structured, null, 2));
  const text = parts.join("\n").trim();
  return {
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [result truncated]` : text,
    images,
  };
}

/**
 * A tool name the OpenAI function grammar accepts: `[A-Za-z0-9_-]{1,64}`.
 *
 * MCP allows more than that, and a name the provider rejects fails the whole
 * request rather than the one tool — so it is rewritten here and the collisions
 * that rewriting can create are resolved by the hub, which is the only thing
 * that can see all of them at once.
 */
export function qualifiedToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  return name.length <= 64 ? name : name.slice(0, 64);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

export class McpHub {
  private constructor(readonly servers: McpServerConnection[]) {}

  /**
   * Connect to every configured server, in parallel, and never reject.
   *
   * Parallel because a slow server must not delay the others, and one that
   * cannot start must not delay anything: the whole point is that the REPL opens
   * whether or not somebody's Docker daemon is running today.
   */
  static async connect(
    servers: Record<string, McpServerConfig>,
    opts: { root: string; timeoutMs?: number } = { root: process.cwd() },
  ): Promise<McpHub> {
    const connections = Object.entries(servers).map(([name, config]) => new McpServerConnection(name, config, opts.root));
    await Promise.all(connections.map((c) => c.connect(opts.timeoutMs)));

    // Assign qualified names once every server has listed, so a collision — two
    // servers with the same tool, or two long names that truncate together — is
    // visible and can be broken deterministically.
    const taken = new Set<string>();
    for (const conn of connections) {
      for (const tool of conn.tools) {
        let name = qualifiedToolName(conn.name, tool.name);
        for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 61)}_${i}`;
        taken.add(name);
        tool.qualified = name;
      }
    }
    return new McpHub(connections);
  }

  /** An empty hub — what a run with no config, or a scripted run, gets. */
  static empty(): McpHub {
    return new McpHub([]);
  }

  tools(): McpToolInfo[] {
    return this.servers.filter((s) => s.state === "ready").flatMap((s) => s.tools);
  }

  /** The tool schema entries to advertise, in OpenAI function-tool shape. */
  toolSchemas(): unknown[] {
    return this.tools().map((t) => ({
      type: "function",
      function: {
        name: t.qualified,
        description: `[MCP: ${t.server}] ${t.description ?? t.name}`.slice(0, 1024),
        // A tool with no schema takes no arguments as far as we can tell; an
        // absent `parameters` is what OpenAI's format uses for that.
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  find(qualified: string): { server: McpServerConnection; tool: McpToolInfo } | undefined {
    for (const server of this.servers) {
      const tool = server.tools.find((t) => t.qualified === qualified);
      if (tool) return { server, tool };
    }
    return undefined;
  }

  async call(qualified: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    const found = this.find(qualified);
    if (!found) {
      const known = this.tools().map((t) => t.qualified);
      throw new McpError(
        known.length ? `unknown MCP tool ${qualified} — available: ${known.join(", ")}` : `unknown MCP tool ${qualified} — no MCP servers are connected`,
      );
    }
    return found.server.call(found.tool.name, args, callTimeoutMs(), signal);
  }

  status(): McpStatus[] {
    return this.servers.map((s) => ({
      name: s.name,
      state: s.state,
      transport: s.kind,
      toolCount: s.tools.length,
      ...(s.error ? { error: s.error } : {}),
    }));
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.close()));
  }
}

/** Per-call timeout, overridable for a server that is genuinely slow. */
export function callTimeoutMs(): number {
  const raw = Number(process.env.CLIXAD_MCP_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
}
