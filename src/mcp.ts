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
 * Four rules hold the design together.
 *
 * **Nothing from a repository runs before the user says so.** `.mcp.json` and
 * `.clixad/mcp.json` arrive with whatever was cloned, and starting a server is
 * running a program. So a server from either is held, unstarted, until the user
 * approves it, and the approval is bound to that server's entry exactly as
 * written: a later change to its command asks again. Only `~/.clixad/mcp.json`,
 * which the user wrote, starts on its own. And no server inherits this
 * process's environment: it gets the handful of variables a program needs to
 * run (`INHERITED_ENV`) plus what its own entry names, so an API key exported
 * in the shell reaches a server only when its config asks for it by name.
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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/**
 * Whose file a server came from. `user` is `~/.clixad/mcp.json`, written by the
 * person at the keyboard; `project` is either file in the workspace, which came
 * with the repository and starts nothing until approved.
 */
export type McpScope = "user" | "project";

/** Where one server's config came from, and what the user is shown to approve it. */
export interface McpServerOrigin {
  scope: McpScope;
  /** The file, `~`-shortened. */
  file: string;
  /**
   * SHA-256 of the entry as written, before `${VAR}` expansion. An approval is
   * for this and nothing else, so a changed command is a new question, while a
   * changed value of a variable it names is not.
   */
  fingerprint: string;
  /** The command line or URL as written, printable: control characters are escaped. */
  display: string;
  /** Every `${VAR}` the entry names: the environment it will be handed. */
  variables: string[];
}

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
  /** Per server, where its entry came from; the nearest file wins, as in `servers`. */
  origins: Record<string, McpServerOrigin>;
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
  return mcpConfigFiles(root).map((f) => f.path);
}

/** The same files with their scope. A workspace that *is* the home directory reads the personal file once. */
function mcpConfigFiles(root: string): { path: string; scope: McpScope }[] {
  const personal = join(homedir(), ".clixad", "mcp.json");
  const files: { path: string; scope: McpScope }[] = [{ path: personal, scope: "user" }];
  for (const path of [join(root, ".mcp.json"), join(root, ".clixad", "mcp.json")]) {
    if (resolve(path) !== resolve(personal)) files.push({ path, scope: "project" });
  }
  return files;
}

/** Read and merge the config files that exist. Never throws. */
export function loadMcpConfig(root: string): LoadedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};
  const origins: Record<string, McpServerOrigin> = {};
  const sources: string[] = [];
  const errors: string[] = [];

  for (const { path, scope } of mcpConfigFiles(root)) {
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
      if (typeof config === "string") {
        errors.push(`${short(path)}: ${config}`);
        continue;
      }
      servers[name] = config;
      origins[name] = {
        scope,
        file: short(path),
        fingerprint: fingerprint(raw),
        display: describeEntry(raw as Record<string, unknown>),
        variables: [...new Set(variablesIn(raw))].sort(),
      };
    }
  }
  return { servers, origins, sources, errors };
}

