/**
 * Agent tools — the file, search and shell primitives that make this a coding
 * agent rather than a chatbot. Pure, testable operations confined to a workspace
 * root. The agent loop (`agent.ts`) advertises them to the model as OpenAI-style
 * tool definitions and executes the calls the model requests.
 *
 * Side-effecting tools (`write_file`, `edit_file`, `run_command`) build a
 * `PermissionRequest` — including a rendered diff for edits — and run it past
 * `ctx.permit` before touching anything. The gate lives here, so no caller can
 * accidentally bypass it; the *policy* (modes, "always allow") lives in
 * `permissions.ts` and the dialog in the TUI.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { isAbsolute, relative, resolve, dirname, join, sep } from "node:path";
import { renderDiff } from "./diff.ts";
import { extractPdfText, looksLikePdf } from "./pdf.ts";
import { killTree, shells, ShellError, type ShellRegistry, type ShellSnapshot } from "./shells.ts";
import { parseTodos, todoResult, TodoError, type TodoList } from "./todos.ts";
import { fetchPage, WebError } from "./web.ts";
import { isMcpToolName, McpError, type McpHub } from "./mcp.ts";
import { PaywallError, type ImageAttachment, type WebSearchResult } from "./client.ts";
import type { Permit, PermissionMode, PermissionRequest, PlanDecision } from "./permissions.ts";

export class ToolError extends Error {}

/**
 * A `ToolError` that the permission gate raised, carrying the short, human
 * half of the refusal alongside the instruction the model gets. The agent loop
 * forwards `notice` to the UI so a denial reads as a decision rather than as a
 * red fault with a paragraph of model instructions in it.
 */
export class PermissionDeniedError extends ToolError {
  readonly notice: string;
  constructor(message: string, notice: string) {
    super(message);
    this.notice = notice;
  }
}

/**
 * Confine a possibly-relative path to `root`; throw on escape attempts.
 *
 * Exported because `mentions.ts` resolves `@path` references and has to apply
 * *this* rule rather than one that looks like it: two implementations of a
 * sandbox check is how a sandbox develops a hole.
 */
export function safeResolve(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  // Only a leading `..` *segment* escapes. A bare `startsWith("..")` also rejected
  // real in-workspace files whose names merely begin with dots (`..gitignore`),
  // which read to the model as a sandbox violation it could do nothing about.
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new ToolError(`path escapes workspace: ${p}`);
  }
  return abs;
}

/** Workspace-relative, forward-slashed — what we show the user and match globs against. */
function rel(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/") || ".";
}

/** What `ask_user` puts on screen. Rendered by the TUI's picker. */
export interface AskUserRequest {
  question: string;
  options: { label: string; description?: string }[];
}

export interface ToolContext {
  root: string;
  /** Gate for side-effecting tools. Absent = allow (used by tests). */
  permit?: Permit;
  /** Cancels a running command when the user hits Esc. */
  signal?: AbortSignal;
  /** Live output from long-running tools, so the TUI can show it as it happens. */
  onOutput?: (chunk: string) => void;
  /**
   * Put a plan to the user and report what they chose. Absent = plan mode has
   * no UI behind it (scripted runs), and `exit_plan_mode` then says so rather
   * than pretending the plan was approved.
   */
  approvePlan?: (plan: string) => Promise<PlanDecision>;
  /**
   * Search the web. Absent = no gateway is wired (a unit test), and the tool
   * says so instead of pretending the internet is empty.
   *
   * It goes through the gateway rather than straight out of the CLI because a
   * search API needs a key, and the CLI holding one would be the first time it
   * held any provider credential — the thing the whole architecture is arranged
   * to avoid.
   */
  webSearch?: (query: string, opts: { count?: number; signal?: AbortSignal }) => Promise<WebSearchResult[]>;
  /**
   * Put a multiple-choice question to the user and wait for the answer. Absent
   * = nobody is watching (`clixad -p`), and the tool raises rather than picking
   * a default, because a default is an answer the user did not give.
   */
  askUser?: (req: AskUserRequest) => Promise<string>;
  /**
   * Run a sub-agent with its own context. Absent inside a sub-agent, which is
   * what stops one spawning another and turning one prompt into a fan-out
   * nobody budgeted for.
   */
  spawn?: (description: string, prompt: string, onProgress?: (line: string) => void) => Promise<string>;
  /** The session's task list. Absent = `todo_write` has nowhere to write. */
  todos?: TodoList;
  /** Connected MCP servers, if any. */
  mcp?: McpHub;
  /**
   * Take an image into the conversation. Absent = images cannot be shown to
   * this model run, and `read_file` says so rather than returning bytes.
   */
  attach?: (image: ImageAttachment) => void;
  /** Background command registry. Defaults to the process-wide one. */
  shells?: ShellRegistry;
}

/** Ask the gate, or proceed when no gate is wired. */
async function gate(ctx: ToolContext, req: PermissionRequest): Promise<void> {
  if (!ctx.permit) return;
  const res = await ctx.permit(req);
  if (!res.allowed) throw new PermissionDeniedError(res.reason, res.notice);
}

/**
 * Re-throw a helper module's failure as something the model is told about.
 *
 * The agent loop's contract is that a tool throws `ToolError` for anything the
 * model should adapt to and anything else for a fault, and the fault path ends
 * the turn. A search that 503s, a page that times out and an MCP server that
 * died are all the first kind — the model can try something else — but they
 * arrive as their own error classes from modules that must not import this one.
 *
 * An abort is neither: it is the user pressing Esc, and it has to keep
 * travelling as an abort so the loop stops instead of telling the model the
 * network failed.
 */
function asToolError(err: unknown): never {
  if (err instanceof ToolError) throw err;
  if (passesThrough(err)) throw err;
  if (err instanceof ShellError || err instanceof WebError || err instanceof McpError || err instanceof TodoError) {
    throw new ToolError(err.message);
  }
  throw err;
}

/**
 * The same, for a tool whose work is a network call.
 *
 * Wider than `asToolError` on purpose, and only here. A search or a fetch can
 * fail in ways that are nobody's mistake and nobody's class — the gateway
 * answering 503 because no search key is configured, `fetch` throwing a
 * `TypeError` on a header a server did not like — and every one of them is
 * something the model should hear once and work around. Letting those through
 * as faults would end the turn over a third party having a bad minute.
 *
 * A genuine bug in one of these tools is therefore reported to the model rather
 * than crashing, which is the cost. It is the right way round: the tool that
 * reaches the internet is the one whose failures are ordinary.
 */
function networkToolError(err: unknown): never {
  if (err instanceof ToolError) throw err;
  if (passesThrough(err)) throw err;
  throw new ToolError((err as Error)?.message || String(err));
}

