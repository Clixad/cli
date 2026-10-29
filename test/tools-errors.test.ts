/**
 * What the file tools do when the filesystem says no, and when they are asked
 * a question whose honest answer is "not here".
 *
 * Two failure shapes, one root. `asToolError` states the agent loop's contract
 * — a `ToolError` is something the model works around, anything else is a fault
 * that ends the turn — and the file tools kept neither half of it.
 *
 * They **crashed**: `list_dir` on a path that turned out to be a file, or on a
 * directory holding one dangling symlink, `read_file` on a file this process
 * cannot read, `write_file`/`edit_file` onto a directory or into a directory
 * they cannot write, and `glob`/`grep` on a pattern with an unbalanced brace.
 * Each raised a raw `ENOTDIR`/`ENOENT`/`EACCES`/`EISDIR`/`SyntaxError` straight
 * past `executeToolCall`, ending the turn after its round trip had been paid
 * for and without the model ever seeing what it could have corrected.
 *
 * And they **lied**: `glob` and `grep` skipped every directory whose name began
 * with a dot, so `.github/workflows/ci.yml` could not be found by any pattern
 * while `list_dir` went on showing `.github/`; they skipped symlinked files
 * entirely; they answered "no matches" for a `path` that was a file rather than
 * searching it, and for a `path` that did not exist at all. A confident false
 * negative from a search tool is the worst answer in this codebase: nothing
 * retries it, and the model concludes the code is not there.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, ToolError, globToRegExp, type ToolContext } from "../src/tools.ts";
import { runAgent, type AgentClient } from "../src/agent.ts";
import type { ChatTurn } from "../src/client.ts";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adg-tool-errors-"));
  ctx = { root };
  writeFileSync(join(root, "a.txt"), "hello world\n");
  mkdirSync(join(root, "dir1"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: ci\non: push\n");
  symlinkSync(join(root, "a.txt"), join(root, "linked.txt"));
  symlinkSync(join(root, "nothing-here"), join(root, "dir1", "broken-link"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Whether chmod actually bites here — it does not for root, or on Windows. */
function chmodBites(path: string): boolean {
  if (process.platform === "win32") return false;
  chmodSync(path, 0o000);
  try {
    readFileSync(path);
    return false;
  } catch {
    return true;
  }
}

