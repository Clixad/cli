/**
 * Markdown for assistant replies, rendered to ANSI for the terminal.
 *
 * Models write markdown, and a terminal that prints it raw looks unfinished.
 * This covers what actually shows up in coding answers: headings, lists with
 * hanging indents, task lists, block quotes, rules, tables, fenced code with
 * syntax colour, and inline code, bold, italic, strikethrough and links.
 *
 * Two properties the rest of the TUI depends on:
 *
 * - **It wraps to the width it is given**, the way ink would (`wrap-ansi`,
 *   hard breaks for words longer than a row), so every line it returns is one
 *   terminal row. The layout counts rows; text that ink re-wrapped behind its
 *   back would be rows nobody counted. Without a width nothing is wrapped.
 * - **It is line by line, and carries its state.** The only thing one line
 *   needs from the lines before it is whether a code fence is open (and what
 *   the highlighter left open inside it). `renderMarkdownState` takes that and
 *   returns it, so an answer committed to the scrollback a few lines at a time
 *   while it streams renders exactly as the whole answer would. Tables are the
 *   one construct that needs its rows together; the streaming side holds them
 *   back until they end (`stream.ts`).
 */
import wrapAnsi from "wrap-ansi";
import { visibleLength } from "../banner.ts";
import { highlightLine, type HighlightState } from "./highlight.ts";

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const UNDERLINE = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
const STRIKE = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";
const FG_OFF = "\x1b[39m";
const MANGO = "\x1b[38;2;245;184;65m";
const CODE = "\x1b[38;2;150;200;255m";

/** Columns a code block is set in from the text around it. */
const CODE_INDENT = "  ";
const BULLETS = ["•", "◦", "▪"];

export interface MdState {
  /** An open code fence: its language, the fence it has to be closed with, and the highlighter's state. */
  fence?: { lang: string; marker: string; hl: HighlightState };
}

export function renderMarkdown(text: string, cols = Number.POSITIVE_INFINITY, state: MdState = {}): string {
  return renderMarkdownState(text, cols, state).text;
}

/** A line that opens a code fence, or undefined. */
export function fenceOpen(line: string): { marker: string; lang: string } | undefined {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
  if (!m) return undefined;
  // A backtick fence whose info string carries a backtick is inline code, not a fence.
  if (m[1]![0] === "`" && line.slice(m[0].length).includes("`")) return undefined;
  return { marker: m[1]!, lang: m[2] ?? "" };
}

/** Whether `line` closes a fence opened with `marker`. */
export function fenceCloses(line: string, marker: string): boolean {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m && m[1]![0] === marker[0] && m[1]!.length >= marker.length);
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Whether the table that starts at `lines[i]` has its separator row. */
function tableAt(lines: string[], i: number): boolean {
  const sep = lines[i + 1];
  return lines[i]!.includes("|") && sep !== undefined && sep.includes("|") && TABLE_SEP.test(sep);
}

export function renderMarkdownState(
  text: string,
  cols = Number.POSITIVE_INFINITY,
  state: MdState = {},
): { text: string; state: MdState } {
  const width = Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : Number.POSITIVE_INFINITY;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = state.fence ? { ...state.fence } : undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;

    if (fence) {
      if (fenceCloses(raw, fence.marker)) {
        fence = undefined;
        continue;
      }
      const lit = highlightLine(raw, fence.lang, fence.hl);
      fence.hl = lit.state;
      // Code keeps its own spacing, so nothing is trimmed when it wraps, and an
      // unknown language is still told apart from prose by its colour.
      const body = fence.lang && lit.text !== raw ? lit.text : `${CODE}${raw}${FG_OFF}`;
      out.push(...wrapBlock(body, CODE_INDENT, CODE_INDENT, width, false));
      continue;
    }

    const open = fenceOpen(raw);
    if (open) {
      fence = { lang: open.lang, marker: open.marker, hl: {} };
      continue;
    }

    if (tableAt(lines, i)) {
      let end = i + 2;
      while (end < lines.length && lines[end]!.trim() !== "" && lines[end]!.includes("|")) end++;
      out.push(...renderTable(lines[i]!, lines[i + 1]!, lines.slice(i + 2, end), width));
      i = end - 1;
      continue;
    }

    if (raw.trim() === "") {
      // One blank row between blocks however many the model wrote.
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      else if (out.length === 0) out.push("");
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const style = heading[1]!.length <= 2 ? BOLD + MANGO : BOLD;
      out.push(...wrapBlock(`${style}${inline(heading[2]!, style)}${R}`, "", "", width));
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      out.push(`${DIM}${"─".repeat(Math.min(width, 40))}${R}`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = bullet[1]!.replace(/\t/g, "  ");
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2]!);
      if (task) {
        const done = task[1] !== " ";
        const glyph = done ? `${MANGO}☒${R}` : `${MANGO}☐${R}`;
        const body = done ? `${DIM}${inline(task[2]!, DIM)}${R}` : inline(task[2]!);
        out.push(...wrapBlock(body, `${indent}${glyph} `, `${indent}  `, width));
      } else {
        const glyph = BULLETS[Math.floor(indent.length / 2) % BULLETS.length]!;
        out.push(...wrapBlock(inline(bullet[2]!), `${indent}${MANGO}${glyph}${R} `, `${indent}  `, width));
      }
      continue;
    }

    const ordered = /^(\s*)(\d{1,9})([.)])\s+(.*)$/.exec(raw);
    if (ordered) {
      const indent = ordered[1]!.replace(/\t/g, "  ");
      const label = `${ordered[2]}${ordered[3]}`;
      out.push(
        ...wrapBlock(
          inline(ordered[4]!),
          `${indent}${MANGO}${label}${R} `,
          `${indent}${" ".repeat(label.length + 1)}`,
          width,
        ),
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(...wrapBlock(`${DIM}${ITALIC}${inline(quote[1]!, DIM + ITALIC)}${R}`, `${DIM}▏${R} `, `${DIM}▏${R} `, width));
      continue;
    }

    const lead = /^\s*/.exec(raw)![0].replace(/\t/g, "  ");
    out.push(...wrapBlock(inline(raw.trimStart()), lead, lead, width));
  }

  // A blank row at the end is a gap under the block that nothing asked for.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return { text: out.join("\n"), state: fence ? { fence } : {} };
}

