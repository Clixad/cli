/**
 * Line diffing for the edit preview — you should never approve a write you
 * haven't seen. Hand-rolled (no dependency, like `banner.ts`): common
 * prefix/suffix are trimmed, the rest goes through an LCS table, and the result
 * is grouped into hunks with a few lines of context and rendered with ANSI
 * colours for the TUI.
 */

const R = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** 1-based line number in the new file (add/ctx) or the old file (del). */
  line: number;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Guard: above this many changed lines we stop computing an exact LCS. */
const LCS_LIMIT = 3000;

/** Split like a text editor does: a trailing newline doesn't create a last empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(a: string[], b: string[]): DiffLine[] {
  // Trim the common head/tail first — most edits touch a small middle slice.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "ctx", text: a[i]!, line: i + 1 });

  if (midA.length * midB.length > LCS_LIMIT * LCS_LIMIT || midA.length * midB.length > 4_000_000) {
    // Too big for an exact diff — show it as a wholesale replacement.
    midA.forEach((text, i) => out.push({ kind: "del", text, line: head + i + 1 }));
    midB.forEach((text, i) => out.push({ kind: "add", text, line: head + i + 1 }));
  } else {
    out.push(...lcsDiff(midA, midB, head));
  }

  for (let i = 0; i < tail; i++) {
    const idx = b.length - tail + i;
    out.push({ kind: "ctx", text: b[idx]!, line: idx + 1 });
  }
  return out;
}

/** Classic LCS DP, walked back into add/del/ctx lines. `offset` = trimmed head. */
function lcsDiff(a: string[], b: string[], offset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: b[j]!, line: offset + j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      out.push({ kind: "del", text: a[i]!, line: offset + i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]!, line: offset + j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i]!, line: offset + i++ + 1 });
  while (j < m) out.push({ kind: "add", text: b[j]!, line: offset + j++ + 1 });
  return out;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

export interface RenderDiffOptions {
  /** Unchanged lines kept around each change. */
  context?: number;
  /** Hard cap on rendered lines; the rest is summarised. */
  maxLines?: number;
  /** Longer lines are cut so one runaway line can't fill the screen. */
  maxWidth?: number;
}

/** One row of a diff as the TUI draws it: a line, or the unchanged lines between two hunks. */
export type DiffRow = { kind: "add" | "del" | "ctx"; line: number; text: string } | { kind: "gap"; count: number };

/**
 * What a write did to a file, for the transcript. It travels beside the tool
 * result rather than inside it: the model is told what it is always told, and
 * the person watching sees the lines that changed, in accept-edits and auto
 * mode too, where no dialog ever showed them.
 */
export interface DiffView {
  kind: "diff";
  path: string;
  /** The file did not exist before: `rows` are its lines, all added. */
  created: boolean;
  added: number;
  removed: number;
  rows: DiffRow[];
}

/** Rows a view keeps at most, so a generated file does not sit in memory twice. */
const MAX_VIEW_ROWS = 2_000;

export function diffView(path: string, before: string, after: string, opts: { context?: number; created?: boolean } = {}): DiffView {
  const context = opts.context ?? 3;
  if (opts.created) {
    const lines = splitLines(after);
    const rows: DiffRow[] = lines.slice(0, MAX_VIEW_ROWS).map((text, i) => ({ kind: "add", line: i + 1, text }));
    if (lines.length > MAX_VIEW_ROWS) rows.push({ kind: "gap", count: lines.length - MAX_VIEW_ROWS });
    return { kind: "diff", path, created: true, added: after === "" ? 0 : lines.length, removed: 0, rows };
  }
  const lines = diffLines(splitLines(before), splitLines(after));
  const { added, removed } = diffStat(lines);
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    // A gap before the first hunk says nothing the line numbers do not.
    if (skipped > 0 && rows.length > 0) rows.push({ kind: "gap", count: skipped });
    skipped = 0;
    if (rows.length >= MAX_VIEW_ROWS) {
      rows.push({ kind: "gap", count: lines.length - i });
      break;
    }
    rows.push({ ...lines[i]! });
  }
  return { kind: "diff", path, created: false, added, removed, rows };
}

/**
 * How a diff row may be coloured. A full-row background is what makes a diff
 * readable at a glance, but only a terminal that says it has 24-bit colour gets
 * the exact tints; anything that says 256 colours gets the nearest palette
 * entries, and `NO_COLOR` gets the `+` and `-` alone.
 */
export type DiffTint = "truecolor" | "256" | "basic" | "none";

