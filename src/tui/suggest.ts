/**
 * The completion menu's data layer: which token is being completed at the
 * cursor, and what to offer for it. Two sources today — `/commands` (from
 * `commands.ts`) and `@file` references (from the workspace file list) — behind
 * one shape, so `app.tsx` renders and navigates a single kind of menu.
 */
import { COMMANDS, commandLabel, type SlashCommand } from "./commands.ts";

export type SuggestionKind = "command" | "file";

export interface Suggestion {
  kind: SuggestionKind;
  /** What replaces the token when picked. */
  value: string;
  /** Left column. */
  label: string;
  /** Right column. */
  hint: string;
  /** Commands with arguments complete to "/name " instead of running. */
  takesArgs?: boolean;
}

export interface TokenQuery {
  kind: SuggestionKind;
  /** Offset of the token's first character in the text. */
  start: number;
  /** The token without its `/` or `@` marker. */
  term: string;
}

/**
 * The token under the cursor, if it is completable. `/` only counts at the very
 * start of the input (a slash mid-sentence is just a slash); `@` counts anywhere
 * a word starts.
 */
export function findToken(text: string, cursor: number): TokenQuery | undefined {
  const upto = text.slice(0, cursor);
  const start = Math.max(upto.lastIndexOf(" "), upto.lastIndexOf("\n")) + 1;
  const token = upto.slice(start);

  if (token.startsWith("/")) {
    return start === 0 ? { kind: "command", start, term: token.slice(1) } : undefined;
  }
  if (token.startsWith("@")) return { kind: "file", start, term: token.slice(1) };
  return undefined;
}

export const MAX_SUGGESTIONS = 10;

export function suggestCommands(term: string): Suggestion[] {
  const lower = term.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(lower)).map(toSuggestion);
}

function toSuggestion(c: SlashCommand): Suggestion {
  return {
    kind: "command",
    value: `/${c.name}`,
    label: commandLabel(c),
    hint: c.desc,
    takesArgs: Boolean(c.args),
  };
}

/**
 * Rank workspace files for `@term`: paths whose file name starts with the term
 * first, then any path containing it, shortest first — the file you meant is
 * almost never the deeply nested one.
 */
export function suggestFiles(term: string, files: string[]): Suggestion[] {
  const lower = term.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lowerPath = path.toLowerCase();
    const name = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
    let score: number;
    if (!lower) score = 2;
    else if (name.startsWith(lower)) score = 0;
    else if (lowerPath.startsWith(lower)) score = 1;
    else if (lowerPath.includes(lower)) score = 2;
    else continue;
    scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_SUGGESTIONS).map(({ path }) => ({
    kind: "file" as const,
    value: `@${path}`,
    label: path.slice(path.lastIndexOf("/") + 1),
    hint: path,
  }));
}

export interface SuggestSources {
  /** Lazily-built workspace file list; only touched when an `@` is typed. */
  files: () => string[];
}

export function suggest(query: TokenQuery, sources: SuggestSources): Suggestion[] {
  return query.kind === "command"
    ? suggestCommands(query.term).slice(0, MAX_SUGGESTIONS)
    : suggestFiles(query.term, sources.files());
}

/** Replace the token at `query.start` with the picked value (plus a space). */
export function applySuggestion(
  text: string,
  cursor: number,
  query: TokenQuery,
  choice: Suggestion,
): { text: string; cursor: number } {
  const head = text.slice(0, query.start) + choice.value + " ";
  return { text: head + text.slice(cursor), cursor: head.length };
}
