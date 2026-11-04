/**
 * How a tool call looks in the transcript, kept apart from what the model is
 * told.
 *
 * A tool's result is written for the model: `read_file` hands back the file
 * with line numbers, `run_command` leads with `exit 0`, an edit says
 * `edited x (1 occurrence)`. Printed as it stands, the person watching read
 * the first four lines of every file the agent opened and never saw the lines
 * an edit changed. This turns each call into what a person needs: a title
 * that says what was done to what (`Update(src/app.ts)`), one line saying how
 * it went (`Updated src/app.ts with 2 additions and 1 removal`), and a body
 * only where the body is the point (a diff, a command's output, the task
 * list). Nothing here changes what the model receives.
 */
import { diffTint, renderDiffRows, type DiffTint, type DiffView } from "../diff.ts";
import { visibleLength } from "../banner.ts";
import { fitRow } from "./views.tsx";

export interface ToolHead {
  /** What was done: `Read`, `Update`, `Bash`. */
  verb: string;
  /** What it was done to, shown in parentheses; empty for none. */
  target: string;
}

export type ToolStatus = "ok" | "error" | "denied";

export interface Presented {
  status: ToolStatus;
  /** The row after `⎿`. */
  line: string;
  /** Rows under it, each one terminal row at the width it was made for. */
  body: string[];
  /** Rows of the body that were not shown. */
  more: number;
  /** The body carries its own colours (a diff, the task list) and is not dimmed. */
  plain: boolean;
  /** What ctrl+o shows, when there is more to see than the transcript shows. */
  expand?: string;
}

/** Rows of output a finished tool keeps in the transcript. */
export const OUTPUT_ROWS = 4;
/** Rows of a diff kept in the transcript; the rest is one ctrl+o away. */
export const DIFF_ROWS = 16;
/** Rows of a new file's first lines. */
const CREATED_ROWS = 8;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const nonEmpty = (s: string) => s.split("\n").filter((l) => l.trim() !== "");

export function toolHead(name: string, args: Record<string, unknown>): ToolHead {
  switch (name) {
    case "read_file": {
      const from = typeof args.offset === "number" ? args.offset : undefined;
      const count = typeof args.limit === "number" ? args.limit : undefined;
      const range = from || count ? ` · lines ${from ?? 1}${count ? `-${(from ?? 1) + count - 1}` : "+"}` : "";
      return { verb: "Read", target: str(args.path) + range };
    }
    case "write_file":
      return { verb: "Write", target: str(args.path) };
    case "edit_file":
      return { verb: "Update", target: str(args.path) };
    case "list_dir":
      return { verb: "List", target: str(args.path) || "." };
    case "glob":
      return { verb: "Glob", target: str(args.pattern) };
    case "grep":
      return {
        verb: "Search",
        target: `pattern: "${str(args.pattern)}"${args.path ? `, path: "${str(args.path)}"` : ""}`,
      };
    case "run_command":
      return { verb: "Bash", target: oneLine(str(args.command)) + (args.background === true ? " · background" : "") };
    case "!":
      return { verb: "Bash", target: oneLine(str(args.command)) };
    case "read_output":
      return { verb: "BashOutput", target: str(args.shell_id) };
    case "kill_shell":
      return { verb: "KillShell", target: str(args.shell_id) };
    case "web_search":
      return { verb: "Web Search", target: `"${str(args.query)}"` };
    case "web_fetch":
      return { verb: "Fetch", target: str(args.url) };
    case "task":
      return { verb: "Task", target: str(args.description) };
    case "todo_write":
      return { verb: "Update Todos", target: "" };
    case "ask_user":
      return { verb: "Ask", target: str(args.question) };
    case "exit_plan_mode":
      return { verb: "Plan", target: "" };
    default:
      // An MCP tool names its server, which is the part the user needs: two
      // servers can both offer `search`, and only one of them is reading their
      // private issue tracker.
      if (name.startsWith("mcp__")) {
        const [server = "", ...tool] = name.split("__").slice(1);
        return { verb: `${server} · ${tool.join("__")}`, target: firstValue(args) };
      }
      return { verb: name, target: firstValue(args) };
  }
}

function firstValue(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return "";
}

/** `Update(src/app.ts)`, fitted to one row; the verb is what a reader scans for. */
export function headText(head: ToolHead, cols: number): { verb: string; target: string } {
  const verb = fitRow(head.verb, Math.max(1, cols));
  if (!head.target) return { verb, target: "" };
  const room = cols - visibleLength(verb) - 2;
  if (room < 4) return { verb, target: "" };
  return { verb, target: `(${fitRow(head.target, room)})` };
}

export interface ResultInput {
  name: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  /** A permission refusal's sentence for the user. */
  display?: string | undefined;
  view?: DiffView | undefined;
  /** What a web search was charged, already worded (` · 1,069 credits`). */
  charge?: string | undefined;
}

/**
 * The outcome of one call, at `width` columns: the width of the body, which
 * sits five columns in from the dot.
 */