/** A validated server config, or the reason it is not one. */
function validateServer(name: string, raw: unknown): McpServerConfig | string {
  // A name is printed in notices and in the approval prompt, so one carrying an
  // escape sequence could repaint the terminal around the question it is in.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return `server ${JSON.stringify(name)} has control characters in its name`;
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

/** JSON with every object's keys sorted, so the same entry always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(raw: unknown): string {
  return createHash("sha256").update(canonicalJson(raw)).digest("hex");
}

/** Every `${VAR}` named anywhere in an entry. */
function variablesIn(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(variablesIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(variablesIn);
  return [];
}

/** Longest description printed in full; the file has the rest, and the prompt says so. */
const MAX_DISPLAY_CHARS = 2_000;

/**
 * One word as it would be typed: bare when it is printable ASCII with no space
 * or quote, otherwise quoted with every character outside printable ASCII
 * written as `\uXXXX`. The prompt is the only thing between a repository and a
 * running program, so what it shows has to be exactly what runs: an escape
 * sequence must not be able to repaint it, and a right-to-left override must
 * not be able to reorder it.
 */
function shellWord(word: string): string {
  if (/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(word)) return word;
  return JSON.stringify(word).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** An entry as the approval prompt shows it: the command line or URL, then its env, cwd and headers. */
function describeEntry(raw: Record<string, unknown>): string {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pairs = (v: unknown): [string, string][] =>
    isStringMap(v) ? Object.entries(v) : [];
  const lines: string[] = [];
  if (typeof raw.url === "string") {
    lines.push(`${raw.type === "sse" ? "sse" : "http"} ${shellWord(raw.url)}`);
    for (const [k, v] of pairs(raw.headers)) lines.push(`header ${shellWord(k)}: ${shellWord(v)}`);
  } else {
    lines.push([String(raw.command ?? ""), ...strings(raw.args)].map(shellWord).join(" "));
    for (const [k, v] of pairs(raw.env)) lines.push(`env ${shellWord(k)}=${shellWord(v)}`);
    if (typeof raw.cwd === "string") lines.push(`cwd ${shellWord(raw.cwd)}`);
  }
  const text = lines.join("\n");
  return text.length > MAX_DISPLAY_CHARS
    ? `${text.slice(0, MAX_DISPLAY_CHARS)}… (${text.length - MAX_DISPLAY_CHARS} more characters; read the file before approving)`
    : text;
}

// ---------------------------------------------------------------------------
// What a server process is given
// ---------------------------------------------------------------------------

/**
 * The variables a server inherits from this process, and nothing else.
 *
 * The MCP SDK's own default list (`getDefaultEnvironment`), plus the locale,
 * the temp directory and the time zone, none of which is a secret. Everything
 * else a server needs it names in its entry's `env`, usually as `${VAR}`, which
 * is also how the approval prompt can say which secrets it will receive.
 */
export const INHERITED_ENV: Readonly<Record<"posix" | "win32", readonly string[]>> = {
  posix: ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"],
  win32: [
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMFILES",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ],
};

/** The environment a stdio server is started with. */
export function mcpServerEnv(
  own: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  const wanted = INHERITED_ENV[platform === "win32" ? "win32" : "posix"];
  // Windows spells `Path` and `PATH` as one variable; match without case there.
  const byName = new Map(Object.keys(source).map((k) => [platform === "win32" ? k.toUpperCase() : k, k]));
  for (const name of wanted) {
    const key = byName.get(name);
    const value = key === undefined ? undefined : source[key];
    // A value starting `()` is an exported bash function, the SDK's exclusion.
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  return { ...env, ...own };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type McpDecision = "approved" | "declined";

interface ApprovalsFile {
  version: 1;
  /** Per workspace (its real path), per server name: the entry decided on, and how. */
  projects: Record<string, Record<string, { fingerprint: string; decision: McpDecision; at: string }>>;
}

/** Where the decisions are kept. In the home directory, so nothing in a workspace can answer for the user. */
export function mcpApprovalsPath(): string {
  return join(homedir(), ".clixad", "mcp-approvals.json");
}

function workspaceKey(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

/** The decisions on disk. A file that cannot be read is no decisions, so everything is asked again. */
function readApprovals(): ApprovalsFile {
  try {
    const parsed = JSON.parse(readFileSync(mcpApprovalsPath(), "utf8")) as ApprovalsFile;
    if (parsed?.version === 1 && parsed.projects && typeof parsed.projects === "object") return parsed;
  } catch {
    /* none yet, or unreadable */
  }
  return { version: 1, projects: {} };
}

/** What the user decided about this server in this workspace, if it was this exact entry. */
export function mcpDecision(root: string, name: string, fingerprint: string): McpDecision | undefined {
  const entry = readApprovals().projects[workspaceKey(root)]?.[name];
  return entry && entry.fingerprint === fingerprint ? entry.decision : undefined;
}

/** Remember a decision about these servers in this workspace. Written whole through a rename. */
export function recordMcpDecision(
  root: string,
  servers: { name: string; fingerprint: string }[],
  decision: McpDecision,
  at: Date = new Date(),
): void {
  const file = readApprovals();
  const key = workspaceKey(root);
  const project = (file.projects[key] ??= {});
  for (const server of servers) project[server.name] = { fingerprint: server.fingerprint, decision, at: at.toISOString() };
  const path = mcpApprovalsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
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
      // What a program needs to run plus what the entry names, and never the
      // rest of ours: this process's environment holds whatever the user
      // exported, API keys included, and a server is somebody else's program.
      // `shell: false` on purpose: the command and its args are already
      // separate, so there is nothing for a shell to re-split, and a path with
      // a space in it would be split if there were.
      env: mcpServerEnv(config.env),
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

/**
 * `unapproved`: from the repository and not yet approved, so not started.
 * `declined`: the user said not to start it, for this exact entry.
 * Neither has a process or a connection behind it.
 */
export type McpState = "unapproved" | "declined" | "connecting" | "ready" | "failed" | "closed";

export interface McpStatus {
  name: string;
  state: McpState;
  transport: "stdio" | "http";
  toolCount: number;
  error?: string;
}

/** A server waiting on the user, as the approval prompt shows it. */
export interface McpPendingServer {
  name: string;
  file: string;
  display: string;
  variables: string[];
  fingerprint: string;
}

/** Text and any images one `tools/call` returned. */
export interface McpToolResult {
  text: string;
  images: { data: string; mimeType: string }[];
}

export class McpServerConnection {
  state: McpState;
  error?: string;
  tools: McpToolInfo[] = [];
  /**
   * Created by `connect()` and nowhere else, because creating a stdio
   * transport *is* starting the program. A held connection never has one.
   */
  private transport?: Transport;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly root: string,
    readonly origin?: McpServerOrigin,
    held?: "unapproved" | "declined",
  ) {
    this.state = held ?? "connecting";
  }

  get kind(): "stdio" | "http" {
    return isHttpConfig(this.config) ? "http" : "stdio";
  }

  /** Lift the hold, after the user approved. Starts nothing by itself. */
  release(): void {
    if (this.state === "unapproved" || this.state === "declined") this.state = "connecting";
  }

  /** Remember a refusal, so `/mcp` can say why it is not running. */
  decline(): void {
    if (this.state === "unapproved") this.state = "declined";
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    // Held, already connected or failed, or closed: there is nothing to start.
    if (this.state !== "connecting" || this.transport) return;
    const transport = isHttpConfig(this.config) ? new HttpTransport(this.config) : new StdioTransport(this.config, this.root);
    this.transport = transport;
    try {
      await transport.request(
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
      await transport.notify("notifications/initialized", {});
      const listed = (await transport.request("tools/list", {}, timeoutMs)) as {
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
      // Closed while the handshake was running: stay closed.
      if (this.state !== "connecting") return;
      this.state = "ready";
    } catch (err) {
      if (this.state !== "connecting") return;
      this.state = "failed";
      const diagnostics = transport.diagnostics();
      this.error = (err as Error).message + (diagnostics ? `\n  ${diagnostics.split("\n").slice(-3).join("\n  ")}` : "");
      await transport.close().catch(() => undefined);
    }
  }

  async call(tool: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpToolResult> {
    if (this.state !== "ready" || !this.transport) throw new McpError(`server "${this.name}" is ${this.state}`);
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
    await this.transport?.close().catch(() => undefined);
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
  private constructor(
    readonly servers: McpServerConnection[],
    private readonly root: string,
  ) {}

  /**
   * Connect to every server given, in parallel, and never reject.
   *
   * For servers the caller has already decided may run; a config read from
   * disk goes through `fromConfig`, which holds the repository's servers.
   * Parallel because a slow server must not delay the others, and one that
   * cannot start must not delay anything: the whole point is that the REPL opens
   * whether or not somebody's Docker daemon is running today.
   */
  static async connect(
    servers: Record<string, McpServerConfig>,
    opts: { root: string; timeoutMs?: number } = { root: process.cwd() },
  ): Promise<McpHub> {
    const connections = Object.entries(servers).map(([name, config]) => new McpServerConnection(name, config, opts.root));
    const hub = new McpHub(connections, opts.root);
    await hub.startReleased(opts.timeoutMs);
    return hub;
  }

  /**
   * A hub for the config on disk, with nothing started yet.
   *
   * A server from `~/.clixad/mcp.json` is ready to start. A server from the
   * workspace is held unless the user approved this exact entry for this
   * workspace before, and stays held if they declined it. `startReleased`
   * then starts what may start; `approve` releases the rest.
   */
  static fromConfig(loaded: LoadedMcpConfig, opts: { root: string }): McpHub {
    const connections = Object.entries(loaded.servers).map(([name, config]) => {
      const origin = loaded.origins[name];
      let held: "unapproved" | "declined" | undefined;
      // No origin means nothing says where it came from, which is not a reason to trust it.
      if (!origin || origin.scope !== "user") {
        const decision = origin ? mcpDecision(opts.root, name, origin.fingerprint) : undefined;
        held = decision === "approved" ? undefined : decision === "declined" ? "declined" : "unapproved";
      }
      return new McpServerConnection(name, config, opts.root, origin, held);
    });
    return new McpHub(connections, opts.root);
  }

  /** An empty hub — what a run with no config, or a scripted run, gets. */
  static empty(): McpHub {
    return new McpHub([], process.cwd());
  }

  /**
   * Start every server that may start and has not been, in parallel. Returns
   * the ones it started, so the caller can say how each one went.
   */
  async startReleased(timeoutMs?: number): Promise<McpStatus[]> {
    const starting = this.servers.filter((s) => s.state === "connecting");
    await Promise.all(starting.map((c) => c.connect(timeoutMs)));
    this.assignNames();
    const names = new Set(starting.map((s) => s.name));
    return this.status().filter((s) => names.has(s.name));
  }

  /**
   * Give every listed tool its model-facing name. Names already given keep
   * theirs, so a server approved later cannot rename a tool the model has
   * already been told about. A collision (two servers with the same tool, or
   * two long names that truncate together) is broken deterministically.
   */
  private assignNames(): void {
    const taken = new Set(this.servers.flatMap((s) => s.tools.map((t) => t.qualified)).filter(Boolean));
    for (const conn of this.servers) {
      for (const tool of conn.tools) {
        if (tool.qualified) continue;
        let name = qualifiedToolName(conn.name, tool.name);
        for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 61)}_${i}`;
        taken.add(name);
        tool.qualified = name;
      }
    }
  }

  /** The servers waiting for the user, with what the prompt shows. */
  pending(opts: { includeDeclined?: boolean } = {}): McpPendingServer[] {
    return this.servers
      .filter((s) => s.state === "unapproved" || (opts.includeDeclined && s.state === "declined"))
      .map((s) => ({
        name: s.name,
        file: s.origin?.file ?? "",
        display: s.origin?.display ?? "",
        variables: s.origin?.variables ?? [],
        fingerprint: s.origin?.fingerprint ?? "",
      }));
  }

  /**
   * The user approved these held servers: remember it (bound to each entry as
   * written) when asked to, and start them. Names that are not held are
   * ignored. Returns how each one started.
   */
  async approve(names: string[], opts: { remember: boolean; timeoutMs?: number }): Promise<McpStatus[]> {
    const chosen = this.held(names);
    if (opts.remember) this.remember(chosen, "approved");
    for (const s of chosen) s.release();
    return this.startReleased(opts.timeoutMs);
  }

  /** The user declined these held servers: remember it, so they are not asked about again until the entry changes. */
  decline(names: string[]): void {
    const chosen = this.held(names).filter((s) => s.state === "unapproved");
    this.remember(chosen, "declined");
    for (const s of chosen) s.decline();
  }

  private held(names: string[]): McpServerConnection[] {
    const wanted = new Set(names);
    return this.servers.filter((s) => wanted.has(s.name) && (s.state === "unapproved" || s.state === "declined"));
  }

  private remember(servers: McpServerConnection[], decision: McpDecision): void {
    const entries = servers.filter((s) => s.origin).map((s) => ({ name: s.name, fingerprint: s.origin!.fingerprint }));
    if (!entries.length) return;
    try {
      recordMcpDecision(this.root, entries, decision);
    } catch {
      // Not remembered is not wrong: the next session asks again.
    }
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