describe("a filesystem refusal reaches the model instead of ending the turn", () => {
  it("list_dir on a file says which tool to use instead", () => {
    expect(() => TOOLS.list_dir(ctx, { path: "a.txt" })).toThrow(ToolError);
    expect(() => TOOLS.list_dir(ctx, { path: "a.txt" })).toThrow(/is a file — use read_file/);
  });

  it("list_dir lists a directory holding a dangling symlink", () => {
    // Every `node_modules/.bin` has some; `statSync` follows them, and one
    // ENOENT used to take the whole turn with it.
    expect(TOOLS.list_dir(ctx, { path: "dir1" })).toBe("broken-link");
  });

  it("list_dir on an unreadable directory is a ToolError", () => {
    const locked = join(root, "locked-dir");
    mkdirSync(locked);
    if (!chmodBites(locked)) return; // running as root, or on Windows
    try {
      expect(() => TOOLS.list_dir(ctx, { path: "locked-dir" })).toThrow(ToolError);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("read_file on an unreadable file is a ToolError", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "x");
    if (!chmodBites(secret)) return;
    try {
      expect(() => TOOLS.read_file(ctx, { path: "secret.txt" })).toThrow(ToolError);
    } finally {
      chmodSync(secret, 0o644);
    }
  });

  it("write_file and edit_file onto a directory are ToolErrors", async () => {
    await expect(TOOLS.write_file(ctx, { path: "dir1", content: "x" })).rejects.toThrow(ToolError);
    await expect(
      TOOLS.edit_file(ctx, { path: "dir1", old_string: "a", new_string: "b" }),
    ).rejects.toThrow(ToolError);
  });

  it("write_file into an unwritable directory is a ToolError", async () => {
    const locked = join(root, "ro");
    mkdirSync(locked);
    if (process.platform === "win32") return;
    chmodSync(locked, 0o500);
    try {
      await expect(TOOLS.write_file(ctx, { path: "ro/x.txt", content: "y" })).rejects.toThrow(ToolError);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("a glob pattern the model got slightly wrong", () => {
  it("compiles rather than throwing a SyntaxError", () => {
    // `**/*.{ts,tsx}}` — one brace too many, and the whole turn used to die on it.
    for (const pattern of ["**/*.{ts,tsx}}", "src/{a", "a}", "}{"]) {
      expect(() => globToRegExp(pattern)).not.toThrow();
    }
    expect(globToRegExp("**/*.{ts,tsx}}").test("src/app.tsx}")).toBe(true);
    expect(() => TOOLS.glob(ctx, { pattern: "a}" })).not.toThrow();
    expect(() => TOOLS.grep(ctx, { pattern: "x", glob: "a}" })).not.toThrow();
  });

  it("still reads a balanced pattern the way it always did", () => {
    expect(globToRegExp("**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.{ts,tsx}").test("src/app.tsx")).toBe(true);
    expect(globToRegExp("{src,test}/*.ts").test("test/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
  });

  it("treats a comma outside a group as part of the filename", () => {
    // It used to become `|`, so this searched for two files that do not exist
    // and reported neither.
    expect(globToRegExp("notes,old.txt").test("notes,old.txt")).toBe(true);
    expect(globToRegExp("notes,old.txt").test("old.txt")).toBe(false);
  });
});

describe("glob and grep answer honestly about what is in the tree", () => {
  it("finds files inside a dot-directory", () => {
    expect(TOOLS.glob(ctx, { pattern: "**/*.yml" })).toContain(".github/workflows/ci.yml");
    expect(TOOLS.glob(ctx, { pattern: ".github/**/*.yml" })).toContain(".github/workflows/ci.yml");
    expect(TOOLS.grep(ctx, { pattern: "name: ci" })).toContain(".github/workflows/ci.yml");
  });

  it("still skips the build and dependency caches", () => {
    for (const noise of ["node_modules", ".git", "dist", ".venv", "__pycache__"]) {
      mkdirSync(join(root, noise), { recursive: true });
      writeFileSync(join(root, noise, "noise.yml"), "name: ci\n");
    }
    const hits = TOOLS.glob(ctx, { pattern: "**/*.yml" });
    for (const noise of ["node_modules", ".git", "dist", ".venv", "__pycache__"]) {
      expect(hits).not.toContain(`${noise}/noise.yml`);
    }
    expect(hits).toContain(".github/workflows/ci.yml");
  });

  it("sees a symlinked file", () => {
    expect(TOOLS.glob(ctx, { pattern: "*.txt" })).toContain("linked.txt");
    expect(TOOLS.grep(ctx, { pattern: "hello" })).toContain("linked.txt");
  });

  it("searches a path that is a single file", () => {
    // "no matches for hello", about a file whose first line is `hello world`.
    expect(TOOLS.grep(ctx, { pattern: "hello", path: "a.txt" })).toBe("a.txt:1: hello world");
    expect(TOOLS.glob(ctx, { pattern: "a.txt", path: "a.txt" })).toBe("a.txt");
  });

  it("says a path is missing rather than reporting no matches", () => {
    expect(() => TOOLS.grep(ctx, { pattern: "x", path: "nosuchdir" })).toThrow(/not found/);
    expect(() => TOOLS.glob(ctx, { pattern: "*", path: "nosuchdir" })).toThrow(/not found/);
  });

  it("does not walk into a dangling symlink's directory forever", () => {
    // The dangling link is a file-shaped entry that resolves to nothing; grep
    // must simply skip it.
    expect(TOOLS.grep(ctx, { pattern: "hello", path: "." })).toContain("a.txt:1: hello world");
  });
});

describe("read_file with a count it cannot read", () => {
  it("falls back to the default instead of returning nothing", () => {
    // `Math.floor("x")` is NaN, which slipped past the past-the-end guard and
    // made `read_file` answer a readable file with an empty string.
    expect(TOOLS.read_file(ctx, { path: "a.txt", offset: "x" as unknown as number })).toContain("hello world");
    expect(TOOLS.read_file(ctx, { path: "a.txt", limit: "abc" as unknown as number })).toContain("hello world");
  });

  it("still honours a count that is readable, string or number", () => {
    expect(TOOLS.read_file(ctx, { path: "a.txt", offset: 1 })).toContain("hello world");
    expect(TOOLS.read_file(ctx, { path: "a.txt", offset: "2" as unknown as number })).toContain("past the end");
  });
});

describe("an argument that is not the type the signature claims", () => {
  /**
   * Tool arguments are `JSON.parse` of whatever the model wrote, so
   * `args: { path: string }` is a compile-time claim about a runtime value that
   * nothing checked. `path: 0`, `path: null` and `content: {}` all reached
   * `readFileSync` or `.trim()` and raised a raw `TypeError` out of the agent
   * loop — the same turn-ending fault as an unhandled `ENOTDIR`, and invisible
   * to the model in exactly the same way.
   */
  it("is named rather than thrown past the loop", async () => {
    await expect(TOOLS.write_file(ctx, { path: {} as unknown as string, content: "x" })).rejects.toThrow(
      /path must be a string, got an object/,
    );
    expect(() => TOOLS.read_file(ctx, { path: null as unknown as string })).toThrow(
      /path must be a string, got null/,
    );
    expect(() => TOOLS.glob(ctx, { pattern: [] as unknown as string })).toThrow(/an array/);
  });

  it("takes a number where a string was meant, because a file can be called 3", () => {
    writeFileSync(join(root, "3"), "three\n");
    expect(TOOLS.read_file(ctx, { path: 3 as unknown as string })).toContain("three");
  });

  it("falls back rather than breaking on a count it cannot read", async () => {
    // `setTimeout(fn, "abc")` coerces to 1 ms, so a non-numeric timeout used to
    // kill the command before it had started.
    const out = await TOOLS.run_command(ctx, {
      command: "echo still-here",
      timeout: "abc" as unknown as number,
    });
    expect(out).toContain("still-here");
  });

  it("survives a command spawn() refuses synchronously", async () => {
    // A NUL byte makes `spawn` throw rather than emit `error`, and inside a
    // Promise executor that is a rejection, which is a fault.
    const out = await TOOLS.run_command(ctx, { command: "echo \u0000" });
    expect(out).toMatch(/failed to start/);
    await expect(
      TOOLS.run_command(ctx, { command: "echo \u0000", background: true }),
    ).rejects.toThrow(ToolError);
  });

  /**
   * The invariant itself, swept rather than sampled: whatever the model sends,
   * a tool answers with a `ToolError` the model can act on, never a fault that
   * ends the turn. Only an abort and a paywall are allowed past — see
   * `passesThrough`.
   */
  it("holds for every tool against every shape of nonsense", async () => {
    const weird: unknown[] = [undefined, null, "", 0, -1, 1.5, NaN, Infinity, true, {}, [], "\u0000"];
    const escapes: string[] = [];
    for (const w of weird) {
      const attempts: [string, () => unknown][] = [
        ["read_file.path", () => TOOLS.read_file(ctx, { path: w as string })],
        ["read_file.offset", () => TOOLS.read_file(ctx, { path: "a.txt", offset: w as number })],
        ["read_file.limit", () => TOOLS.read_file(ctx, { path: "a.txt", limit: w as number })],
        ["list_dir.path", () => TOOLS.list_dir(ctx, { path: w as string })],
        ["glob.pattern", () => TOOLS.glob(ctx, { pattern: w as string })],
        ["glob.path", () => TOOLS.glob(ctx, { pattern: "*", path: w as string })],
        ["grep.pattern", () => TOOLS.grep(ctx, { pattern: w as string })],
        ["grep.glob", () => TOOLS.grep(ctx, { pattern: "x", glob: w as string })],
        ["grep.path", () => TOOLS.grep(ctx, { pattern: "x", path: w as string })],
        ["write_file.path", () => TOOLS.write_file(ctx, { path: w as string, content: "x" })],
        ["write_file.content", () => TOOLS.write_file(ctx, { path: "out.txt", content: w as string })],
        ["edit_file.path", () => TOOLS.edit_file(ctx, { path: w as string, old_string: "hello", new_string: "z" })],
        ["edit_file.old_string", () => TOOLS.edit_file(ctx, { path: "a.txt", old_string: w as string, new_string: "z" })],
        ["read_output.shell_id", () => TOOLS.read_output(ctx, { shell_id: w as string })],
        ["read_output.filter", () => TOOLS.read_output(ctx, { shell_id: "bash_1", filter: w as string })],
        ["kill_shell.shell_id", () => TOOLS.kill_shell(ctx, { shell_id: w as string })],
        ["web_search.query", () => TOOLS.web_search(ctx, { query: w as string })],
        ["web_fetch.url", () => TOOLS.web_fetch(ctx, { url: w as string })],
        ["task.prompt", () => TOOLS.task(ctx, { description: "d", prompt: w as string })],
        ["todo_write.todos", () => TOOLS.todo_write(ctx, { todos: w })],
        ["ask_user.options", () => TOOLS.ask_user(ctx, { question: "q?", options: w })],
        ["exit_plan_mode.plan", () => TOOLS.exit_plan_mode(ctx, { plan: w as string })],
        ["run_command.command", () => TOOLS.run_command(ctx, { command: w as string })],
      ];
      for (const [label, run] of attempts) {
        try {
          await run();
        } catch (err) {
          const e = err as Error;
          if (!(e instanceof ToolError)) escapes.push(`${label}=${JSON.stringify(w)} -> ${e.constructor.name}: ${e.message}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });
});

/** A model that makes one tool call, then answers. */
function scripted(name: string, args: Record<string, unknown>): AgentClient {
  let n = 0;
  return {
    async chatStream(): Promise<ChatTurn> {
      n++;
      if (n === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 1,
        };
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
    },
  };
}

describe("none of it reaches the agent loop as a fault", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["glob", { pattern: "**/*.{ts,tsx}}" }],
    ["grep", { pattern: "x", glob: "a}" }],
    ["list_dir", { path: "a.txt" }],
    ["list_dir", { path: "dir1" }],
    ["write_file", { path: "dir1", content: "x" }],
    ["edit_file", { path: "dir1", old_string: "a", new_string: "b" }],
    ["read_file", { path: "a.txt", offset: "x" }],
  ];

  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args)} finishes the turn`, async () => {
      const res = await runAgent(scripted(name, args), "go", { model: "m", root });
      expect(res.content).toBe("ok");
      expect(res.steps).toBe(2);
    });
  }
});
