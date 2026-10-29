/**
 * The input box's text model: a pure reducer over `{lines, row, col}`, with no
 * Ink or terminal knowledge, so every editing rule is unit-testable
 * (`test/editor.test.ts`). `app.tsx` only translates Ink key events into
 * `EditorKey`s and renders the resulting state.
 *
 * Supports what a shell-grade prompt needs: multi-line input (pasted newlines,
 * Alt+Enter, and a trailing backslash), word-wise motion and deletion, and the
 * usual Ctrl+A/E/K/U/W bindings.
 */

export interface EditorState {
  lines: string[];
  /** Cursor line, 0-based. */
  row: number;
  /** Cursor column within the line, 0-based; may equal the line length. */
  col: number;
}

/** A key press, normalised away from Ink's shape. */
export interface EditorKey {
  /** Printable text — one character, or a whole chunk when pasting. */
  input?: string;
  name?:
    | "left"
    | "right"
    | "up"
    | "down"
    | "home"
    | "end"
    | "backspace"
    | "delete"
    | "newline";
  ctrl?: boolean;
  /** Alt/Option. */
  meta?: boolean;
}

export const EMPTY: EditorState = { lines: [""], row: 0, col: 0 };

export function fromText(text: string, cursorAtEnd = true): EditorState {
  const lines = text.split("\n");
  const row = cursorAtEnd ? lines.length - 1 : 0;
  return { lines, row, col: cursorAtEnd ? lines[row]!.length : 0 };
}

/** Rebuild the state from text plus an absolute cursor offset (the inverse of `offset`). */
export function fromTextAt(text: string, cursor: number): EditorState {
  const before = text.slice(0, cursor).split("\n");
  return { lines: text.split("\n"), row: before.length - 1, col: before[before.length - 1]!.length };
}

export function toText(state: EditorState): string {
  return state.lines.join("\n");
}

export function isEmpty(state: EditorState): boolean {
  return state.lines.length === 1 && state.lines[0] === "";
}

/** Absolute cursor offset into `toText()` — used for suggestion lookups. */
export function offset(state: EditorState): number {
  let n = 0;
  for (let i = 0; i < state.row; i++) n += state.lines[i]!.length + 1;
  return n + state.col;
}

/** A line ending in an odd backslash means "keep typing", like a shell. */
export function endsWithContinuation(state: EditorState): boolean {
  const line = state.lines[state.row] ?? "";
  return state.col === line.length && /(^|[^\\])(\\\\)*\\$/.test(line);
}

export function apply(state: EditorState, key: EditorKey): EditorState {
  if (key.ctrl) {
    switch (key.input) {
      case "a":
        return { ...state, col: 0 };
      case "e":
        return { ...state, col: line(state).length };
      case "k":
        return replaceLine(state, line(state).slice(0, state.col));
      case "u":
        return { ...replaceLine(state, line(state).slice(state.col)), col: 0 };
      case "w":
        return deleteWordLeft(state);
      default:
        break;
    }
  }

  if (key.meta && (key.name === "left" || key.name === "right")) {
    const col = key.name === "left" ? wordLeft(line(state), state.col) : wordRight(line(state), state.col);
    return { ...state, col };
  }

  switch (key.name) {
    case "left":
      if (state.col > 0) return { ...state, col: state.col - 1 };
      if (state.row > 0) return { ...state, row: state.row - 1, col: state.lines[state.row - 1]!.length };
      return state;
    case "right":
      if (state.col < line(state).length) return { ...state, col: state.col + 1 };
      if (state.row < state.lines.length - 1) return { ...state, row: state.row + 1, col: 0 };
      return state;
    case "up": {
      if (state.row === 0) return state;
      const row = state.row - 1;
      return { ...state, row, col: Math.min(state.col, state.lines[row]!.length) };
    }
    case "down": {
      if (state.row >= state.lines.length - 1) return state;
      const row = state.row + 1;
      return { ...state, row, col: Math.min(state.col, state.lines[row]!.length) };
    }
    case "home":
      return { ...state, col: 0 };
    case "end":
      return { ...state, col: line(state).length };
    case "backspace":
      return backspace(state);
    case "delete":
      return del(state);
    case "newline":
      return newline(state);
    default:
      break;
  }

  if (key.input && !key.ctrl && !key.meta) return insert(state, key.input);
  return state;
}