export function presentResult(input: ResultInput, width: number, tint: DiffTint = diffTint()): Presented {
  const w = Math.max(10, width);
  const fit = (s: string) => fitRow(s, w);
  const rows = (lines: string[], max = OUTPUT_ROWS) => ({
    body: lines.slice(0, max).map(fit),
    more: Math.max(0, lines.length - max),
  });
  const { name, args, result, ok } = input;

  if (input.display !== undefined) {
    const said = input.display.trim();
    return { status: "denied", line: fit(said.charAt(0).toUpperCase() + said.slice(1)), body: [], more: 0, plain: false };
  }
  if (!ok) {
    const lines = nonEmpty(result.replace(/^error:\s*/, ""));
    const { body, more } = rows(lines.slice(1));
    return {
      status: "error",
      line: fit(lines[0] ?? "failed"),
      body,
      more,
      plain: false,
      ...(more > 0 ? { expand: result } : {}),
    };
  }

  switch (name) {
    case "read_file": {
      const numbered = result.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
      if (numbered === 0) return simple(fit(nonEmpty(result)[0] ?? "Read nothing"));
      const range = /showing lines (\d+)-(\d+) of (\d+)/.exec(result);
      // What was read stays one ctrl+o away, for anybody who wants to see what
      // the model saw.
      return expandable(
        fit(range ? `Read lines ${range[1]}-${range[2]} of ${range[3]}` : `Read ${plural(numbered, "line")}`),
        result,
      );
    }

    case "list_dir": {
      const n = nonEmpty(result).filter((l) => !l.startsWith("…")).length;
      return expandable(fit(`Listed ${plural(n, "entry", "entries")}`), result);
    }

    case "glob": {
      if (/^no files match/.test(result)) return simple(fit(result.trim()));
      const n = nonEmpty(result).filter((l) => !l.startsWith("…")).length;
      return expandable(fit(`Found ${plural(n, "file")}`), result);
    }

    case "grep": {
      if (/^no matches for/.test(result)) return simple(fit(result.trim()));
      const n = nonEmpty(result).filter((l) => !l.startsWith("…")).length;
      const capped = /\[capped at/.test(result) ? "+" : "";
      return expandable(fit(`Found ${n.toLocaleString("en-US")}${capped} ${n === 1 && !capped ? "match" : "matches"}`), result);
    }

    case "edit_file":
    case "write_file": {
      const view = input.view;
      if (!view) return simple(fit(nonEmpty(result)[0] ?? "done"));
      const measure = { measure: visibleLength, cut: (s: string, c: number) => fitRow(s, c), tint };
      if (view.created) {
        const asContext: DiffView = { ...view, rows: view.rows.map((r) => (r.kind === "add" ? { ...r, kind: "ctx" } : r)) };
        const shown = renderDiffRows(asContext, w, { ...measure, maxRows: CREATED_ROWS });
        const lines = view.added;
        return {
          status: "ok",
          line: fit(`Wrote ${plural(lines, "line")} to ${view.path}`),
          body: shown.rows,
          more: Math.max(0, lines - shown.rows.length),
          plain: false,
          ...(lines > shown.rows.length ? { expand: renderDiffRows(asContext, w, measure).rows.join("\n") } : {}),
        };
      }
      const what =
        view.added + view.removed === 0
          ? `No changes to ${view.path}`
          : `Updated ${view.path} with ${plural(view.added, "addition")} and ${plural(view.removed, "removal")}`;
      const shown = renderDiffRows(view, w, { ...measure, maxRows: DIFF_ROWS });
      return {
        status: "ok",
        line: fit(what),
        body: shown.rows,
        more: shown.more,
        plain: true,
        ...(shown.more > 0 ? { expand: renderDiffRows(view, w, measure).rows.join("\n") } : {}),
      };
    }

    case "run_command":
    case "!":
      return command(result, fit, rows);

    case "read_output": {
      const [notes = "", ...rest] = result.split("\n\n");
      const out = nonEmpty(rest.join("\n\n")).filter((l) => l !== "(nothing new since the last read)");
      const { body, more } = rows(out);
      const failed = /\] (exited with code (?!0\b)\d+|failed|killed)/.test(notes);
      return {
        status: failed ? "error" : "ok",
        line: fit(nonEmpty(notes)[0] ?? "read"),
        body,
        more,
        plain: false,
        ...(more > 0 ? { expand: result } : {}),
      };
    }

    case "web_search": {
      const found = /^(\d+) result\(s\)/.exec(result);
      const line = found
        ? `Found ${plural(Number(found[1]), "result")}`
        : /^no results for/.test(result)
          ? "No results"
          : (nonEmpty(result)[0] ?? "searched");
      return found
        ? expandable(fit(line + (input.charge ?? "")), result)
        : simple(fit(line + (input.charge ?? "")));
    }

    case "web_fetch": {
      const head = nonEmpty(result)[0] ?? "";
      const status = / — HTTP (\d{3})/.exec(head);
      const body = result.slice(result.indexOf("\n\n") + 2);
      const kb = (body.length / 1024).toFixed(1);
      return status
        ? { status: "error", line: fit(`HTTP ${status[1]}`), body: [], more: 0, plain: false, expand: result }
        : expandable(fit(`Received ${kb} KB`), result);
    }

    case "todo_write":
      return todos(args, fit, w);

    case "ask_user":
      return simple(fit(result.replace(/^The user chose: /, "Answered: ")));

    default: {
      const lines = nonEmpty(result);
      const { body, more } = rows(lines.slice(1));
      return {
        status: "ok",
        line: fit(lines[0] ?? "done"),
        body,
        more,
        plain: false,
        ...(more > 0 ? { expand: result } : {}),
      };
    }
  }
}

