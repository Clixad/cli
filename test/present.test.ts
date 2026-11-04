/**
 * How a tool call reads in the transcript. The model's result is not touched;
 * these are the rows a person sees instead of it.
 */
import { describe, expect, it } from "vitest";
import { diffView, renderDiffRows } from "../src/diff.ts";
import { visibleLength } from "../src/banner.ts";
import { askWords, presentResult, toolHead } from "../src/tui/present.ts";
import { fitRow } from "../src/tui/views.tsx";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ok = (name: string, args: Record<string, unknown>, result: string) =>
  presentResult({ name, args, result, ok: true }, 60, "none");

describe("toolHead", () => {
  it("names what was done to what", () => {
    expect(toolHead("read_file", { path: "src/a.ts" })).toEqual({ verb: "Read", target: "src/a.ts" });
    expect(toolHead("edit_file", { path: "src/a.ts" })).toEqual({ verb: "Update", target: "src/a.ts" });
    expect(toolHead("run_command", { command: "npm\n test" })).toEqual({ verb: "Bash", target: "npm test" });
    expect(toolHead("grep", { pattern: "add", path: "src" }).target).toBe('pattern: "add", path: "src"');
    expect(toolHead("web_search", { query: "vitest" })).toEqual({ verb: "Web Search", target: '"vitest"' });
    expect(toolHead("todo_write", { todos: [] })).toEqual({ verb: "Update Todos", target: "" });
    expect(toolHead("mcp__github__search_issues", { q: "bug" })).toEqual({ verb: "github · search_issues", target: "bug" });
  });
});

describe("presentResult", () => {
  it("says how many lines a read returned, and keeps them for ctrl+o", () => {
    const shown = ok("read_file", { path: "a" }, "    1\tone\n    2\ttwo\n    3\tthree");
    expect(shown.line).toBe("Read 3 lines");
    expect(shown.body).toEqual([]);
    expect(shown.expand).toContain("three");
  });

  it("counts what a search found", () => {
    expect(ok("grep", {}, "a.ts:1: x\nb.ts:2: y").line).toBe("Found 2 matches");
    expect(ok("grep", {}, "no matches for zzz").line).toBe("no matches for zzz");
    expect(ok("glob", {}, "a.ts\nb.ts\nc.ts").line).toBe("Found 3 files");
  });

  it("drops `exit 0` and shows a command's output", () => {
    const shown = ok("run_command", {}, "exit 0\nl1\nl2\nl3\nl4\nl5\nl6");
    expect(shown.status).toBe("ok");
    expect(shown.line).toBe("l1");
    expect(shown.body).toEqual(["l2", "l3", "l4", "l5"]);
    expect(shown.more).toBe(1);
    expect(shown.expand).toBeDefined();
  });

  it("marks a command that failed as an error and shows the end of its output", () => {
    const shown = ok("run_command", {}, "exit 1\n" + Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n"));
    expect(shown.status).toBe("error");
    expect(shown.line).toBe("Exit code 1");
    expect(shown.body.at(-1)).toBe("line 9");
    expect(shown.body[0]).toBe("… 5 earlier lines");
  });

  it("says (No output) for a quiet command", () => {
    expect(ok("run_command", {}, "exit 0\n(no output)").line).toBe("(No output)");
  });

  it("puts the diff of an edit under it", () => {
    const view = diffView("src/a.ts", "a\nb\nc\n", "a\nB\nc\n");
    const shown = presentResult({ name: "edit_file", args: { path: "src/a.ts" }, result: "edited", ok: true, view }, 50, "none");
    expect(shown.line).toBe("Updated src/a.ts with 1 addition and 1 removal");
    expect(shown.body.map((r) => r.trimEnd())).toEqual(["  1   a", "  2 - b", "  2 + B", "  3   c"]);
    expect(shown.plain).toBe(true);
  });

  it("shows the first lines of a new file", () => {
    const view = diffView("n.ts", "", Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"), { created: true });
    const shown = presentResult({ name: "write_file", args: {}, result: "wrote", ok: true, view }, 50, "none");
    expect(shown.line).toBe("Wrote 12 lines to n.ts");
    expect(shown.body).toHaveLength(8);
    expect(shown.more).toBe(4);
    expect(shown.expand).toContain("l11");
  });

  it("lists the whole task list, never cut", () => {
    const todos = Array.from({ length: 9 }, (_, i) => ({ content: `step ${i}`, status: i < 3 ? "completed" : i === 3 ? "in_progress" : "pending" }));
    const shown = presentResult({ name: "todo_write", args: { todos }, result: "", ok: true }, 40, "none");
    expect(shown.line).toBe("3/9 done");
    expect(shown.body).toHaveLength(9);
    expect(plain(shown.body[3]!)).toBe("◐ step 3");
    expect(shown.more).toBe(0);
  });

  it("says a refusal in the user's words, capitalised", () => {
    const shown = presentResult({ name: "edit_file", args: {}, result: "error: x", ok: false, display: "denied by you" }, 40);
    expect(shown).toMatchObject({ status: "denied", line: "Denied by you" });
  });

  it("shows a tool error's first line as the result", () => {
    const shown = presentResult({ name: "read_file", args: {}, result: "error: not found: x.ts", ok: false }, 40);
    expect(shown).toMatchObject({ status: "error", line: "not found: x.ts" });
  });

  it("fits every row to the width it was made for", () => {
    const long = "y".repeat(200);
    const shown = ok("run_command", {}, `exit 0\n${long}\n${long}`);
    for (const row of [shown.line, ...shown.body]) expect(visibleLength(row)).toBeLessThanOrEqual(60);
  });
});

describe("renderDiffRows", () => {
  it("makes every changed row exactly the width, so a background reaches the edge", () => {
    const view = diffView("a", "x\n", "y — 中文 wide\n");
    const { rows } = renderDiffRows(view, 30, { tint: "truecolor", measure: visibleLength, cut: (s, c) => fitRow(s, c) });
    for (const row of rows) expect(visibleLength(row)).toBe(30);
  });

  it("cuts a long line rather than wrapping it", () => {
    const view = diffView("a", "x\n", `${"z".repeat(100)}\n`);
    const { rows } = renderDiffRows(view, 20, { tint: "basic", measure: visibleLength, cut: (s, c) => fitRow(s, c) });
    for (const row of rows) expect(visibleLength(row)).toBeLessThanOrEqual(20);
  });

  it("says how many rows it did not draw", () => {
    const view = diffView("a", "", Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), { created: true });
    const drawn = renderDiffRows(view, 40, { maxRows: 10, tint: "none", measure: visibleLength, cut: (s, c) => fitRow(s, c) });
    expect(drawn.rows).toHaveLength(10);
    expect(drawn.more).toBe(20);
  });

  it("uses no escape codes at all under NO_COLOR", () => {
    const view = diffView("a", "x\n", "y\n");
    const { rows } = renderDiffRows(view, 20, { tint: "none", measure: visibleLength, cut: (s, c) => fitRow(s, c) });
    for (const row of rows) expect(row).not.toContain("\x1b");
  });
});

describe("askWords", () => {
  it("asks about the file by its name", () => {
    expect(askWords({ tool: "edit_file", summary: "edit src/a.ts", path: "src/a.ts" })).toMatchObject({
      title: "Edit file",
      target: "src/a.ts",
      question: "Do you want to make this edit to a.ts?",
    });
    expect(askWords({ tool: "write_file", summary: "create n.ts", path: "n.ts" }).title).toBe("Create file");
    expect(askWords({ tool: "run_command", summary: "run npm test" }).question).toBe("Do you want to run this command?");
  });
});