export function diffTint(env: { NO_COLOR?: string; COLORTERM?: string; TERM?: string } = process.env): DiffTint {
  if (env.NO_COLOR) return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (/256/.test(env.TERM ?? "")) return "256";
  if (env.TERM === "dumb") return "none";
  return "basic";
}

const TINTS: Record<DiffTint, { add: string; del: string; addSign: string; delSign: string; off: string }> = {
  truecolor: {
    add: "\x1b[48;2;28;62;38m",
    del: "\x1b[48;2;78;32;36m",
    addSign: "\x1b[38;2;126;231;135m",
    delSign: "\x1b[38;2;255;123;114m",
    off: R,
  },
  "256": { add: "\x1b[48;5;22m", del: "\x1b[48;5;52m", addSign: "\x1b[92m", delSign: "\x1b[91m", off: R },
  basic: { add: GREEN, del: RED, addSign: "", delSign: "", off: R },
  none: { add: "", del: "", addSign: "", delSign: "", off: "" },
};

/**
 * A diff drawn as terminal rows: a line-number gutter, the sign, the text,
 * each row exactly `width` columns (cut, never wrapped, and padded so a
 * background reaches the edge). Measured with the same functions ink lays out
 * with, so a row the caller counts as one is one.
 */
export function renderDiffRows(
  view: DiffView,
  width: number,
  opts: { maxRows?: number; tint?: DiffTint; measure: (s: string) => number; cut: (s: string, cols: number) => string },
): { rows: string[]; more: number } {
  const tint = TINTS[opts.tint ?? "basic"];
  const max = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const numbers = view.rows.filter((r) => r.kind !== "gap") as Array<{ line: number }>;
  const gutter = Math.max(3, ...numbers.map((r) => String(r.line).length));
  const fit = (text: string) => {
    const cut = opts.measure(text) > width ? opts.cut(text, width) : text;
    return cut + " ".repeat(Math.max(0, width - opts.measure(cut)));
  };
  const rows: string[] = [];
  let more = 0;
  for (const row of view.rows) {
    if (rows.length >= max) {
      if (row.kind !== "gap") more++;
      continue;
    }
    if (row.kind === "gap") {
      const dim = tint === TINTS.none ? "" : DIM;
      rows.push(`${dim}${opts.cut(`${" ".repeat(gutter)}   ⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}`, width)}${tint.off}`);
      continue;
    }
    const text = row.text.replace(/\t/g, "  ");
    const no = String(row.line).padStart(gutter);
    if (row.kind === "ctx") {
      rows.push(`${tint === TINTS.none ? "" : DIM}${opts.cut(`${no}   ${text}`, width)}${tint.off}`);
      continue;
    }
    const sign = row.kind === "add" ? "+" : "-";
    const bg = row.kind === "add" ? tint.add : tint.del;
    const signColor = row.kind === "add" ? tint.addSign : tint.delSign;
    const body = fit(`${no} ${sign} ${text}`);
    // The sign keeps its own colour on top of the row's tint.
    const at = gutter + 1;
    rows.push(`${bg}${body.slice(0, at)}${signColor}${sign}${signColor ? "\x1b[39m" : ""}${body.slice(at + 1)}${tint.off}`);
  }
  return { rows, more };
}

/**
 * Render old→new as a coloured, hunked diff. Returns "" when nothing changed,
 * so callers can treat a no-op edit as such.
 */
export function renderDiff(oldText: string, newText: string, opts: RenderDiffOptions = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 40;
  const maxWidth = opts.maxWidth ?? 200;

  const lines = diffLines(splitLines(oldText), splitLines(newText));
  const { added, removed } = diffStat(lines);
  if (added === 0 && removed === 0) return "";

  // Keep only context lines near a change.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let skipped = 0;
  let truncated = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      out.push(`${DIM}   ⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}${R}`);
      skipped = 0;
    }
    if (out.length >= maxLines) {
      truncated++;
      continue;
    }
    const l = lines[i]!;
    const text = l.text.length > maxWidth ? l.text.slice(0, maxWidth - 1) + "…" : l.text;
    const no = String(l.line).padStart(4);
    if (l.kind === "add") out.push(`${GREEN}${no} + ${text}${R}`);
    else if (l.kind === "del") out.push(`${RED}${no} - ${text}${R}`);
    else out.push(`${DIM}${no}   ${text}${R}`);
  }
  if (truncated > 0) out.push(`${DIM}   ⋯ ${truncated} more changed line${truncated === 1 ? "" : "s"}${R}`);

  const stat = `${GREEN}+${added}${R} ${RED}-${removed}${R}`;
  return `${stat}\n${out.join("\n")}`;
}
