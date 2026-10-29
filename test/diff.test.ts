/** The edit preview: what the user sees before approving a write. */
import { describe, expect, it } from "vitest";
import { diffLines, diffStat, renderDiff, splitLines } from "../src/diff.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("diff", () => {
  it("finds a single changed line and leaves the rest as context", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    const lines = diffLines(splitLines(before), splitLines(after));
    expect(diffStat(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.filter((l) => l.kind === "ctx").map((l) => l.text)).toEqual(["a", "c"]);
  });

  it("handles pure insertions and deletions", () => {
    expect(diffStat(diffLines(["a"], ["a", "b"]))).toEqual({ added: 1, removed: 0 });
    expect(diffStat(diffLines(["a", "b"], ["a"]))).toEqual({ added: 0, removed: 1 });
    expect(diffStat(diffLines([], ["a", "b"]))).toEqual({ added: 2, removed: 0 });
  });

  it("renders +/- lines with numbers and a stat header", () => {
    const out = strip(renderDiff("const a = 1;\n", "const a = 2;\n"));
    expect(out.split("\n")[0]).toBe("+1 -1");
    expect(out).toContain("- const a = 1;");
    expect(out).toContain("+ const a = 2;");
    expect(out).toMatch(/\s+1 [+-]/); // line numbers are shown
  });

  it("returns nothing when the content is unchanged", () => {
    expect(renderDiff("same\n", "same\n")).toBe("");
  });

  it("collapses untouched regions and caps very large diffs", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 30", "line thirty");
    const out = strip(renderDiff(before, after, { context: 2 }));
    expect(out).toContain("unchanged line");
    expect(out).toContain("+ line thirty");
    expect(out.split("\n").length).toBeLessThan(15);

    const huge = strip(renderDiff("", Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n"), { maxLines: 10 }));
    expect(huge).toContain("more changed line");
    expect(huge.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("treats a trailing newline as the end of the last line, not an empty one", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(renderDiff("a\nb\n", "a\nb")).toBe("");
  });
});