/**
 * Errors that are not the model's to work around, and must keep their type.
 *
 * An abort is the user pressing Esc: swallowing it into a tool result would let
 * the loop carry on past a stop. A paywall is the wallet running dry, and the
 * REPL has a whole flow for that — the ad wall, and the interrupted task queued
 * to resume. Turned into a tool error instead, the model would read "out of
 * credits", write a paragraph about it, and the user would get an essay where
 * they should have got the wall.
 */
function passesThrough(err: unknown): boolean {
  if (err instanceof PaywallError) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * What a failed `fs` call is, said to the model.
 *
 * Keyed on the errno rather than on the message, because the message is
 * `EACCES: permission denied, open '/very/long/absolute/path'` — an internal
 * detail with the workspace root in it, and nothing that says what to do
 * instead. Every entry here names the next move where there is one.
 */
const FS_REASON: Record<string, string> = {
  ENOTDIR: "it is a file, not a directory — use read_file",
  EISDIR: "it is a directory, not a file — use list_dir, or edit a file inside it",
  ENOENT: "it does not exist (a symlink pointing at nothing looks like this too)",
  EACCES: "permission denied",
  EPERM: "permission denied",
  ELOOP: "the path goes through a symlink loop",
  ENAMETOOLONG: "the path is too long",
  EMFILE: "this process has too many files open — try again",
  ENFILE: "the system has too many files open — try again",
  ENOSPC: "the disk is full",
  EROFS: "the filesystem is read-only",
};

/**
 * Run a filesystem call, and report a failure to the model instead of ending
 * the turn.
 *
 * `asToolError` states the loop's contract — a `ToolError` is something the
 * model works around, anything else is a fault that ends the turn — and the
 * file tools were the one place that did not keep it. Every call here fails for
 * reasons that are ordinary and correctable: `list_dir` on a path that turned
 * out to be a file, a directory holding a dangling symlink (every
 * `node_modules/.bin` has some), a file this process cannot read, a write into
 * a directory it cannot write. Each of those escaped as a raw
 * `ENOTDIR`/`ENOENT`/`EACCES`/`EISDIR` and killed the whole turn — after the
 * round trip had already been paid for, and without the model ever seeing the
 * error it could have corrected.
 *
 * `what` is the action, already carrying the workspace-relative path, so the
 * sentence reads as one thing: "cannot list src/main.ts: it is a file, not a
 * directory — use read_file".
 */
function fsCall<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (passesThrough(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new ToolError(`${what}: ${FS_REASON[code] ?? (err as Error).message}`);
  }
}

/**
 * A count the model sent, as a whole number — or the default when it is not one.
 *
 * `Math.floor("x")` is `NaN`, and `Math.max(1, NaN)` is `NaN` rather than 1, so
 * an offset that arrived as a word slipped past `read_file`'s "past the end"
 * guard and `slice(NaN - 1, NaN)` returned nothing at all: the tool answered a
 * perfectly readable file with an empty string, and the model read it as an
 * empty file. `run_command` had the sharper version of the same thing — a
 * `timeout` that was not a number reached `setTimeout`, which coerced it to
 * 1 ms and killed the command before it had started.
 *
 * Falling back to the default is right everywhere it is used: an unreadable
 * `offset` means "from the top" and an unreadable `limit`, `count` or `timeout`
 * means "as much as usual", which is exactly what omitting the field would have
 * given.
 */
function countArg(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

/**
 * A string argument, as the model actually sent it.
 *
 * Every tool signature here says `args: { path: string }`, and every one of
 * those is a compile-time claim about a value that arrives at runtime as
 * `JSON.parse` of whatever the model wrote. Nothing checked it. A model that
 * sent `path: 0`, `path: null` or `content: {…}` reached `readFileSync` or
 * `.trim()` and raised a raw `TypeError` out of the tool and out of the agent
 * loop — the same turn-ending fault as an unhandled `ENOTDIR`, for the same
 * reason: the model never sees the error, so it never corrects the call.
 *
 * A **number is accepted** and stringified. `{"path": 3}` next to
 * `{"offset": 3}` is a model being careless about types rather than about
 * intent, and a file really can be named `3`; refusing it would cost a paid
 * round trip to learn nothing. Everything else — an object, an array, a
 * boolean, null — is named, because there is no reading of it that is what the
 * model meant.
 */
function requireString(value: unknown, tool: string, field: string): string {
  const text = readString(value);
  if (text === undefined) {
    throw new ToolError(`${tool}: ${field} must be a string, got ${describeValue(value)}`);
  }
  return text;
}

/** The same, for a field the tool can do without. */
function optionalString(value: unknown, tool: string, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, tool, field);
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

/** What the model sent instead, in words, so the correction is obvious. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return "an unusable number";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * What a directory entry actually is, following a symlink exactly once.
 *
 * A `Dirent` describes the entry, not its target, so `isFile()` is false for
 * every symlink — which is why `glob` and `grep` used to skip linked files
 * entirely, and why `list_dir` had to `stat` each name and died on the first
 * dangling link it met. One guarded `stat`, and only for the entries that need
 * it: a link pointing at nothing is `other`, which is the honest answer and the
 * one both callers want.
 */
function entryKind(entry: Dirent, abs: string): "dir" | "file" | "other" {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return "other"; // sockets, fifos, devices
  try {
    const stat = statSync(abs);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  } catch {
    return "other";
  }
}

/** Whether a path is a readable file. Anything unreadable answers `false`. */
function isFilePath(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a `glob` or `grep` should start, refusing a `path` that is not there.
 *
 * Both tools used to walk whatever they were given and let `readdirSync` fail
 * quietly, so a mistyped directory came back as `no matches for <pattern>` —
 * indistinguishable from an honest empty result, and read by the model as "the
 * code is not in this repository" rather than "you spelled the folder wrong".
 * `list_dir` has always said `not found`; these two now say it too.
 */
function searchBase(ctx: ToolContext, path: string | undefined): string {
  const abs = safeResolve(ctx.root, path ?? ".");
  if (!existsSync(abs)) throw new ToolError(`not found: ${path ?? "."}`);
  return abs;
}

const MAX_FILE_BYTES = 400_000;
/** Lines one `read_file` returns without an explicit `limit`. */
const MAX_READ_LINES = 2000;
/** A single line longer than this is truncated: it is minified, not source. */
const MAX_READ_LINE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_WALK_FILES = 20_000;
const DEFAULT_COMMAND_TIMEOUT = 120_000;
/**
 * Biggest image we will put in a request, in bytes.
 *
 * Base64 adds a third, and the whole conversation is re-sent every round — so
 * an 8 MB screenshot is not one expensive request, it is every request for the
 * rest of the turn.
 *
 * The ceiling is set from the other end: `/v1/chat/completions` accepts a 16 MB
 * body, so this is what lets eight images accumulate in one conversation before
 * the request is refused outright — and a screenshot is 100–800 kB, so this is
 * generous for what it is actually for. Something larger is refused by name,
 * with the fix in the message.
 */
const MAX_IMAGE_BYTES = 1_500_000;
/** How many search results one `web_search` returns. */
const DEFAULT_SEARCH_RESULTS = 6;
const MAX_SEARCH_RESULTS = 10;
/** Options `ask_user` will put on screen. More than this is not a question. */
const MAX_ASK_OPTIONS = 6;
/** Output from a fresh background command, shown so the caller sees it start. */
const BACKGROUND_SETTLE_MS = 500;

/** Directories never worth walking into for glob/grep. */
/**
 * Directories never worth walking into for glob/grep.
 *
 * **Named one by one, because the shortcut that stood next to this list —
 * skipping every directory whose name begins with a dot — was wrong.** It made
 * `.github`, `.vscode`, `.claude`, `.husky`, `.circleci`, `.changeset` and
 * `.config` invisible to both tools while `list_dir` went on showing them, so
 * the agent could see that `.github/` existed and then find nothing in it, by
 * any pattern, including `.github/**` spelled out. A false negative from a
 * search tool is the worst answer this codebase can give: the model does not
 * retry, it concludes the file does not exist.
 *
 * What belongs here is a build or tool cache — machine-generated, usually
 * enormous, and never the thing anybody is looking for. What does not belong
 * here is configuration somebody wrote, whatever its name starts with.
 */
const SKIP_DIRS = new Set([
  // Version control.
  ".git",
  ".hg",
  ".svn",
  // Dependencies and their caches.
  "node_modules",
  ".yarn",
  ".pnpm-store",
  ".venv",
  ".tox",
  // Build output.
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".angular",
  ".dart_tool",
  // Tool caches.
  ".turbo",
  ".nx",
  ".cache",
  ".parcel-cache",
  ".gradle",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".terraform",
]);

export const TOOLS = {
  /**
   * Read a file, numbered, and optionally only a window of it.
   *
   * The numbers are what let the model say `app.tsx:412` instead of "the bit
   * near the top", and the window is what stops a 400 kB file being poured into
   * a metered context to look at forty lines of it. Both are how Claude Code
   * reads files, and the cost of neither is small on a product where the
   * context is the bill.
   *
   * The obvious hazard is that `edit_file` matches text exactly, so a model
   * that copies the numbers into `old_string` gets nothing. Two things guard
   * it: the tool description says the numbers are display only, and
   * `edit_file`'s not-found error names them, so a model that does it anyway
   * is told precisely what went wrong instead of guessing.
   */
  read_file(ctx: ToolContext, args: { path: string; offset?: number; limit?: number }): string {
    const path = requireString(args.path, "read_file", "path");
    const abs = safeResolve(ctx.root, path);
    if (!existsSync(abs)) throw new ToolError(`not found: ${path}`);
    const name = rel(ctx.root, abs);
    if (fsCall(`cannot read ${name}`, () => statSync(abs)).isDirectory()) {
      throw new ToolError(`${path} is a directory — use list_dir`);
    }

    // Read bytes, then decide what they are. Reading as utf8 first and sniffing
    // the string means a PNG arrives as several hundred kilobytes of mojibake
    // in a metered context, which is the expensive way to learn it is a PNG.
    const bytes = fsCall(`cannot read ${name}`, () => readFileSync(abs));

    const image = imageType(bytes);
    if (image) return readImage(ctx, bytes, name, image);
    if (looksLikePdf(bytes)) {
      const pdf = extractPdfText(bytes);
      const head = `${name} — PDF${pdf.pages ? `, ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}` : ""}`;
      if (!pdf.text) return `${head}\n${pdf.note ?? "no readable text"}`;
      const body = pdf.text.slice(0, MAX_FILE_BYTES);
      return (
        `${head}${pdf.note ? ` — ${pdf.note}` : ""}\n\n${body}` +
        (pdf.text.length > MAX_FILE_BYTES ? "\n… [truncated]" : "")
      );
    }
    if (isBinary(bytes)) {
      throw new ToolError(
        `${name} is a binary file (${bytes.length} bytes), not text — nothing useful to read. ` +
          "Use run_command with a tool that understands the format if you need its contents.",
      );
    }

    const raw = bytes.toString("utf8");
    const all = raw.split("\n");
    // A trailing newline is not a last line; counting one would make every
    // file report one line more than an editor shows.
    const total = all.length > 1 && all[all.length - 1] === "" ? all.length - 1 : all.length;

    const first = countArg(args.offset, 1);
    const want = countArg(args.limit, MAX_READ_LINES);
    const last = Math.min(total, first + want - 1);
    if (first > total) {
      return `${path} has ${total} lines; offset ${first} is past the end`;
    }

    const body = all
      .slice(first - 1, last)
      .map((line, i) => {
        const n = String(first + i).padStart(5, " ");
        const text = line.length > MAX_READ_LINE_CHARS ? `${line.slice(0, MAX_READ_LINE_CHARS)}… [line truncated]` : line;
        return `${n}\t${text}`;
      })
      .join("\n");

    // Said only when it is true, and said at the end where the model is
    // looking after the content — a silently shortened file read as a whole one
    // is how an agent concludes a symbol does not exist.
    const note =
      last < total || first > 1
        ? `\n… showing lines ${first}-${last} of ${total}. Read on with offset: ${last + 1}.`
        : "";
    // The line caps bound the shape of the output but not its size — two
    // thousand lines of two thousand characters is four megabytes — and this is
    // a metered context, so the byte ceiling stays as the outer bound.
    if (body.length > MAX_FILE_BYTES) {
      return `${body.slice(0, MAX_FILE_BYTES)}\n… [truncated at ${MAX_FILE_BYTES} chars — read a smaller range with offset/limit]`;
    }
    return body + note;
  },

  list_dir(ctx: ToolContext, args: { path?: string }): string {
    const path = optionalString(args.path, "list_dir", "path") ?? ".";
    const abs = safeResolve(ctx.root, path);
    if (!existsSync(abs)) throw new ToolError(`not found: ${path}`);
    const name = rel(ctx.root, abs);
    // The mirror of `read_file`'s "is a directory — use list_dir", and it was
    // missing: listing a file raised a raw ENOTDIR out of the agent loop and
    // ended the turn, over the most ordinary mistake a model makes here.
    if (!fsCall(`cannot list ${name}`, () => statSync(abs)).isDirectory()) {
      throw new ToolError(`${path} is a file — use read_file`);
    }
    // `withFileTypes` answers "is this a directory" from the directory entry
    // itself, without a `stat` per name. That is what makes a dangling symlink
    // survivable: `statSync` follows it, so one broken link — which every
    // `node_modules/.bin` and half of `dist/` has — used to throw ENOENT and
    // take the turn with it. A symlink still gets its own `stat`, because
    // whether it points at a directory is the one thing the entry cannot say,
    // and that one is guarded.
    const entries = fsCall(`cannot list ${name}`, () => readdirSync(abs, { withFileTypes: true })).map(
      (entry) => {
        const isDir = entryKind(entry, resolve(abs, entry.name)) === "dir";
        return { name: isDir ? `${entry.name}/` : entry.name, isDir };
      },
    );
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return entries.map((e) => e.name).join("\n") || "(empty)";
  },

  /** Find files by glob, e.g. `src/**\/*.ts`. Cheap orientation before reading. */
  glob(ctx: ToolContext, args: { pattern: string; path?: string }): string {
    const pattern = optionalString(args.pattern, "glob", "pattern");
    if (!pattern) throw new ToolError("glob needs a pattern");
    const base = searchBase(ctx, optionalString(args.path, "glob", "path"));
    const re = globToRegExp(pattern);
    const hits: string[] = [];
    walk(base, ctx.root, (abs) => {
      const r = rel(ctx.root, abs);
      if (re.test(r)) hits.push(r);
      return hits.length < MAX_GLOB_RESULTS;
    });
    if (hits.length === 0) return `no files match ${pattern}`;
    hits.sort();
    const more = hits.length >= MAX_GLOB_RESULTS ? `\n… [capped at ${MAX_GLOB_RESULTS}]` : "";
    return hits.join("\n") + more;
  },

  /** Search file contents with a regular expression; returns path:line: text. */
  grep(ctx: ToolContext, args: { pattern: string; path?: string; glob?: string }): string {
    const pattern = optionalString(args.pattern, "grep", "pattern");
    if (!pattern) throw new ToolError("grep needs a pattern");
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      throw new ToolError(`invalid regular expression: ${(err as Error).message}`);
    }
    const base = searchBase(ctx, optionalString(args.path, "grep", "path"));
    const globArg = optionalString(args.glob, "grep", "glob");
    const filter = globArg ? globToRegExp(globArg) : undefined;
    const out: string[] = [];
    walk(base, ctx.root, (abs) => {
      const r = rel(ctx.root, abs);
      if (filter && !filter.test(r)) return true;
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        return true;
      }
      if (content.includes("\0")) return true; // binary
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!re.test(line)) continue;
        out.push(`${r}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (out.length >= MAX_GREP_MATCHES) return false;
      }
      return true;
    });
    if (out.length === 0) return `no matches for ${pattern}`;
    const more = out.length >= MAX_GREP_MATCHES ? `\n… [capped at ${MAX_GREP_MATCHES} matches]` : "";
    return out.join("\n") + more;
  },

  async write_file(ctx: ToolContext, args: { path: string; content: string }): Promise<string> {
    const abs = safeResolve(ctx.root, requireString(args.path, "write_file", "path"));
    const content = requireString(args.content, "write_file", "content");
    const name = rel(ctx.root, abs);
    const before = existsSync(abs) ? fsCall(`cannot write ${name}`, () => readFileSync(abs, "utf8")) : "";
    const preview = renderDiff(before, content) || "(no change)";
    await gate(ctx, {
      tool: "write_file",
      signature: `write:${name}`,
      summary: `${before ? "overwrite" : "create"} ${name}`,
      preview,
      path: name,
      root: ctx.root,
    });
    fsCall(`cannot write ${name}`, () => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    });
    return `wrote ${content.length} bytes to ${name}`;
  },

  /**
   * Replace an exact snippet in a file. Preferred over write_file: it keeps the
   * rest of the file untouched and costs a fraction of the tokens (= credits).
   * An ambiguous match is an error rather than a guess.
   */
  async edit_file(
    ctx: ToolContext,
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ): Promise<string> {
    const path = requireString(args.path, "edit_file", "path");
    const abs = safeResolve(ctx.root, path);
    if (!existsSync(abs)) throw new ToolError(`not found: ${path}`);
    const oldString = requireString(args.old_string, "edit_file", "old_string");
    const newString = requireString(args.new_string, "edit_file", "new_string");
    if (oldString === newString) throw new ToolError("old_string and new_string are identical");

    const name = rel(ctx.root, abs);
    const before = fsCall(`cannot edit ${name}`, () => readFileSync(abs, "utf8"));
    const count = occurrences(before, oldString);
    if (count === 0) {
      throw new ToolError(
        `old_string not found in ${path} — read the file and copy the exact text, ` +
          "without the line numbers read_file puts in front of each line",
      );
    }
    if (count > 1 && !args.replace_all) {
      throw new ToolError(
        `old_string appears ${count} times in ${path} — add more surrounding context, or pass replace_all: true`,
      );
    }

    // split/join for both cases, never String.replace: `replace` interprets `$&`,
    // `` $` ``, `$'` and `$$` inside the *replacement*, so a new_string containing
    // any of them was silently corrupted — writing `PLACEHOLDERfoo` for `$&foo`,
    // and mangling ordinary code like `s.replace(/a/, '$1-$&')`. Worse, only the
    // single-occurrence branch did it, so the same edit differed by flag, and the
    // diff preview (built from `after`) showed the corruption as if intended.
    // Correct for one occurrence too, because count > 1 without replace_all is
    // rejected above.
    const after = before.split(oldString).join(newString);
    const preview = renderDiff(before, after) || "(no change)";
    await gate(ctx, {
      tool: "edit_file",
      signature: `write:${name}`,
      summary: `edit ${name}`,
      preview,
      path: name,
      root: ctx.root,
    });
    fsCall(`cannot edit ${name}`, () => writeFileSync(abs, after, "utf8"));
    return `edited ${name} (${count > 1 ? `${count} occurrences` : "1 occurrence"})`;
  },

  /**
   * Run a shell command in the workspace. Streams output to `ctx.onOutput` as it
   * arrives and dies with `ctx.signal`, so a runaway build can be interrupted.
   */
  async run_command(
    ctx: ToolContext,
    args: { command: string; timeout?: number; background?: boolean },
  ): Promise<string> {
    const command = (optionalString(args.command, "run_command", "command") ?? "").trim();
    if (!command) throw new ToolError("run_command needs a command");
    const background = args.background === true;
    await gate(ctx, {
      tool: "run_command",
      // The same signature either way: `npm run dev` is the same command and
      // the same risk whether or not we wait for it, so an "always" answered
      // once should not be asked again because a flag moved.
      signature: commandSignature(command),
      summary: `${background ? "run in the background" : "run"} ${command.length > 60 ? command.slice(0, 59) + "…" : command}`,
      preview: command,
      command,
      root: ctx.root,
    });
    if (!background) return execute(ctx, command, countArg(args.timeout, DEFAULT_COMMAND_TIMEOUT));

    const registry = ctx.shells ?? shells;
    let started: ShellSnapshot;
    try {
      started = registry.start(ctx.root, command);
    } catch (err) {
      asToolError(err);
    }
    // A moment's grace before reporting, so a command that dies immediately —
    // a typo, a missing binary, a port already in use — is reported as dead
    // rather than as "started", which is the one thing that would send the
    // model off building on top of a server that is not running.
    await sleep(BACKGROUND_SETTLE_MS, ctx.signal);
    const first = registry.read(started.id);
    ctx.onOutput?.(first.output);
    return (
      `Started in the background as ${started.id}.\n` +
      `Read its output with read_output({"shell_id":"${started.id}"}) and stop it with kill_shell.\n` +
      describeShell(first.snapshot) +
      (first.output.trim() ? `\n\n${first.output.trim().slice(0, 4_000)}` : "")
    );
  },

  /** Whatever a background command has printed since it was last read. */
  read_output(ctx: ToolContext, args: { shell_id: string; filter?: string }): string {
    const registry = ctx.shells ?? shells;
    const id = (optionalString(args.shell_id, "read_output", "shell_id") ?? "").trim();
    if (!id) {
      const running = registry.list();
      throw new ToolError(
        running.length
          ? `read_output needs a shell_id — running: ${running.map((s) => `${s.id} (${s.status})`).join(", ")}`
          : "read_output needs a shell_id, and no background commands have been started",
      );
    }
    let read;
    try {
      const filter = optionalString(args.filter, "read_output", "filter");
      read = registry.read(id, filter ? { filter } : {});
    } catch (err) {
      asToolError(err);
    }
    const notes = [
      describeShell(read.snapshot),
      read.missed ? `[${read.missed} characters scrolled out of the buffer before this read]` : "",
      read.filtered ? `[filter kept ${read.filtered.kept} of ${read.filtered.total} lines]` : "",
    ].filter(Boolean);
    const body = read.output.trim();
    return `${notes.join("\n")}\n\n${body || "(nothing new since the last read)"}`;
  },

  async kill_shell(ctx: ToolContext, args: { shell_id: string }): Promise<string> {
    const registry = ctx.shells ?? shells;
    const id = (optionalString(args.shell_id, "kill_shell", "shell_id") ?? "").trim();
    if (!id) throw new ToolError("kill_shell needs a shell_id");
    // Gated like the command that started it: stopping the dev server somebody
    // is using is a side effect, and the model does not know who is using it.
    await gate(ctx, {
      tool: "kill_shell",
      signature: `kill:${id}`,
      summary: `stop background command ${id}`,
      preview: registry.list().find((s) => s.id === id)?.command ?? id,
    });
    try {
      return describeShell(registry.kill(id));
    } catch (err) {
      asToolError(err);
    }
  },

  /**
   * Search the web.
   *
   * Results are titles, URLs and snippets — never page contents. A snippet is
   * enough to choose, and choosing is the point: the model picks one or two and
   * pays for those with `web_fetch`, instead of ten pages arriving uninvited in
   * a context that is billed by the token.
   */
  async web_search(ctx: ToolContext, args: { query: string; count?: number }): Promise<string> {
    const query = (optionalString(args.query, "web_search", "query") ?? "").trim();
    if (!query) throw new ToolError("web_search needs a query");
    if (!ctx.webSearch) {
      throw new ToolError(
        "web search is not available in this run — use web_fetch on a URL you already know instead",
      );
    }
    const count = Math.min(MAX_SEARCH_RESULTS, countArg(args.count, DEFAULT_SEARCH_RESULTS));
    let results: WebSearchResult[];
    try {
      results = await ctx.webSearch(query, { count, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (err) {
      networkToolError(err);
    }
    if (!results.length) return `no results for "${query}"`;
    return (
      `${results.length} result(s) for "${query}":\n\n` +
      results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.age ? `\n   ${r.age}` : ""}\n   ${r.snippet}`)
        .join("\n\n") +
      "\n\nFetch one with web_fetch to read it."
    );
  },

  /**
   * Read one URL.
   *
   * Ungated, and that is a decision rather than an oversight. Plan mode is
   * exactly when a model needs to go and read the documentation, so putting
   * research behind the gate that plan mode closes would make the read-only mode
   * the one that cannot look anything up. The bound is on *what* it can reach —
   * http and https only, size-capped, no `file:` — rather than on whether it may
   * reach it.
   */
  async web_fetch(ctx: ToolContext, args: { url: string; max_chars?: number }): Promise<string> {
    let page;
    try {
      page = await fetchPage(optionalString(args.url, "web_fetch", "url") ?? "", {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(args.max_chars === undefined ? {} : { maxChars: Math.max(1_000, countArg(args.max_chars, MAX_FILE_BYTES)) }),
      });
    } catch (err) {
      networkToolError(err);
    }
    const head =
      `${page.url}` +
      (page.status >= 400 ? ` — HTTP ${page.status}` : "") +
      (page.contentType ? ` (${page.contentType})` : "");
    if (!page.text) return `${head}\n${page.note ?? "the response was empty"}`;
    return `${head}${page.note ? `\n${page.note}` : ""}\n\n${page.text}`;
  },

  /**
   * Hand a self-contained piece of research to a sub-agent.
   *
   * The sub-agent reads, searches and reports back one summary. Its own tool
   * results — the forty files it opened to find the three that mattered — never
   * enter this conversation, and on a product where the context *is* the bill
   * that is the whole point: it is the only tool here that makes a task cheaper
   * rather than more expensive.
   *
   * It is read-only, deliberately. A sub-agent that could write would be a
   * second agent editing the same workspace with its own idea of the plan, and
   * the credits it saves do not pay for that.
   */
  async task(ctx: ToolContext, args: { description: string; prompt: string }): Promise<string> {
    const prompt = (optionalString(args.prompt, "task", "prompt") ?? "").trim();
    const description = (optionalString(args.description, "task", "description") ?? "").trim() || "subagent";
    if (!prompt) throw new ToolError("task needs a prompt describing what to find out");
    if (!ctx.spawn) {
      throw new ToolError(
        "sub-agents cannot start sub-agents — do this part of the work yourself with read_file, grep and glob",
      );
    }
    // `ctx.onOutput` is already bound to this call's id by the agent loop, so
    // the sub-agent's progress appears under the tool call that started it.
    return ctx.spawn(description, prompt, ctx.onOutput ? (line) => ctx.onOutput!(`${line}\n`) : undefined);
  },

  /**
   * Write the task list.
   *
   * Whole-list writes, never patches: the list is the plan, and a patch API is
   * how two copies of the plan start to disagree.
   */
  todo_write(ctx: ToolContext, args: { todos: unknown }): string {
    if (!ctx.todos) throw new ToolError("there is no task list in this run");
    let items;
    try {
      items = parseTodos(args.todos);
    } catch (err) {
      if (err instanceof TodoError) throw new ToolError(err.message);
      throw err;
    }
    ctx.todos.replace(items);
    return todoResult(items);
  },

  /**
   * Ask the user a question with named options.
   *
   * For the fork in the road that a wrong guess makes expensive — which of two
   * frameworks, whether to migrate the data — and not for confirmation, which
   * the permission dialog already is. The answer is a string, so the model may
   * be told something that was not on the list.
   */
  async ask_user(ctx: ToolContext, args: { question: string; options?: unknown }): Promise<string> {
    const question = (optionalString(args.question, "ask_user", "question") ?? "").trim();
    if (!question) throw new ToolError("ask_user needs a question");
    if (!ctx.askUser) {
      throw new ToolError(
        "there is nobody to ask in this run — state the assumption you are making and carry on",
      );
    }
    const options = parseAskOptions(args.options);
    if (options.length < 2) throw new ToolError("ask_user needs at least two options");
    const answer = await ctx.askUser({ question, options });
    return `The user chose: ${answer}`;
  },

  /**
   * The way out of plan mode — the thing plan mode did not have.
   *
   * It changes no files. Its whole job is to put the plan in front of the user
   * and report back what they chose, so the model can carry on **in the same
   * turn** rather than being told to ask for an approval nothing could grant.
   *
   * The mode switch itself is not done here: `approvePlan` is wired to the
   * permission state in the TUI, which owns the mode, and this tool only
   * reports the answer. Keeping the two apart is what stops a tool from being
   * able to grant itself write access.
   */
  async exit_plan_mode(ctx: ToolContext, args: { plan: string }): Promise<string> {
    const plan = (optionalString(args.plan, "exit_plan_mode", "plan") ?? "").trim();
    if (!plan) throw new ToolError("exit_plan_mode needs a plan");
    if (!ctx.approvePlan) {
      throw new ToolError(
        "there is no one to approve a plan in this run — present the plan as your answer instead",
      );
    }
    const decision = await ctx.approvePlan(plan);
    if (decision === "keepPlanning") {
      return "the user did not approve this plan. Stay read-only, ask what they would change, and call exit_plan_mode again when you have a plan they agree with.";
    }
    return (
      `the user approved the plan. Permission mode is now "${decision}"` +
      (decision === "acceptEdits"
        ? " — file edits apply without asking, shell commands are still put to them."
        : decision === "auto"
          ? " — edits and commands run without asking, and a command that looks risky is blocked."
          : " — each write and each command is put to them first.") +
      " Carry out the plan now."
    );
  },
};

export type ToolName = keyof typeof TOOLS;

/**
 * Key under which "always allow" is remembered for a shell command.
 *
 * The whole command, because that is what the dialog showed the user: they
 * approve what they read. Keying on the program name alone (as this once did)
 * meant answering "always" to `git status` silently also approved
 * `git push --force`, and one `rm build/tmp.txt` approved every future `rm`.
 * Whitespace is normalised so trivial reformatting still matches.
 */
export function commandSignature(command: string): string {
  return `run:${command.replace(/\s+/g, " ").trim()}`;
}

/** How many times `needle` occurs in `haystack` (non-overlapping). */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** One line saying what a background command is doing. */
function describeShell(s: ShellSnapshot): string {
  const age = `${Math.round(s.runningMs / 1000)}s`;
  if (s.status === "running") return `[${s.id}] running for ${age}: ${s.command}`;
  return `[${s.id}] ${s.status}${s.exitCode === null || s.exitCode === undefined ? "" : ` with code ${s.exitCode}`} after ${age}: ${s.command}`;
}

/** Validate the options `ask_user` was handed. */
function parseAskOptions(raw: unknown): { label: string; description?: string }[] {
  if (!Array.isArray(raw)) throw new ToolError("ask_user needs an options array");
  const out: { label: string; description?: string }[] = [];
  for (const item of raw.slice(0, MAX_ASK_OPTIONS)) {
    // A bare string is what a model reaches for first, and refusing it costs a
    // paid round-trip to learn a shape the question did not depend on.
    if (typeof item === "string") {
      if (item.trim()) out.push({ label: item.trim().slice(0, 80) });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const opt = item as { label?: unknown; description?: unknown };
    const label = typeof opt.label === "string" ? opt.label.trim() : "";
    if (!label) continue;
    out.push({
      label: label.slice(0, 80),
      ...(typeof opt.description === "string" && opt.description.trim()
        ? { description: opt.description.trim().slice(0, 200) }
        : {}),
    });
  }
  return out;
}

/**
 * Image formats we can put in a request, by magic bytes only.
 *
 * Never by extension, and that is the whole rule. The `mimeType` decided here
 * is the one sent to the provider, so guessing it from a filename means
 * labelling arbitrary bytes as a PNG and having the provider reject the entire
 * request — a failure a long way from its cause. Sniffing is also right in the
 * other direction: a screenshot saved as `paste.dat` is still a screenshot, and
 * a `.png` that is really a text file is read as the text it is.
 *
 * Four formats, because those are the four every vision model accepts. Anything
 * else lands on `isBinary`, which refuses it by name.
 */
function imageType(bytes: Buffer): string | undefined {
  const magic = (hex: string) => bytes.subarray(0, hex.length / 2).toString("hex") === hex.toLowerCase();
  if (magic("89504e47")) return "image/png";
  if (magic("ffd8ff")) return "image/jpeg";
  if (magic("47494638")) return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/**
 * Put an image in front of the model.
 *
 * It cannot go in the tool *result*: an OpenAI-compatible `tool` message carries
 * a string and nothing else, which is the format this whole stack speaks. So the
 * image travels as its own user message right after the results (`ctx.attach`),
 * and the tool returns the sentence that tells the model to look at it. Without
 * that sentence a model reads "attached" and describes the filename.
 */
function readImage(ctx: ToolContext, bytes: Buffer, name: string, mimeType: string): string {
  if (!ctx.attach) {
    throw new ToolError(
      `${name} is an image, and this run cannot show images to the model. ` +
        "Ask the user to describe it, or work from the surrounding code.",
    );
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ToolError(
      `${name} is ${(bytes.length / 1e6).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1e6} MB limit for an image. ` +
        "Ask the user for a smaller version, or crop it with a command.",
    );
  }
  ctx.attach({ mimeType, data: bytes.toString("base64"), label: name });
  return `${name} — ${mimeType}, ${bytes.length} bytes. The image itself follows this tool result; read it there.`;
}

/**
 * Whether a buffer is binary. A NUL byte is the classic test and is what `grep`
 * uses; the second clause catches UTF-16 and the odd binary that has no NUL in
 * its first page.
 */
function isBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8_000);
  if (head.includes(0)) return true;
  let control = 0;
  for (const b of head) {
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return head.length > 0 && control / head.length > 0.15;
}

/** Sleep that gives up when the turn is cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Call a tool an MCP server provides.
 *
 * Not a member of `TOOLS`, because its names are not known until a server has
 * been asked — but it is gated in exactly the same place and the same way as
 * every other side-effecting tool, which is the property that matters. We
 * advertise these without knowing what they do; `create_issue` is whatever the
 * server decides it is.
 */
export async function runMcpTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.mcp) throw new ToolError(`no MCP servers are connected, so ${name} cannot be called`);
  const found = ctx.mcp.find(name);
  const server = found?.server.name ?? name.split("__")[1] ?? "mcp";
  const summary = `${found?.tool.name ?? name} via the ${server} MCP server`;
  await gate(ctx, {
    tool: name,
    // Per tool, not per server: approving "read an issue" is not approving
    // "close every issue", and the two arrive from the same connection.
    signature: `mcp:${name}`,
    summary,
    preview: JSON.stringify(args, null, 2).slice(0, 4_000),
  });
  try {
    const result = await ctx.mcp.call(name, args, ctx.signal);
    for (const image of result.images) {
      ctx.attach?.({ mimeType: image.mimeType, data: image.data, label: `${summary} (image)` });
    }
    const shown = result.images.length && ctx.attach ? `${result.text}\n(the image follows this tool result)` : result.text;
    return shown || "(the tool returned nothing)";
  } catch (err) {
    if (err instanceof McpError) throw new ToolError(err.message);
    throw err;
  }
}

/** Spawn a shell command, streaming and capping its output. Never throws on a
 *  non-zero exit — the model gets the exit code and output and decides. */
function execute(ctx: ToolContext, command: string, timeout: number): Promise<string> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, {
        cwd: ctx.root,
        shell: true,
        windowsHide: true,
        // Own process group on POSIX so killTree can take the children with it.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      // `spawn` usually reports a failure through the `error` event below, but
      // some it raises **synchronously** — a command carrying a NUL byte is the
      // one a model can actually produce. Inside a Promise executor that
      // becomes a rejection, which is a fault, which ends the turn. It is the
      // same failure as any other command that would not start, so it gets the
      // same answer.
      return resolvePromise(`command failed to start: ${(err as Error).message}\n(no output)`);
    }

    let out = "";
    let total = 0;
    let timedOut = false;
    const collect = (buf: Buffer) => {
      const chunk = buf.toString("utf8");
      ctx.onOutput?.(chunk);
      // Count everything, keep only the first MAX_OUTPUT_CHARS. `total` is what
      // decides whether output was truncated: a boolean set on the *next* chunk
      // missed the case where one big chunk overshot the cap on its own, and the
      // model then read a silently shortened output as if it were complete.
      total += chunk.length;
      if (out.length < MAX_OUTPUT_CHARS) out += chunk;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const onAbort = () => killTree(child);
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    let settled = false;
    const finish = (summary: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      const body = out.slice(0, MAX_OUTPUT_CHARS).trimEnd();
      const note =
        total > MAX_OUTPUT_CHARS
          ? `\n… [output capped: showing ${MAX_OUTPUT_CHARS} of ${total} chars]`
          : "";
      resolvePromise(`${summary}\n${body || "(no output)"}${note}`);
    };

    child.on("error", (err) => finish(`command failed to start: ${err.message}`));
    child.on("close", (code) => {
      if (ctx.signal?.aborted) return finish("command cancelled by the user");
      if (timedOut) return finish(`command killed after ${timeout} ms`);
      finish(`exit ${code ?? 0}`);
    });
  });
}

/** Workspace files as relative paths — powers the REPL's `@file` completion. */
export function listWorkspaceFiles(root: string, limit = 5000): string[] {
  const files: string[] = [];
  walk(root, root, (abs) => {
    files.push(rel(root, abs));
    return files.length < limit;
  });
  return files.sort();
}

/**
 * Depth-first walk of `dir`, skipping noise directories. `visit` returns false
 * to stop.
 *
 * **`dir` may be a file, and then it is the one thing visited.** `glob` and
 * `grep` both take a `path`, and narrowing a search to a single file is the
 * most natural thing a model does with one — but `readdirSync` answers a file
 * with `ENOTDIR`, which the catch below read as "nothing here", so the tool
 * reported `no matches for hello` about a file whose first line was
 * `hello world`. A search tool's confident false negative is the worst answer
 * in this file: nothing retries it, and the model concludes the code does not
 * exist.
 *
 * Symlinked **files** are walked like any other file; symlinked
 * **directories** are not descended into. A linked file is a file somebody put
 * in the tree on purpose and was skipped entirely before (`isFile()` is false
 * for a symlink), while descending into a linked directory is how a
 * depth-first walk finds its way into a cycle.
 */
function walk(dir: string, root: string, visit: (abs: string) => boolean): void {
  if (isFilePath(dir)) {
    visit(dir);
    return;
  }
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const kind = entryKind(entry, abs);
      if (kind === "dir") {
        // A directory reached through a symlink is skipped rather than
        // descended: see the note above about cycles. Everything else is
        // decided by SKIP_DIRS alone — a name beginning with a dot is not a
        // reason on its own, which is what made `.github` unsearchable.
        if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (kind !== "file") continue;
      if (++seen > MAX_WALK_FILES) return;
      if (!visit(abs)) return;
    }
  }
  void root;
}

/**
 * Translate a glob to a RegExp over workspace-relative, forward-slashed paths.
 * Supports `**`, `*`, `?` and `{a,b}` — the subset agents actually emit.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = requireString(pattern, "glob", "pattern").replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  // How many `{…}` alternations are open, and nothing used to track it. Both
  // brace characters and the comma mean different things inside a group and
  // outside one, and treating them the same produced two distinct failures. A
  // `}` with no `{` in front of it emitted a bare `)`, which is not a regular
  // expression — so `new RegExp` threw a `SyntaxError` out of the tool, past
  // `executeToolCall`'s `ToolError` check, and out of the agent loop, ending
  // the whole turn over a typo the model would have fixed in one call. And a
  // comma outside a group is an ordinary character in a filename, so turning
  // it into `|` quietly made `glob("notes,old.txt")` search for two files that
  // do not exist and report neither.
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      re += "(?:";
      depth++;
    } else if (ch === "}" && depth > 0) {
      re += ")";
      depth--;
    } else if (ch === "," && depth > 0) re += "|";
    // `}` and `{` reach here only as literals, and both are escaped so the
    // result is valid with or without the `u` flag. A comma is not a regex
    // metacharacter and falls through to itself.
    else if (".+^$()[]|\\{}".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  // An unclosed `{` is the same typo from the other end, and shells read it the
  // same way — `a{b` is the literal text. Closing it beats an unterminated group.
  re += ")".repeat(depth);
  // A bare pattern like `*.ts` should match at any depth, as agents expect.
  const anchored = p.includes("/") ? `^${re}$` : `^(?:.*/)?${re}$`;
  try {
    return new RegExp(anchored);
  } catch (err) {
    // Unreachable with the braces balanced above, and kept anyway: what it
    // prevents is a turn ending on a raw `SyntaxError`, so a grammar hole
    // nobody has found yet should cost the model one corrected call rather
    // than the conversation.
    throw new ToolError(`not a usable glob pattern: ${pattern} — ${(err as Error).message}`);
  }
}

/**
 * The tools that only read. Everything plan mode is allowed to reach.
 *
 * Research is on this list on purpose. Plan mode is precisely when a model
 * needs to go and read the documentation before committing to an approach, and
 * a read-only mode that could not look anything up would be the mode in which
 * the agent guesses. `task` is here because a sub-agent inherits the mode it was
 * started in, so in plan mode it is read-only too; `todo_write` and `ask_user`
 * change nothing outside the conversation.
 */
const READ_ONLY_TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "task",
  "todo_write",
  "ask_user",
  "read_output",
] as const;

const EXIT_PLAN_MODE_SCHEMA = {
  type: "function",
  function: {
    name: "exit_plan_mode",
    description:
      "Present your plan to the user and ask them to approve leaving plan mode. Call this once you " +
      "know what you intend to do. Writes and commands stay unavailable until they approve; on " +
      "approval you continue in the same turn.",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan, in a few short lines of markdown." },
      },
      required: ["plan"],
    },
  },
} as const;

/**
 * What the model may call this round.
 *
 * In plan mode the write tools are **removed**, not merely refused. Refusal
 * alone meant the model reached for `write_file`, got an error back, and spent
 * another paid round-trip rewriting the same intent as prose. `decide()` still
 * refuses them as a backstop — a model can emit a call for a tool that was
 * never advertised — but on the ordinary path there is now nothing to refuse.
 *
 * Called per model call rather than per turn, because an approved plan changes
 * the mode in the middle of one and the write tools have to come back with it.
 *
 * MCP tools follow the write tools rather than the read ones: what a server's
 * tool does is its own business, `search_issues` may well be `create_issue`'s
 * neighbour, and a mode that promises to change nothing cannot make that promise
 * about somebody else's program.
 */
export function toolSchemaFor(
  mode: PermissionMode,
  mcpSchemas: readonly unknown[] = [],
  available: { webSearch?: boolean } = {},
): readonly unknown[] {
  // A gateway with no search key can only ever answer `web_search` with an
  // error, so advertising it is 106 input tokens of pure waste on *every* model
  // call, plus the round-trip the model spends discovering it. `web_fetch` is
  // unaffected — it needs no key and is the fallback the model is pointed at.
  const usable = (t: (typeof TOOL_SCHEMA)[number]) =>
    t.function.name !== "web_search" || available.webSearch === true;
  if (mode !== "plan") return [...TOOL_SCHEMA.filter(usable), ...mcpSchemas];
  return [
    ...TOOL_SCHEMA.filter((t) => (READ_ONLY_TOOLS as readonly string[]).includes(t.function.name)).filter(usable),
    EXIT_PLAN_MODE_SCHEMA,
  ];
}

/** Whether a tool name is one this build knows how to run. */
export function isKnownTool(name: string): boolean {
  return name in TOOLS || isMcpToolName(name);
}

/**
 * What a sub-agent may call.
 *
 * Read-only, and shorter than plan mode's list. It has no `task` (a sub-agent
 * spawning sub-agents is a fan-out nobody asked for), no `ask_user` (there is no
 * dialog wired to it and a question nobody can answer is a hung turn), no
 * `todo_write` (its list would be a second plan competing with the real one) and
 * no `exit_plan_mode` (it has no mode to leave).
 */
const SUBAGENT_TOOLS = ["read_file", "list_dir", "glob", "grep", "web_search", "web_fetch"] as const;

export function subagentToolSchema(available: { webSearch?: boolean } = {}): readonly unknown[] {
  return TOOL_SCHEMA.filter(
    (t) =>
      (SUBAGENT_TOOLS as readonly string[]).includes(t.function.name) &&
      (t.function.name !== "web_search" || available.webSearch === true),
  );
}

/** OpenAI-compatible tool schema advertised to the model. */
export const TOOL_SCHEMA = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Lines come back as '<number>\\t<text>'. The " +
        "numbers are for referring to places in the file and are NOT part of it — never include " +
        "them in edit_file arguments. Long files are cut off; read on with offset.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "First line to read, 1-based. Defaults to 1." },
          limit: { type: "number", description: "How many lines to read. Defaults to 2000." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a workspace path.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by glob pattern (e.g. 'src/**/*.ts', '*.json'). Use this to locate files instead of shell commands.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Directory to search in; defaults to the workspace root." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regular expression. Returns 'path:line: text'. Use this to find code instead of shell commands.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Directory to search in; defaults to the workspace root." },
          glob: { type: "string", description: "Only search files matching this glob." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact snippet in an existing file. Prefer this over write_file for changes to existing files. " +
        "old_string must match exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file, or overwrite one completely. Use edit_file for partial changes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace (build, test, git, etc.). Set background: true for " +
        "anything that does not exit on its own — dev servers, watchers, tailed logs — and read it " +
        "later with read_output; a foreground command is killed after its timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number", description: "Milliseconds before the command is killed. Foreground only." },
          background: {
            type: "boolean",
            description: "Start it and return immediately. Use for long-running processes.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_output",
      description:
        "Read what a background command has printed since you last read it. Returns only new output, " +
        "so polling a running server is cheap.",
      parameters: {
        type: "object",
        properties: {
          shell_id: { type: "string", description: "The id run_command returned, e.g. 'bash_1'." },
          filter: { type: "string", description: "Keep only lines matching this regular expression." },
        },
        required: ["shell_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_shell",
      description: "Stop a background command started by run_command.",
      parameters: {
        type: "object",
        properties: { shell_id: { type: "string" } },
        required: ["shell_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns titles, URLs and snippets — not page contents. Use it for anything " +
        "outside the workspace: current documentation, error messages, library versions, releases.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: `Results to return, 1-${MAX_SEARCH_RESULTS}. Defaults to ${DEFAULT_SEARCH_RESULTS}.` },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch one http(s) URL and read it as text. HTML becomes Markdown with its links kept, JSON is " +
        "formatted, and a PDF's text layer is extracted. Long pages are truncated.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          max_chars: { type: "number", description: "Cap on the text returned." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description:
        "Hand a self-contained piece of research to a sub-agent that reads, searches and reports back " +
        "one summary. Use it when finding the answer will take many file reads — the sub-agent's " +
        "reads stay out of this conversation. It cannot write files or run commands, and it cannot " +
        "ask you anything, so the prompt must be complete on its own and say exactly what to report.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Three or four words, shown to the user." },
          prompt: { type: "string", description: "The whole task, self-contained." },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Write the task list for work with several distinct steps. Send the whole list every time, " +
        "with exactly one item in_progress. Skip it for anything that is one or two steps.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user to choose between options, when guessing wrong would waste real work. Not for " +
        "confirmation — writes and commands are already put to them — and not for anything you can " +
        "answer by reading the workspace.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
  },
] as const;