function simple(line: string): Presented {
  return { status: "ok", line, body: [], more: 0, plain: false };
}

/** A summary line whose detail is one ctrl+o away. */
function expandable(line: string, full: string): Presented {
  return { status: "ok", line, body: [], more: 0, plain: false, expand: full };
}

function command(
  result: string,
  fit: (s: string) => string,
  rows: (lines: string[], max?: number) => { body: string[]; more: number },
): Presented {
  const [head = "", ...rest] = result.split("\n");
  if (head.startsWith("Started in the background as ")) {
    const id = /as ([\w-]+)\./.exec(head)?.[1] ?? "";
    return simple(fit(`Running in the background${id ? ` as ${id}` : ""}`));
  }
  const out = rest.filter((l) => l.trim() !== "" && l !== "(no output)");
  const exit = /^exit (-?\d+)$/.exec(head);
  const code = exit ? Number(exit[1]) : undefined;
  if (code === 0) {
    const { body, more } = rows(out.slice(1));
    return {
      status: "ok",
      line: fit(out[0] ?? "(No output)"),
      body,
      more,
      plain: false,
      ...(more > 0 ? { expand: out.join("\n") } : {}),
    };
  }
  // A failure: the code first, then the output's *end*, which is where a
  // compiler or a test runner says what went wrong.
  const line = code !== undefined ? `Exit code ${code}` : head;
  const shown = out.slice(-OUTPUT_ROWS);
  const more = out.length - shown.length;
  return {
    status: "error",
    line: fit(line),
    body: [...(more > 0 ? [fit(`… ${plural(more, "earlier line")}`)] : []), ...shown.map(fit)],
    more: 0,
    plain: false,
    ...(more > 0 ? { expand: out.join("\n") } : {}),
  };
}

const TODO_GLYPH: Record<string, string> = {
  completed: "\x1b[2m☒ ",
  in_progress: "\x1b[1m\x1b[38;2;245;184;65m◐ ",
  pending: "☐ ",
};

function todos(args: Record<string, unknown>, fit: (s: string) => string, width: number): Presented {
  const items = Array.isArray(args.todos)
    ? (args.todos as Array<{ content?: unknown; status?: unknown }>).filter((t) => typeof t?.content === "string")
    : [];
  const done = items.filter((t) => t.status === "completed").length;
  const body = items.map((t) => {
    const status = typeof t.status === "string" && t.status in TODO_GLYPH ? t.status : "pending";
    const text = oneLine(String(t.content));
    const strike = status === "completed" ? `\x1b[9m${text}\x1b[29m` : text;
    // The glyph and its space take two of the row's columns.
    return `${TODO_GLYPH[status]}${fitRow(strike, Math.max(1, width - 2))}\x1b[0m`;
  });
  return {
    status: "ok",
    line: fit(items.length ? `${done}/${items.length} done` : "the list is empty"),
    body,
    more: 0,
    plain: true,
  };
}

/** What the permission dialog says about one request, by the tool that made it. */
export interface AskWords {
  /** The dialog's first row: `Edit file`, `Run command`. */
  title: string;
  /** The file it is about, when it is about one; a command is its own preview. */
  target?: string;
  question: string;
  /** The second answer: yes, and do not ask again for the same thing this session. */
  always: string;
}

export function askWords(req: { tool: string; summary: string; path?: string | undefined }): AskWords {
  const path = req.path ?? "";
  const base = path.split("/").pop() || path;
  switch (req.tool) {
    case "edit_file":
      return {
        title: "Edit file",
        target: path,
        question: `Do you want to make this edit to ${base}?`,
        always: `Yes, and don't ask again for ${base} this session`,
      };
    case "write_file": {
      const creating = req.summary.startsWith("create");
      return {
        title: creating ? "Create file" : "Overwrite file",
        target: path,
        question: creating ? `Do you want to create ${base}?` : `Do you want to overwrite ${base}?`,
        always: `Yes, and don't ask again for ${base} this session`,
      };
    }
    case "run_command":
      return {
        title: req.summary.startsWith("run in the background") ? "Run in the background" : "Run command",
        question: "Do you want to run this command?",
        always: "Yes, and don't ask again for this command this session",
      };
    case "kill_shell":
      return {
        title: "Stop a background command",
        target: req.summary.replace(/^stop background command\s*/, ""),
        question: "Do you want to stop it?",
        always: "Yes, and don't ask again for it this session",
      };
    default:
      return {
        title: req.summary.charAt(0).toUpperCase() + req.summary.slice(1),
        question: "Do you want to allow this?",
        always: "Yes, and don't ask again for this tool this session",
      };
  }
}
