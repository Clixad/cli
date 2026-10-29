/**
 * The two clips that keep the bottom of the screen inside the terminal.
 *
 * Ink redraws its non-static region by erasing the rows it last wrote. The
 * moment that region is taller than the viewport it cannot, and falls back to
 * clearing the screen and replaying every static line it has ever emitted —
 * which is what stacked half-drawn input boxes up the screen, and, running once
 * per streamed token, what made the output arrive in lurches. Both helpers
 * therefore measure in *rendered* rows, not in newlines: one streamed paragraph
 * is a single line that wraps to thirty rows.
 */
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { headRows, lineCount, tailRows } from "../src/tui/views.tsx";
import { visibleLength } from "../src/banner.ts";

describe("tailRows / headRows", () => {
  it("counts wrapped rows, not newlines", () => {
    const paragraph = "x".repeat(300); // one line, six rows at 50 columns
    expect(lineCount(paragraph, 50)).toBe(6);
    expect(lineCount(tailRows(paragraph, 50, 3), 50)).toBeLessThanOrEqual(3);
    expect(lineCount(headRows(paragraph, 50, 3), 50)).toBeLessThanOrEqual(3);
  });

  it("cuts the line that does not fit rather than dropping it", () => {
    // The trap the first version fell into: the only content is one line taller
    // than the budget, so "skip what doesn't fit" renders an empty screen.
    const out = tailRows("y".repeat(500), 40, 2);
    expect(out).not.toBe("");
    expect(lineCount(out, 40)).toBeLessThanOrEqual(2);
  });

  it("keeps the end for streamed text and the start for a diff", () => {
    const block = ["one", "two", "three", "four"].join("\n");
    expect(tailRows(block, 80, 2)).toBe("three\nfour"); // read at the bottom
    expect(headRows(block, 80, 2)).toBe("one\ntwo"); // which file, not which hunk
  });

  it("never exceeds the budget, whatever the shape of the text", () => {
    const shapes = [
      "",
      "\n\n\n",
      "short",
      "a".repeat(1000),
      ["a".repeat(90), "b", "", "c".repeat(240)].join("\n"),
    ];
    for (const text of shapes) {
      for (const max of [0, 1, 3, 12]) {
        for (const cols of [40, 80, 200]) {
          expect(lineCount(tailRows(text, cols, max), cols)).toBeLessThanOrEqual(Math.max(1, max));
          expect(lineCount(headRows(text, cols, max), cols)).toBeLessThanOrEqual(Math.max(1, max));
        }
      }
    }
  });

  it("returns nothing at all for a budget of zero", () => {
    expect(tailRows("anything", 80, 0)).toBe("");
    expect(headRows("anything", 80, 0)).toBe("");
  });
});

/**
 * The measurement underneath both clips, which used to count UTF-16 code units.
 *
 * That is the right answer only for ASCII, and undercounting is the direction
 * that breaks the screen: the clip then keeps more rows than fit, the bottom
 * region grows past the viewport, and ink clears the terminal and replays the
 * whole session. A model writing `✅` and `❌` was enough to do it.
 *
 * Pinned against `string-width`, which is what ink's own `wrap-ansi` and
 * `widest-line` use to decide where the terminal actually wraps — so this
 * asserts that our arithmetic and ink's layout cannot disagree.
 */
