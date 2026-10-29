/**
 * Whether this run may emit ANSI, and the palette that asks.
 *
 * The one-shot commands wrote colour unconditionally — `clixad models > list`,
 * `clixad wallet | grep`, `clixad -p "…" > answer.txt` all produced files full
 * of `[36m`. That is odd on its own, and it is inconsistent in a way that
 * matters: `sponsor/render.ts` refuses to draw a single decorative row unless
 * the stream is a terminal, `NO_COLOR` is unset and `CI` is unset, and
 * `title.ts` will not send an escape to anything but a TTY. Those rules were
 * written because a CLI that writes terminal control codes into a file has
 * stopped being usable in a pipeline; they apply to `[31m` as much as to
 * a status line.
 *
 * The gate is a pure function over its world, like the other two, so "produces
 * clean output when redirected" is a property a test can assert rather than a
 * claim about `process`.
 *
 * `FORCE_COLOR` is honoured and is checked **first**, both directions. It is
 * the convention every major CLI uses, and it is what a CI job that captures a
 * pty and *wants* colour reaches for; `CI` is deliberately not consulted here,
 * unlike in the sponsored line's gate, because a build log with coloured
 * diagnostics in it is useful and a build log with an advert in it is not.
 */

export interface ColorEnv {
  NO_COLOR?: string | undefined;
  FORCE_COLOR?: string | undefined;
  TERM?: string | undefined;
}

export interface ColorGateInput {
  /** `process.stdout.isTTY` — the stream the escapes would land on. */
  isTTY: boolean | undefined;
  env: ColorEnv;
}

export function colorEnabled({ isTTY, env }: ColorGateInput): boolean {
  const forced = env.FORCE_COLOR?.trim().toLowerCase();
  if (forced === "0" || forced === "false") return false;
  if (forced !== undefined && forced !== "") return true;

  // https://no-color.org — set to anything non-empty means plain output.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (!isTTY) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/** One SGR wrapper, resolved against the gate. */
type Paint = (s: string) => string;

export interface Palette {
  cyan: Paint;
  green: Paint;
  yellow: Paint;
  red: Paint;
  dim: Paint;
  bold: Paint;
  /**
   * Whether anything is being painted at all.
   *
   * Callers use it for more than colour: the progress dots the login, earn and
   * purchase polls print are a terminal animation, and a column of them in a
   * redirected log is noise nobody asked for.
   */
  enabled: boolean;
}

const CODES = {
  cyan: "36",
  green: "32",
  yellow: "33",
  red: "31",
  dim: "2",
  bold: "1",
} as const;

const PLAIN: Paint = (s) => s;

export function palette(input: ColorGateInput): Palette {
  const on = colorEnabled(input);
  const paint = (code: string): Paint => (on ? (s) => `\u001b[${code}m${s}\u001b[0m` : PLAIN);
  return {
    cyan: paint(CODES.cyan),
    green: paint(CODES.green),
    yellow: paint(CODES.yellow),
    red: paint(CODES.red),
    dim: paint(CODES.dim),
    bold: paint(CODES.bold),
    enabled: on,
  };
}
