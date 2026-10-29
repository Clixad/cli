/**
 * How one committed turn is drawn, and how tall it ends up. Both live here on
 * purpose: `app.tsx` pushes the input box to the bottom of the screen by
 * measuring everything above it, so a renderer that changes its height without
 * telling the maths would make the box drift.
 */
import React from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import { sliceColumns, visibleLength } from "../banner.ts";
import { renderMarkdown } from "./markdown.ts";
import type { PermissionMode } from "../permissions.ts";

export const MANGO = "#f5b841";
export const MANGO_BRIGHT = "#ffcf6b";
/** Dim body text — the status line and every "this is chrome" row. */
export const SLATE = "#8b98ae";

/**
 * The one accent every advertisement wears, and the darker one its mark wears.
 *
 * **One accent for all of them, never one per advertiser.** A network line is
 * somebody else's copy, and letting it bring its own colour would let it choose
 * how loud it is on a screen that is not its own. Fixed here, it reads as "this
 * row is an ad" rather than as "this row is Acme".
 *
 * The ordering is the design, and it is an ordering in **luminance**: the mark
 * is darker than the ad copy, and the ad copy is no brighter than `SLATE`,
 * which is what our own chrome uses. Advertising should be recognisable, not
 * the brightest thing on the screen — the mango belongs to what the user is
 * doing, and the mode colours belong to what the agent is allowed to do.
 *
 * Where the two constraints were taken literally they left the mark at 2.7:1
 * against a dark terminal, which is below any readable threshold and the wrong
 * answer for the one element on the row that exists to be noticed *first*.
 * These values keep the same ordering and lift the mark over 3:1: measured
 * against `#0a1430`, `AD_MARK` is 3.3:1 and `AD_TEXT` 5.0:1, against `SLATE`'s
 * 6.2:1. The disclosure is allowed to be quiet; it is not allowed to be
 * invisible.
 */
export const AD_TEXT = "#8a80b4";
export const AD_MARK = "#6b6390";

/**
 * A colour and a glyph per permission mode.
 *
 * The mode is the one thing under the box that changes what the agent is
 * *allowed to do*, and it used to be a grey clause among five other grey
 * clauses — so shift+tab moved it and nothing on screen looked different. Each
 * mode now owns a colour, so the switch is visible at a glance rather than
 * read: green means edits land on their own, blue means nothing is written at
 * all, pink means nothing is asked at all, and the default asks first and
 * stays quiet about it. Pink because it is the one hue nothing else on this
 * screen uses: not the mango of the user's own text, not an error's red, and
 * not the violet of a sponsored line.
 *
 * Colours only live here, never in `permissions.ts`: that module is the policy,
 * and a policy with hex codes in it is a policy that a renderer has to agree
 * with. `MODE_LABEL` is still its, so the words and the rules move together.
 */
export const MODE_STYLE: Record<PermissionMode, { color: string; glyph: string }> = {
  normal: { color: SLATE, glyph: "⏵" },
  acceptEdits: { color: "#7ee787", glyph: "⏵⏵" },
  plan: { color: "#79c0ff", glyph: "⏸" },
  auto: { color: "#f778ba", glyph: "⏵⏵⏵" },
};

export type Entry =
  | { id: number; kind: "banner"; text: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; meta?: string }
  | {
      id: number;
      kind: "tool";
      /** e.g. "edit_file" */
      name: string;
      /** e.g. "src/tui/app.tsx" */
      summary: string;
      /** Already-truncated preview of the result. */
      output?: string;
      /** How many further lines were dropped from `output`. */
      outputMore?: number;
      ok?: boolean;
    }
  | { id: number; kind: "notice"; text: string; tone?: "warn" | "error" | "good" };

/** Omit that distributes over the union (plain Omit would drop the extras). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEntry = DistributiveOmit<Entry, "id">;

/**
 * How ink wraps a `<Text>`, and therefore the only honest way to measure one.
 *
 * These are ink's own options: `render-node-to-output.js` hands every text node
 * to `wrapText`, which is `wrapAnsi(text, width, { trim: false, hard: true })`.
 * That is **word** wrapping with a hard fallback for words longer than the
 * width — not a hard cut at `cols`, which is what the arithmetic here used to
 * assume.
 *
 * The difference is not academic. Greedy word wrap wastes up to one word per
 * row, so a paragraph of `width` columns can need more than `ceil(width/cols)`
 * rows — one more is enough. At 80x20 the bottom region is budgeted to 19 rows;
 * one uncounted row makes it 20, which is exactly `viewportRows`, which makes
 * ink call the frame fullscreen — and the next, shorter frame then trips
 * `isLeavingFullscreen` and clears the terminal. Streaming an answer that way
 * cleared and replayed the whole session every other frame.
 *
 * Wrapping is idempotent at a fixed width — every row it produces is already
 * within the width — so a clipped block can be handed straight back to ink
 * without reflowing differently than it was measured.
 */