/**
 * `content` set after `first` on its first row and after `rest` on the rows it
 * wraps onto: the hanging indent that keeps a wrapped list item under its own
 * text rather than under its bullet.
 */
function wrapBlock(content: string, first: string, rest: string, width: number, trim = true): string[] {
  if (!Number.isFinite(width)) return [first + content];
  const room = Math.max(1, width - Math.max(visibleLength(first), visibleLength(rest)));
  const rows = wrapAnsi(content, room, { hard: true, trim, wordWrap: true }).split("\n");
  return rows.map((row, k) => (k === 0 ? first : rest) + row);
}

/**
 * Inline spans. `restore` is the style the surrounding block is set in (a
 * heading's bold mango), re-applied after every span that has to switch part
 * of it off on the way out.
 */
export function inline(text: string, restore = ""): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick === -1) {
      out += emphasis(text.slice(i), restore);
      break;
    }
    let run = 1;
    while (text[tick + run] === "`") run++;
    const fence = "`".repeat(run);
    const close = text.indexOf(fence, tick + run);
    if (close === -1) {
      out += emphasis(text.slice(i), restore);
      break;
    }
    out += emphasis(text.slice(i, tick), restore);
    const code = text.slice(tick + run, close).replace(/^ (.+) $/, "$1");
    out += `${CODE}${code}${FG_OFF}${restore}`;
    i = close + run;
  }
  return out;
}

function emphasis(text: string, restore: string): string {
  if (!text) return text;
  return (
    text
      // Links before emphasis: an underscore in a URL is not italic.
      .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
        label === url
          ? `${UNDERLINE}${url}${UNDERLINE_OFF}`
          : `${UNDERLINE}${label}${UNDERLINE_OFF}${DIM} (${url})${BOLD_OFF}${restore}`,
      )
      .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => `${UNDERLINE}${url}${UNDERLINE_OFF}`)
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_m, a?: string, b?: string) => `${BOLD}${a ?? b}${BOLD_OFF}${restore}`)
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_m, s: string) => `${STRIKE}${s}${STRIKE_OFF}`)
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, (_m, pre: string, s: string) => `${pre}${ITALIC}${s}${ITALIC_OFF}`)
      .replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, (_m, pre: string, s: string) => `${pre}${ITALIC}${s}${ITALIC_OFF}`)
  );
}

type Align = "left" | "right" | "center";

function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - visibleLength(text));
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
  return text + " ".repeat(gap);
}

/**
 * A table drawn with box rules when it fits the width, and as one
 * `header: value` block per row when it does not: a table squeezed until its
 * cells wrap inside their columns is harder to read than the same facts as a
 * list, and a table wider than the terminal wraps into nonsense.
 */
function renderTable(header: string, sep: string, body: string[], width: number): string[] {
  const head = tableCells(header);
  const n = head.length;
  const aligns: Align[] = tableCells(sep).map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
  );
  const rows = body.map((line) => {
    const cells = tableCells(line);
    return Array.from({ length: n }, (_, k) => inline(cells[k] ?? ""));
  });
  const heads = head.map((cell) => inline(cell, BOLD));
  const widths = heads.map((cell, k) => Math.max(visibleLength(cell), ...rows.map((row) => visibleLength(row[k]!)), 1));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * n + 1;

  if (total <= width) {
    const rule = (l: string, m: string, r: string) => `${DIM}${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}${R}`;
    const row = (cells: string[], bold = false) =>
      `${DIM}│${R}` +
      cells
        .map((cell, k) => ` ${bold ? BOLD : ""}${pad(cell, widths[k]!, aligns[k] ?? "left")}${bold ? R : ""} ${DIM}│${R}`)
        .join("");
    return [rule("┌", "┬", "┐"), row(heads, true), rule("├", "┼", "┤"), ...rows.map((r) => row(r)), rule("└", "┴", "┘")];
  }

  const out: string[] = [];
  for (const row of rows) {
    row.forEach((cell, k) => {
      const label = `${DIM}${head[k] ?? ""}:${R} ${cell}`;
      out.push(...wrapBlock(label, k === 0 ? `${MANGO}•${R} ` : "  ", "  ", width));
    });
  }
  return out;
}
