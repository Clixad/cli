/**
 * A stdout that ink treats as a real terminal, so the frame rules can be tested.
 *
 * `ink-testing-library` cannot be used for any of this, and that is not a
 * preference. Its stdout has **no `isTTY`**, so ink runs its non-interactive
 * path: it never registers a resize listener, never erases a previous frame,
 * and never reaches `shouldClearTerminalForFrame` — the fallback that clears
 * the screen and replays every static line, which is the failure every layout
 * rule in `app.tsx` and `views.tsx` exists to avoid. Its `columns` is also a
 * hardcoded getter returning 100, so a test that thinks it is measuring a
 * 40-column terminal is measuring a 100-column one.
 *
 * The result was a `TUI frame height` suite that passed while the bottom region
 * was two rows over the viewport on the most ordinary path in the product.
 *
 * Everything here is deliberately small: a writable that records, a readable
 * that can be typed into, and two measurements — how many rows a frame really
 * occupies, and how often ink gave up and cleared the terminal.
 */
import { EventEmitter } from "node:events";
import stringWidth from "string-width";

const ESC = "\u001b";
/** What ink writes when the frame no longer fits and it starts over. */
export const CLEAR_TERMINAL = `${ESC}[2J`;

export interface FakeTerminal extends EventEmitter {
  isTTY: true;
  columns: number;
  rows: number;
  writes: string[];
  write(data: string): boolean;
  /** Change the size and fire the event, exactly as a real terminal does. */
  resize(rows: number, columns: number): void;
  /** Everything written since the last `clear()`. */
  output(): string;
  clear(): void;
}

class Terminal extends EventEmitter implements FakeTerminal {
  isTTY = true as const;
  writes: string[] = [];

  constructor(
    public rows: number,
    public columns: number,
  ) {
    super();
    // App and ink both size themselves from `process.stdout`; keep the two in
    // step so a test cannot accidentally measure two different terminals.
    this.setMaxListeners(0);
  }

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  /**
   * Change the size and fire the event, exactly as a real terminal does.
   *
   * `process.stdout` is pinned to match because a few things outside the render
   * tree still consult it (the sponsored line's TTY gate, `clearScreen`), and a
   * test terminal that disagreed with the process would be testing a situation
   * that cannot happen: in production ink is handed `process.stdout` itself.
   */
  resize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    pinProcessStdout(rows, columns);
    this.emit("resize");
  }

  output(): string {
    return this.writes.join("");
  }

  clear(): void {
    this.writes.length = 0;
  }
}

/** A stdin ink will read from, and tests can type into. */
export interface FakeStdin extends EventEmitter {
  isTTY: true;
  setEncoding(): void;
  setRawMode(): void;
  resume(): void;
  pause(): void;
  ref(): void;
  unref(): void;
  read(): string | null;
  /** Deliver keystrokes the way ink's reader expects them. */
  send(data: string): void;
}

export function fakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.setMaxListeners(0);
  stdin.isTTY = true;
  stdin.setEncoding = () => {};
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let pending: string | null = null;
  stdin.read = () => {
    const data = pending;
    pending = null;
    return data;
  };
  stdin.send = (data: string) => {
    pending = data;
    stdin.emit("readable");
    stdin.emit("data", data);
  };
  return stdin;
}

const savedRows = process.stdout.rows;
const savedColumns = process.stdout.columns;

/**
 * `App` sizes itself from `process.stdout` (that is what ink is handed in
 * production), so a test terminal is only honest if the two agree.
 */
export function pinProcessStdout(rows: number, columns: number): void {
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
}

export function restoreProcessStdout(): void {
  pinProcessStdout(savedRows ?? 24, savedColumns ?? 80);
}

export function fakeTerminal(rows: number, columns: number): FakeTerminal {
  pinProcessStdout(rows, columns);
  return new Terminal(rows, columns);
}