const WRAP_LIKE_INK = { trim: false, hard: true } as const;

function wrapRows(text: string, cols: number): string[] {
  return wrapAnsi(text, Math.max(1, cols), WRAP_LIKE_INK).split("\n");
}

/** Rendered height of a block of text at a given width (wrapping included). */
export function lineCount(text: string, cols: number): number {
  return wrapRows(text, cols).length;
}

/**
 * The last `max` *rendered* rows of a block — wrapping counted, not newlines.
 *
 * This is the difference between a bottom region that fits the terminal and one
 * that doesn't. Ink redraws the non-static region by erasing the rows it last
 * wrote; the moment that region is taller than the viewport it can't, and it
 * falls back to clearing the screen and replaying *every* committed line it has
 * ever emitted (`shouldClearTerminalForFrame` in ink's `ink.js`). That is what
 * produced the half-drawn input boxes stacked up the screen, and — because the
 * replay happens on every token — the stutter that came with them.
 *
 * Counting `\n`s is not enough to prevent it: one streamed paragraph is a single
 * line that wraps to thirty rows, so a cap of "20 lines" is a cap of nothing.
 */
export function tailRows(text: string, cols: number, max: number): string {
  if (max <= 0) return "";
  const rows = wrapRows(text, cols);
  // Already inside the budget: hand back exactly what came in. Re-emitting the
  // wrapped form would be the same on screen but is a needless rewrite of text
  // the caller may compare against.
  if (rows.length <= max) return text;
  // Taking wrapped rows is what makes the clip exact: the unit is a row of the
  // terminal, not a line of the source, so one streamed paragraph forty rows
  // tall is cut to its last few rows rather than dropped whole (which rendered
  // a long answer as an empty screen) or cut by a character count that has
  // nothing to do with where the terminal breaks. `wrapAnsi` re-opens the
  // styles that were live at each break and closes them at the end of the row,
  // so a slice out of the middle cannot leave a colour bleeding down the frame.
  return rows.slice(-max).join("\n");
}

/**
 * `tailRows`, from the other end.
 *
 * Which end survives the clip is a content decision, not a layout one: streamed
 * text is read at the bottom, so it keeps its tail, while a diff about to be
 * approved is read from the top — the last hunk of a long patch matters less
 * than knowing which file is being changed.
 */
/**
 * Force a string onto exactly one terminal row.
 *
 * The layout hands out the bottom region in rows, and several of the things it
 * counts as "one row" are built by concatenation — a status line, a picker
 * entry, a queued message — so nothing stops them being wider than the terminal
 * and wrapping into two. One uncounted row moves the input box for as long as
 * the condition lasts, and enough of them push the whole region past the
 * viewport, which is what makes ink clear the screen and replay the session.
 *
 * Measured and cut in **columns**, so a CJK or emoji clause cannot slip past,
 * and ANSI-aware, so cutting through a colour does not leave it open for
 * whatever is drawn underneath. The ellipsis is inside the budget.
 */
export function fitRow(text: string, cols: number): string {
  const width = Math.max(0, cols);
  if (width === 0) return "";
  if (visibleLength(text) <= width) return text;
  if (width === 1) return "…";
  return `${sliceColumns(text, width - 1)}…`;
}

/**
 * The widest phrasing of a hint that still fits on one row.
 *
 * `fitRow` is the wrong tool for a row of keyboard shortcuts: it cuts the tail,
 * and the tail is where `esc` lives. A dialog that says
 * `[y/⏎] once · [a] always · [n] no · es…` has truncated away the only key that
 * gets the user out of it. So each hint is written at two or three lengths and
 * the widest that fits is used; the last is a floor short enough for any
 * terminal worth drawing in, and `fitRow` backs even that up.
 */
export function pickHint(variants: readonly string[], cols: number): string {
  for (const variant of variants) if (visibleLength(variant) <= cols) return variant;
  return fitRow(variants[variants.length - 1] ?? "", cols);
}

