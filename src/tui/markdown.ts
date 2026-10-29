/**
 * A very small markdown renderer for assistant replies. Models write markdown;
 * a terminal that prints it raw looks unfinished. This turns the handful of
 * constructs that actually show up in coding answers into ANSI — the same
 * approach as `banner.ts`, so the result is just a string and Ink's layout
 * (and our line-height maths) keeps working.
 *
 * Deliberately not a full parser: no tables, no nested emphasis, no links.
 */

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const MANGO = "\x1b[38;2;245;184;65m";
const CODE = "\x1b[38;2;150;200;255m";

export function renderMarkdown(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (const raw of text.split("\n")) {
    const fence = /^\s*```(.*)$/.exec(raw);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1]!.trim();
        if (fenceLang) out.push(`${DIM}  ┌─ ${fenceLang}${R}`);
        else out.push(`${DIM}  ┌─${R}`);
      } else {
        inFence = false;
        out.push(`${DIM}  └─${R}`);
      }
      continue;
    }

    if (inFence) {
      out.push(`${DIM}  │ ${R}${CODE}${raw}${R}`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${BOLD}${MANGO}${heading[2]}${R}`);
      continue;
    }

    const rule = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.exec(raw);
    if (rule) {
      out.push(`${DIM}────────${R}`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push(`${bullet[1]}${MANGO}•${R} ${inline(bullet[2]!)}`);
      continue;
    }

    if (/^\s*>\s?/.test(raw)) {
      out.push(`${DIM}${raw.replace(/^\s*>\s?/, "▏ ")}${R}`);
      continue;
    }

    out.push(inline(raw));
  }

  return out.join("\n");
}

/** Inline spans: `code`, **bold**, *italic*. Applied outside fences only. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => `${CODE}${code}${R}`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => `${BOLD}${bold}${R}`)
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_m, pre: string, it: string) => `${pre}${ITALIC}${it}${R}`);
}
