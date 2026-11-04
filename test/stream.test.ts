/**
 * A streamed answer goes to the scrollback a line at a time. What has to hold:
 * nothing is committed before its line is finished, a table and the line that
 * opens a code fence wait, blank lines at the end wait for what follows them,
 * and an answer committed in pieces renders exactly as the whole answer would.
 */
import { describe, expect, it } from "vitest";
import { renderMarkdownState, type MdState } from "../src/tui/markdown.ts";
import { splitStable, trimLeadingBlankLines } from "../src/tui/stream.ts";

/** Feed `text` in chunks of `size`, committing as the TUI does, and return the pieces. */
function stream(text: string, size: number): { pieces: Array<{ text: string; state: MdState }>; rest: string } {
  const pieces: Array<{ text: string; state: MdState }> = [];
  let state: MdState = {};
  let pending = "";
  for (let i = 0; i < text.length; i += size) {
    pending += text.slice(i, i + size);
    const split = splitStable(pending, state);
    if (split.lines > 0) {
      pieces.push({ text: split.stable, state });
      state = renderMarkdownState(split.stable, Number.POSITIVE_INFINITY, state).state;
    }
    pending = split.rest;
  }
  if (pending.trim()) pieces.push({ text: pending.replace(/\s+$/, ""), state });
  return { pieces, rest: pending };
}

const ANSWER = [
  "## Summary",
  "",
  "The bug was in `src/math.ts`: **add** returned `a - b`.",
  "",
  "- Changed line 12",
  "- Ran the tests, all 8 pass",
  "",
  "```ts",
  "export function add(a: number, b: number) {",
  "  /* the fix */",
  "",
  "  return a + b;",
  "}",
  "```",
  "",
  "| file | change |",
  "|---|---|",
  "| src/math.ts | +1 -1 |",
  "",
  "Let me know if you want a test for it.",
].join("\n");

describe("splitStable", () => {
  it("commits nothing before a line is finished", () => {
    expect(splitStable("half a line", {})).toEqual({ stable: "", lines: 0, rest: "half a line" });
  });

  it("commits finished lines and keeps the one being written", () => {
    const split = splitStable("one\ntwo\nthr", {});
    expect(split.stable).toBe("one\ntwo");
    expect(split.rest).toBe("thr");
  });

  it("keeps blank lines at the end for whatever follows them", () => {
    const split = splitStable("para\n\n\nnext", {});
    expect(split.stable).toBe("para");
    expect(split.rest).toBe("\n\nnext");
  });

  it("holds a table until a line that is not a row arrives", () => {
    expect(splitStable("intro\n| a | b |\n|---|---|\n| 1 | 2 |\n", {}).stable).toBe("intro");
    expect(splitStable("| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n", {}).stable).toContain("| 1 | 2 |");
  });

  it("holds the line that opens a fence, so the blank line above goes with the code", () => {
    const split = splitStable("text\n\n```ts\n", {});
    expect(split.stable).toBe("text");
    expect(split.rest).toBe("\n```ts\n");
  });

  it("commits code a line at a time, blank lines and pipes included", () => {
    const state: MdState = { fence: { lang: "sh", marker: "```", hl: {} } };
    const split = splitStable("ls | wc -l\n\necho hi\n", state);
    expect(split.stable).toBe("ls | wc -l\n\necho hi");
    expect(split.lines).toBe(3);
  });
});

describe("an answer committed in pieces", () => {
  for (const size of [1, 3, 7, 40, 2000]) {
    it(`renders as the whole answer does, at ${size} characters a delta`, () => {
      const { pieces } = stream(ANSWER, size);
      const whole = renderMarkdownState(ANSWER, 60, {}).text;
      const joined = pieces
        .map((p) => renderMarkdownState(p.text, 60, p.state).text)
        .filter((t) => t !== "")
        .join("\n");
      expect(joined).toBe(whole);
    });
  }

  it("drops blank lines at the start, where the answer's marker goes", () => {
    expect(trimLeadingBlankLines("\n \n\nhello\n")).toBe("hello\n");
  });
});