/** Pad to `width` **columns** — `padEnd` pads by code units, which is not the same. */
export function padColumns(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

/**
 * The width available *inside* a bordered dialog.
 *
 * Every modal in `app.tsx` is a `<Box borderStyle="round" paddingX={1}>`, which
 * spends one column on each border and one on each pad. Measuring their content
 * at the full terminal width — which the budget used to do — counts a line of
 * `cols - 3` columns as one row and renders it as two.
 */
export const DIALOG_CHROME_COLS = 4;
export function dialogInner(cols: number): number {
  return Math.max(1, cols - DIALOG_CHROME_COLS);
}

export function headRows(text: string, cols: number, max: number): string {
  if (max <= 0) return "";
  const rows = wrapRows(text, cols);
  if (rows.length <= max) return text;
  return rows.slice(0, max).join("\n");
}

/** Lines an error notice may hold, and characters it may hold in all. */
const ERROR_NOTICE_ROWS = 12;
const ERROR_NOTICE_CHARS = 2_400;

/**
 * An error message, bounded before it is ever handed to a renderer.
 *
 * The messages this REPL prints come from everywhere — the gateway, an MCP
 * server somebody else wrote, a filesystem call, a `fetch` against whatever the
 * gateway URL currently resolves to — and one of them turned out to be an HTML
 * error page from a WAF, several kilobytes of it, printed verbatim. That is not
 * merely ugly: ink redraws the bottom region by erasing the rows it last wrote,
 * and the moment that region is taller than the viewport it gives up and clears
 * the terminal, replaying every static line of the session. The scrollback and
 * the render go together.
 *
 * The source of that particular body is fixed in `edge.ts`, which is the real
 * repair. This is the structural half: no error message, from any source
 * present or future, can exceed the frame no matter who wrote it. Bounded in
 * both directions because either one alone is enough to do it — a thousand
 * short lines, or one line of a hundred thousand characters.
 *
 * Escape sequences are stripped for the same reason `safeDetail` strips them:
 * an ANSI escape from somewhere else is not text, it is an instruction to the
 * terminal that we would be carrying out on its author's behalf.
 *
 * **The width bound is on the whole notice, never on one line** (2026-10-12).
 * It was 200 characters a line, and the gateway's refusal at the daily limit
 * on bonus credits was one line of nearly 400: people read "Credits you earn on
 * the of…" and never reached what to do about it. A long line wraps in the
 * scrollback like any other, which is where a notice is written (`<Static>`),
 * and 2,400 characters in all is the bound the old one amounted to (12 lines
 * of 200), so the worst case is no taller than it was.
 *
 * `indent` starts every line after the first, so a sentence the gateway sent
 * as several lines lines up under the caller's own prefix.
 */
export function errorNotice(message: string, rows = ERROR_NOTICE_ROWS, indent = ""): string {
  const clean = message
    // Whole sequences, not just the ESC: dropping the escape on its own leaves
    // its parameter bytes behind as literal text, so a cleared-screen sequence
    // is defused into a stray "[2J" in the middle of the message.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, " ")
    // Every control character except the newline, which is the only one that
    // means anything here — the row budget below is what bounds those.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
  const lines = clean.split("\n");
  const kept: string[] = [];
  let left = ERROR_NOTICE_CHARS;
  for (const line of lines.slice(0, rows)) {
    if (line.length > left) {
      kept.push(`${line.slice(0, Math.max(0, left - 1))}…`);
      break;
    }
    kept.push(line);
    left -= line.length;
  }
  if (lines.length > kept.length) kept.push(`… +${lines.length - kept.length} more lines`);
  return kept.join(`\n${indent}`);
}

export function entryHeight(entry: Entry, cols: number): number {
  const margin = entry.kind === "banner" ? 0 : 1; // the banner has no marginTop
  switch (entry.kind) {
    case "assistant":
      return margin + lineCount(renderMarkdown(entry.text), cols) + (entry.meta ? 1 : 0);
    case "tool":
      return (
        margin +
        1 +
        (entry.output ? lineCount(entry.output, cols - 4) : 0) +
        (entry.outputMore ? 1 : 0)
      );
    default:
      return margin + lineCount(entry.text, cols);
  }
}

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "banner":
      return <Text>{entry.text}</Text>;

    case "user":
      return (
        <Box marginTop={1}>
          <Text color={MANGO_BRIGHT}>❯ </Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>{renderMarkdown(entry.text)}</Text>
          {entry.meta ? <Text dimColor>{`  ${entry.meta}`}</Text> : null}
        </Box>
      );

    case "tool":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={entry.ok === false ? "red" : MANGO}>⏺ </Text>
            <Text bold>{entry.name}</Text>
            {entry.summary ? <Text dimColor>{` ${entry.summary}`}</Text> : null}
          </Box>
          {entry.output ? (
            <Text dimColor>
              {entry.output
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}
            </Text>
          ) : null}
          {entry.outputMore ? (
            <Text dimColor>{`    … +${entry.outputMore} lines (ctrl+o)`}</Text>
          ) : null}
        </Box>
      );

    default:
      return (
        <Box marginTop={1}>
          <Text
            color={
              entry.tone === "error"
                ? "red"
                : entry.tone === "warn"
                  ? "yellow"
                  : entry.tone === "good"
                    ? "green"
                    : undefined
            }
            dimColor={!entry.tone}
          >
            {entry.text}
          </Text>
        </Box>
      );
  }
}
