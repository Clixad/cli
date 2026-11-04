/**
 * Which part of a streaming answer can be written to the scrollback now.
 *
 * An answer used to live in the redrawn region at the bottom of the screen
 * until the model finished: raw markdown, clipped to the rows that were left,
 * so the beginning of a long answer was gone from the screen and not yet in the
 * scrollback. When it ended, the whole rendered answer was written at once, a
 * jump and a reformat in the same frame.
 *
 * Now every complete line is committed as it arrives, and only the line still
 * being written stays at the bottom. The renderer is line by line and carries
 * its state (`renderMarkdownState`), so a line can go as soon as its newline
 * has. Three things wait:
 *
 * - **Blank lines at the end** go out with whatever follows them, so a chunk
 *   never ends on a blank row and the last chunk of an answer does not leave a
 *   gap under it.
 * - **A code fence that has only just opened** waits for its first line, so
 *   the blank line above it is drawn with the code it separates.
 * - **A table** waits until a line that is not a table row arrives, because its
 *   columns are sized from every row. Any line with a `|` in it outside a code
 *   fence is held for that reason: prose with a pipe in it is late by one line,
 *   a table committed a row at a time would be drawn with different widths on
 *   every row.
 */
import { fenceCloses, fenceOpen, type MdState } from "./markdown.ts";

export interface StableSplit {
  /** Complete lines that may be committed, joined without their final newline. */
  stable: string;
  /** How many lines `stable` holds (a blank line of code is a line, and an empty string). */
  lines: number;
  /** Everything after them, still being written or held back. */
  rest: string;
}

export function splitStable(text: string, state: MdState): StableSplit {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { stable: "", lines: 0, rest: text };

  const complete = text.slice(0, lastNewline).split("\n");
  const tail = text.slice(lastNewline + 1);

  // Whether each complete line sits inside a code fence, where neither rule
  // below applies: a blank line or a `|` in code is code.
  const inFence: boolean[] = [];
  let marker = state.fence?.marker;
  for (const line of complete) {
    if (marker) {
      inFence.push(true);
      if (fenceCloses(line, marker)) marker = undefined;
      continue;
    }
    inFence.push(false);
    const open = fenceOpen(line);
    if (open) marker = open.marker;
  }

  let cut = complete.length;
  for (;;) {
    const k = cut - 1;
    if (k < 0 || inFence[k]) break;
    const line = complete[k]!;
    // A fence that has only just opened draws nothing yet, and would strand the
    // blank line before it at the end of a piece that is gone from the screen.
    if (line.trim() === "" || line.includes("|") || fenceOpen(line)) {
      cut = k;
      continue;
    }
    break;
  }

  if (cut === 0) return { stable: "", lines: 0, rest: text };
  const kept = complete.slice(cut);
  return {
    stable: complete.slice(0, cut).join("\n"),
    lines: cut,
    rest: kept.map((line) => `${line}\n`).join("") + tail,
  };
}

/** Blank lines at the start of an answer, which would otherwise carry its marker. */
export function trimLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "");
}
