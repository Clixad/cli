/**
 * The answer renderer. The layout counts rows, so the property that matters
 * most is that every line it returns is one row at the width it was given;
 * the rest is that the constructs models actually write come out readable.
 */
import { describe, expect, it } from "vitest";
import { visibleLength } from "../src/banner.ts";
import { renderMarkdown, renderMarkdownState } from "../src/tui/markdown.ts";
import { lineCount } from "../src/tui/views.tsx";

const plainText = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const rows = (s: string) => plainText(s).split("\n");

const SAMPLE = [
  "# Heading with `code`",
  "",
  "A paragraph long enough to wrap several times at forty columns, with **bold**, *italic*, ~~gone~~ and a [link](https://example.com/a_b_c).",
  "",
  "- a bullet that is also long enough to wrap onto a second row at this width",
  "  - a nested one",
  "1. first",
  "10. tenth, which needs a wider hanging indent than the first one does",
  "- [ ] open task",
  "- [x] done task",
  "> a quote",
  "---",
  "```ts",
  "const x = 1; // a comment that runs past the edge of a narrow terminal for sure",
  "```",
  "| name | value |",
  "|:---|---:|",
  "| a | 1 |",
  "| bb | 22 |",
].join("\n");

describe("renderMarkdown", () => {
  for (const cols of [100, 60, 40, 24]) {
    it(`returns one terminal row per line at ${cols} columns`, () => {
      const out = renderMarkdown(SAMPLE, cols);
      for (const row of out.split("\n")) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      // What ink would wrap it to is exactly what it already is.
      expect(lineCount(out, cols)).toBe(out.split("\n").length);
    });
  }

  it("hangs a wrapped list item under its own text", () => {
    const out = rows(renderMarkdown("- a bullet that is long enough to wrap onto a second row here", 30));
    expect(out[0]!.startsWith("• ")).toBe(true);
    expect(out[1]!.startsWith("  ")).toBe(true);
    expect(out[1]!.trimStart()).not.toBe("");
  });

  it("numbers ordered lists as written and indents their continuation past the number", () => {
    const out = rows(renderMarkdown("10. tenth item that wraps onto another row at this width", 28));
    expect(out[0]).toMatch(/^10\. tenth/);
    expect(out[1]!.startsWith("    ")).toBe(true);
  });

  it("draws task lists as boxes", () => {
    const out = rows(renderMarkdown("- [ ] open\n- [x] done"));
    expect(out).toEqual(["☐ open", "☒ done"]);
  });

  it("draws a table with rules when it fits, aligned as the separator says", () => {
    const out = rows(renderMarkdown("| name | value |\n|:---|---:|\n| a | 1 |\n| bb | 22 |", 60));
    expect(out[0]).toBe("┌──────┬───────┐");
    expect(out[1]).toBe("│ name │ value │");
    expect(out[3]).toBe("│ a    │     1 │");
    expect(out[5]).toBe("└──────┴───────┘");
  });

  it("lists a table's rows instead when it is wider than the terminal", () => {
    const wide = "| one | two |\n|---|---|\n| " + "x".repeat(50) + " | " + "y".repeat(50) + " |";
    const out = rows(renderMarkdown(wide, 40));
    expect(out[0]).toMatch(/^• one: x+/);
    expect(out.some((r) => r.startsWith("  two:"))).toBe(true);
    for (const row of out) expect(row.length).toBeLessThanOrEqual(40);
  });

  it("drops the fence lines and keeps the code, set in from the text", () => {
    const out = rows(renderMarkdown("before\n\n```js\nlet a = 1;\n```\n\nafter"));
    expect(out).toEqual(["before", "", "  let a = 1;", "", "after"]);
  });

  it("colours code by its language", () => {
    const out = renderMarkdown("```ts\nconst x = \"s\"; // c\n```");
    expect(out).toContain("\x1b[38;2;255;123;114mconst");
    expect(out).toContain("\x1b[38;2;165;214;255m\"s\"");
  });

  it("keeps an underscore in a URL and in snake_case out of italics", () => {
    const out = plainText(renderMarkdown("see [docs](https://x.dev/a_b_c) for snake_case_name"));
    expect(out).toBe("see docs (https://x.dev/a_b_c) for snake_case_name");
  });

  it("carries an open fence from one piece to the next", () => {
    const first = renderMarkdownState("```py\ns = '''open", 80, {});
    expect(first.state.fence?.lang).toBe("py");
    expect(first.state.fence?.hl.open?.kind).toBe("string");
    const second = renderMarkdownState("still a string'''\n```\nprose", 80, first.state);
    expect(second.state).toEqual({});
    expect(rows(second.text)).toEqual(["  still a string'''", "prose"]);
  });

  it("collapses runs of blank lines and leaves none at the end", () => {
    expect(rows(renderMarkdown("a\n\n\n\nb\n\n"))).toEqual(["a", "", "b"]);
  });
});
