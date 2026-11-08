/**
 * How much of a model's window one tool result, one round of them, or the
 * files attached to one message may take.
 *
 * Every request carries the whole conversation, so a result is not paid for
 * once: it rides along until compaction summarises it. And a result larger
 * than the window can hold is worse than expensive. It cannot be kept, so
 * compaction can only summarise it, and the model that asked for it reads it
 * again. So results are sized to the model before they enter the
 * conversation, and what is left out is said where it was cut, with how to
 * get the rest: a shortened result read as the whole thing is how an agent
 * concludes that something it was not shown does not exist.
 *
 * Measured in JSON bytes, which is what `requestTokens` weighs a message by
 * (four of them a token): escaping counts, so a numbered file listing is a
 * little heavier than its characters.
 */
import { compactBudget } from "./compact.ts";

/** The UTF-8 bytes `text` takes as a JSON string, without its quotes. */
export function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * What one round's tool results may take together, in JSON bytes: a third of
 * the compaction budget, at four bytes a token. A round that size, with the
 * call that asked for it, fits what a compaction keeps (half the budget), so
 * the work the model has just done is never the part summarised away. On
 * Claude Haiku 5.5 that is 24,000 bytes, about 600 lines of source.
 */
export function roundRoom(contextTokens: number): number {
  return Math.floor((compactBudget(contextTokens) * 4) / 3);
}

/**
 * What the files `@path` attaches to one message may take, in JSON bytes:
 * half the budget, so the message fits beside a summary of everything before
 * it.
 */
export function mentionRoom(contextTokens: number): number {
  return compactBudget(contextTokens) * 2;
}

/** What to do about a cut, for the tools whose output can be asked for in parts. */
const ADVICE: Record<string, string> = {
  read_file: "Read on with offset and limit.",
  grep: "Narrow the pattern, the path or the glob to see the rest.",
  glob: "Narrow the pattern or the path to see the rest.",
  list_dir: "List a subdirectory to see the rest.",
  run_command: "Filter the output (grep, head, tail) to see the rest.",
  read_output: "Filter it (the filter argument) to see the rest.",
  web_fetch: "Fetch a more specific page for the rest.",
};

/** Commands keep both ends: what a command printed first and the error it ended on. */
const KEEP_ENDS = new Set(["run_command", "read_output", "!"]);

/** `text` cut to `chars` code units without splitting a surrogate pair. */
function headOf(text: string, chars: number): string {
  const code = text.charCodeAt(chars - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? chars - 1 : chars);
}

function tailOf(text: string, chars: number): string {
  if (chars <= 0) return "";
  const from = text.length - chars;
  const code = text.charCodeAt(from);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? from + 1 : from);
}

/**
 * A tool's result as the model is given it: whole when it fits `room` JSON
 * bytes, else cut to fit with the cut said where it is. A command keeps its
 * first and last lines, everything else its start.
 */
export function fitResult(tool: string, text: string, room: number | undefined): string {
  if (room === undefined || jsonBytes(text) <= room) return text;
  const ends = KEEP_ENDS.has(tool);
  const note = (left: number) =>
    `\n… [${left.toLocaleString("en-US")} characters left out ${ends ? "here" : "after this"}: ` +
    `more than one result takes on this model. ${ADVICE[tool] ?? "Ask for less at a time."}]` +
    (ends ? "\n" : "");
  const build = (keep: number) => {
    const head = headOf(text, ends ? Math.ceil(keep / 2) : keep);
    const tail = ends ? tailOf(text, Math.floor(keep / 2)) : "";
    return `${head}${note(text.length - head.length - tail.length)}${tail}`;
  };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(build(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}