/** Insert text at the cursor; embedded newlines (a paste) split the line. */
export function insert(state: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  // Strip control characters a paste may carry (escape sequences, bells) but
  // keep the newlines we just normalised.
  const safe = [...clean].filter((ch) => ch === "\n" || isPrintable(ch)).join("");
  if (!safe) return state;

  const current = line(state);
  const head = current.slice(0, state.col) + safe;
  const tail = current.slice(state.col);
  const inserted = (head + tail).split("\n");
  const lines = [...state.lines.slice(0, state.row), ...inserted, ...state.lines.slice(state.row + 1)];
  const row = state.row + inserted.length - 1;
  const col = inserted[inserted.length - 1]!.length - tail.length;
  return { lines, row, col };
}

export function newline(state: EditorState): EditorState {
  const current = line(state);
  const lines = [
    ...state.lines.slice(0, state.row),
    current.slice(0, state.col),
    current.slice(state.col),
    ...state.lines.slice(state.row + 1),
  ];
  return { lines, row: state.row + 1, col: 0 };
}

/** Turn a trailing continuation backslash into a real line break. */
export function continueLine(state: EditorState): EditorState {
  const current = line(state);
  const trimmed = { ...replaceLine(state, current.slice(0, -1)), col: current.length - 1 };
  return newline(trimmed);
}

function backspace(state: EditorState): EditorState {
  if (state.col > 0) {
    const current = line(state);
    return { ...replaceLine(state, current.slice(0, state.col - 1) + current.slice(state.col)), col: state.col - 1 };
  }
  if (state.row === 0) return state;
  const prev = state.lines[state.row - 1]!;
  const lines = [
    ...state.lines.slice(0, state.row - 1),
    prev + line(state),
    ...state.lines.slice(state.row + 1),
  ];
  return { lines, row: state.row - 1, col: prev.length };
}

function del(state: EditorState): EditorState {
  const current = line(state);
  if (state.col < current.length) {
    return replaceLine(state, current.slice(0, state.col) + current.slice(state.col + 1));
  }
  if (state.row >= state.lines.length - 1) return state;
  const lines = [
    ...state.lines.slice(0, state.row),
    current + state.lines[state.row + 1]!,
    ...state.lines.slice(state.row + 2),
  ];
  return { ...state, lines };
}

function deleteWordLeft(state: EditorState): EditorState {
  if (state.col === 0) return backspace(state);
  const current = line(state);
  const start = wordLeft(current, state.col);
  return { ...replaceLine(state, current.slice(0, start) + current.slice(state.col)), col: start };
}

/** Start of the word left of `col`: skip separators, then the word itself. */
export function wordLeft(text: string, col: number): number {
  let i = col;
  while (i > 0 && isSep(text[i - 1]!)) i--;
  while (i > 0 && !isSep(text[i - 1]!)) i--;
  return i;
}

/** End of the word right of `col`. */
export function wordRight(text: string, col: number): number {
  let i = col;
  while (i < text.length && isSep(text[i]!)) i++;
  while (i < text.length && !isSep(text[i]!)) i++;
  return i;
}

/** True for characters worth keeping from a paste: no NUL, bells or escapes. */
function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

function isSep(ch: string): boolean {
  return /[\s/\\.,:;()[\]{}'"`]/.test(ch);
}

function line(state: EditorState): string {
  return state.lines[state.row] ?? "";
}

function replaceLine(state: EditorState, text: string): EditorState {
  const lines = [...state.lines];
  lines[state.row] = text;
  return { ...state, lines, col: Math.min(state.col, text.length) };
}
