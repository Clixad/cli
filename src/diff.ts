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