describe("column measurement", () => {
  const samples = [
    "plain ascii",
    "这是一个中文的句子", // fullwidth: one code unit, two columns each
    "日本語のテキスト",
    "✅ done", // East Asian Wide, one code unit, two columns
    "❌ failed",
    "🚀 ship it", // astral: two code units, two columns
    "👨‍👩‍👧 family", // ZWJ: eight code units, two columns
    "🇩🇪 Deutschland", // regional indicators: four code units, two columns
    "école", // a combining mark adds a code unit and no column
    "─".repeat(10),
    "🐤 working…",
  ];

  it("agrees with the library ink lays out against", () => {
    for (const sample of samples) expect(visibleLength(sample)).toBe(stringWidth(sample));
  });

  it("ignores ANSI, so a coloured line is measured by its text", () => {
    expect(visibleLength("\u001b[31mred\u001b[0m")).toBe(3);
    expect(visibleLength("\u001b[38;2;245;184;65m▀\u001b[0m")).toBe(1);
  });

  it("counts a fullwidth paragraph as the rows it really takes", () => {
    const paragraph = "中文".repeat(60); // 120 code units, 240 columns
    expect(lineCount(paragraph, 80)).toBe(3); // was 2 — and the frame overflowed
  });

  it("keeps the clips inside the budget for non-ASCII too", () => {
    const shapes = [
      "中文".repeat(200),
      ["✅ " + "a".repeat(120), "❌ " + "б".repeat(90), "🚀".repeat(50)].join("\n"),
      "👨‍👩‍👧".repeat(40),
    ];
    for (const text of shapes) {
      for (const max of [1, 3, 12]) {
        for (const cols of [40, 80, 200]) {
          expect(lineCount(tailRows(text, cols, max), cols)).toBeLessThanOrEqual(max);
          expect(lineCount(headRows(text, cols, max), cols)).toBeLessThanOrEqual(max);
        }
      }
    }
  });
});

/**
 * A clipped line must not leave a colour open.
 *
 * The cut used to be `String.prototype.slice`, which counts escape bytes as
 * text — so a coloured diff line clipped to eighty columns kept seventy-five
 * characters and spent five on a `\u001b[31m` — and which cuts wherever the
 * index lands, dropping the closing reset so the colour bled down the frame
 * into the hint row and the input box under it.
 */
describe("clipping a coloured line", () => {
  const RED = "\u001b[31m";
  const RESET = "\u001b[0m";

  it("keeps the columns it budgeted for, not fewer", () => {
    const line = RED + "x".repeat(200) + RESET;
    // Two rows of forty columns: eighty columns of text, all of it visible.
    // The old cut counted the five bytes of `\u001b[31m` as text and kept 75.
    expect(headRows(line, 40, 2).split("\n").map(visibleLength)).toEqual([40, 40]);
    expect(tailRows(line, 40, 2).split("\n").map(visibleLength)).toEqual([40, 40]);
  });

  it("closes the style on every row it produced", () => {
    for (const clipped of [headRows(RED + "x".repeat(200) + RESET, 40, 2), tailRows(RED + "x".repeat(200) + RESET, 40, 2)]) {
      for (const row of clipped.split("\n")) {
        expect(row).toMatch(/^\u001b\[31m/); // the colour survived the cut
        expect(row).toMatch(/\u001b\[(?:0|39|49)m$/); // and is closed on this row
      }
    }
  });

  it("never splits a double-width character down the middle", () => {
    // An odd budget cannot hold half of a two-column glyph, so the clip has to
    // stop one column short rather than emit half a character.
    const clipped = headRows("中".repeat(50), 9, 1);
    expect(visibleLength(clipped)).toBe(8);
    expect(clipped).toBe("中".repeat(4));
  });

  it("measures a paragraph the way ink wraps it, not by dividing its width", () => {
    // Greedy word wrap wastes up to one word per row, so a block can need more
    // rows than `ceil(width / cols)` — and one uncounted row is enough to push
    // the bottom region to exactly the viewport height, which ink reads as
    // fullscreen and answers by clearing the terminal on the next frame.
    const words = "alpha bravo charlie delta echo foxtrot golf hotel ".repeat(12);
    const wrapped = lineCount(words, 37);
    expect(wrapped).toBeGreaterThan(Math.ceil(visibleLength(words) / 37));
    // And the clip respects the real number.
    expect(lineCount(tailRows(words, 37, 4), 37)).toBe(4);
    expect(lineCount(headRows(words, 37, 4), 37)).toBe(4);
  });
});