/** Strip OSC and CSI so what is left is what the user would see. */
export function plain(s: string): string {
  return s
    .replace(new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007)?`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

/** How many times ink gave up on incremental redraw and cleared the screen. */
export function clearCount(term: FakeTerminal): number {
  return term.output().split(CLEAR_TERMINAL).length - 1;
}

/**
 * The prompt, which is drawn on every frame and on nothing else that matters.
 *
 * Ink writes committed `<Static>` output and the repainted frame as separate
 * `write` calls, and only the frame is bounded by the viewport — static output
 * scrolls away on its own and is allowed to be as tall as it likes. They have
 * to be told apart, or a tall welcome banner reads as a frame that overflowed.
 *
 * This was `│ ❯` — the prompt inside its border — which was wrong in a way that
 * made the small-terminal tests pass while measuring nothing: on a terminal too
 * short to hold a bordered box and a dialog, the border is given up and the
 * prompt is drawn bare. `❯` alone also appears in a committed user entry, so
 * `isFrame` can misclassify the static write of the render that commits one.
 * That is why the tests assert `clearCount` as well: it is ink's own verdict
 * that the frame did not fit, and it needs no classification at all.
 */
const FRAME_MARKER = "❯";

/** Whether this write is the repainted region rather than committed scrollback. */
export function isFrame(write: string): boolean {
  return !write.includes(CLEAR_TERMINAL) && plain(write).includes(FRAME_MARKER);
}

/**
 * The tallest frame ink was asked to paint, in rows.
 *
 * The tallest is what decides whether the region fit: one frame over the
 * viewport is enough for ink to clear the terminal and replay the session.
 */
export function tallestFrameRows(term: FakeTerminal): number {
  let tallest = 0;
  for (const write of term.writes) {
    if (!isFrame(write)) continue;
    const rows = plain(write).split("\n").length;
    if (rows > tallest) tallest = rows;
  }
  return tallest;
}

/** Every row of every frame — what the repainted region actually put on screen. */
export function frameRows(term: FakeTerminal): string[] {
  return term.writes.filter(isFrame).flatMap((w) => plain(w).split("\n"));
}

/** Let ink render, effects settle and any pooled deltas flush. */
export function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What a real terminal would show after everything ink wrote: the screen, the
 * scrollback above it, and where the cursor ended up.
 *
 * Every other helper here reads the **writes**, and a write cannot say where
 * its rows land. The failure that needed this is a frame that *shrank*: ink
 * erases the rows it last wrote and paints fewer, the rows below it stay blank,
 * and nothing in the stream of writes looks wrong — the input box has simply
 * moved up the screen, over empty rows the terminal now lets you scroll into.
 * Only replaying the bytes onto a grid shows that.
 *
 * It implements what ink, `log-update`, `ansi-escapes` and this app emit and no
 * more: printable text measured in columns (`string-width`, the way ink lays
 * it out) with the terminal's deferred wrap at the right edge, `\n` as CR+LF
 * (libuv keeps `ONLCR` on in raw mode), cursor movement (`A B C D G H f`),
 * erase (`K J`, including `3J` for the scrollback), and scrolling off the top
 * into the scrollback. Colours, cursor visibility, bracketed paste, synchronised
 * output and OSC titles are read and ignored. It replays at the terminal's
 * *current* size, so a test that resizes should not ask it for the screen.
 */
export interface Screen {
  /** Every row of the viewport, right-trimmed. */
  rows: string[];
  /** Rows that scrolled off the top, oldest first. */
  scrollback: string[];
  cursor: { row: number; col: number };
}

const segmenter = new Intl.Segmenter();

export function screenOf(term: FakeTerminal): Screen {
  return emulate(term.output(), term.rows, term.columns);
}

export function emulate(output: string, height: number, width: number): Screen {
  const blankRow = () => Array.from({ length: width }, () => " ");
  let grid: string[][] = Array.from({ length: height }, blankRow);
  let scrollback: string[] = [];
  let row = 0;
  let col = 0;
  // A glyph written into the last column leaves the cursor there with a wrap
  // pending; only the next printable character actually moves to a new row.
  let pendingWrap = false;
  let saved = { row: 0, col: 0 };

  const rowText = (cells: string[]) => cells.join("").replace(/\s+$/, "");
  const lineFeed = () => {
    if (row === height - 1) {
      scrollback.push(rowText(grid[0]!));
      grid = [...grid.slice(1), blankRow()];
    } else {
      row++;
    }
  };
  const put = (glyph: string) => {
    const w = stringWidth(glyph);
    if (w === 0) return;
    if (pendingWrap || col + w > width) {
      col = 0;
      lineFeed();
      pendingWrap = false;
    }
    grid[row]![col] = glyph;
    for (let k = 1; k < w; k++) grid[row]![col + k] = "";
    col += w;
    if (col >= width) {
      col = width - 1;
      pendingWrap = true;
    }
  };
  const erase = (r: number, from: number, to: number) => {
    for (let c = from; c < to; c++) grid[r]![c] = " ";
  };

  let i = 0;
  while (i < output.length) {
    const ch = output[i]!;
    if (ch === ESC) {
      const next = output[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < output.length && !/[@-~]/.test(output[j]!)) j++;
        const params = output.slice(i + 2, j);
        const final = output[j];
        i = j + 1;
        if (params.startsWith("?")) continue; // modes: cursor, paste, sync
        const nums = params.split(";").map((p) => (p === "" ? undefined : Number(p)));
        const n = nums[0] ?? 1;
        switch (final) {
          case "A":
            row = Math.max(0, row - n);
            pendingWrap = false;
            break;
          case "B":
            row = Math.min(height - 1, row + n);
            pendingWrap = false;
            break;
          case "C":
            col = Math.min(width - 1, col + n);
            pendingWrap = false;
            break;
          case "D":
            col = Math.max(0, col - n);
            pendingWrap = false;
            break;
          case "G":
            col = Math.min(width - 1, Math.max(0, n - 1));
            pendingWrap = false;
            break;
          case "H":
          case "f":
            row = Math.min(height - 1, Math.max(0, (nums[0] ?? 1) - 1));
            col = Math.min(width - 1, Math.max(0, (nums[1] ?? 1) - 1));
            pendingWrap = false;
            break;
          case "K": {
            const mode = nums[0] ?? 0;
            if (mode === 2) erase(row, 0, width);
            else if (mode === 1) erase(row, 0, col + 1);
            else erase(row, col, width);
            break;
          }
          case "J": {
            const mode = nums[0] ?? 0;
            if (mode === 3) scrollback = [];
            else if (mode === 2) grid = Array.from({ length: height }, blankRow);
            else if (mode === 1) {
              for (let r = 0; r < row; r++) erase(r, 0, width);
              erase(row, 0, col + 1);
            } else {
              erase(row, col, width);
              for (let r = row + 1; r < height; r++) erase(r, 0, width);
            }
            break;
          }
          default:
            break; // SGR colours and anything else that does not move text
        }
        continue;
      }
      if (next === "]") {
        // OSC, terminated by BEL or ST.
        let j = i + 2;
        while (j < output.length && output[j] !== "\u0007" && !(output[j] === ESC && output[j + 1] === "\\")) j++;
        i = output[j] === "\u0007" ? j + 1 : j + 2;
        continue;
      }
      if (next === "7") saved = { row, col };
      if (next === "8") ({ row, col } = saved);
      if (next === "c") {
        grid = Array.from({ length: height }, blankRow);
        scrollback = [];
        row = 0;
        col = 0;
      }
      i += 2;
      continue;
    }
    if (ch === "\n") {
      col = 0;
      pendingWrap = false;
      lineFeed();
      i++;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      pendingWrap = false;
      i++;
      continue;
    }
    if (ch < " ") {
      i++;
      continue;
    }
    let j = i;
    while (j < output.length && output[j] !== ESC && output[j]! >= " ") j++;
    for (const { segment } of segmenter.segment(output.slice(i, j))) put(segment);
    i = j;
  }

  return { rows: grid.map(rowText), scrollback, cursor: { row, col } };
}

/** The last row of the screen with anything on it, or -1 for a blank screen. */
export function lastInkedRow(screen: Screen): number {
  for (let r = screen.rows.length - 1; r >= 0; r--) if (screen.rows[r] !== "") return r;
  return -1;
}
