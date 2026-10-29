/**
 * Whether a booked line may be drawn as a link the person can click, and the
 * escape that makes it one.
 *
 * OSC 8 (`ESC ] 8 ; ; url BEL text ESC ] 8 ; ; BEL`) is understood by most
 * terminals people code in and printed as garbage by a few, so it is only sent
 * where the terminal says who it is and that one is known to understand it.
 * The list follows `supports-hyperlinks` (no new dependency for twenty lines).
 * Anything unknown gets the text without the link: a line nobody can click
 * still reads the same, and a row of escape bytes does not.
 *
 * The width is unaffected: ink measures a row with `string-width`, which
 * strips the sequence (checked against string-width 8, wrap-ansi 10,
 * slice-ansi 9 and @alcalzone/ansi-tokenize 0.3, and in a real frame by
 * `direct-sponsor-tui.test.tsx`), so a linked row is still exactly one row.
 *
 * Only ever around a booked line's text, and only with the gateway's own
 * click address (`/go?c=…`), which counts the click once and forwards it. The
 * advertiser's address never reaches the terminal.
 */

export interface HyperlinkEnv {
  FORCE_HYPERLINK?: string;
  CI?: string;
  TERM?: string;
  TERM_PROGRAM?: string;
  TERM_PROGRAM_VERSION?: string;
  WT_SESSION?: string;
  VTE_VERSION?: string;
  KITTY_WINDOW_ID?: string;
  KONSOLE_VERSION?: string;
}

/** `major.minor` from a version string, or [0, 0]. */
function version(v: string | undefined): [number, number] {
  const m = /^(\d+)(?:\.(\d+))?/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

const atLeast = (v: [number, number], major: number, minor: number) => v[0] > major || (v[0] === major && v[1] >= minor);

export function hyperlinksEnabled({ isTTY, env }: { isTTY: boolean | undefined; env: HyperlinkEnv }): boolean {
  const force = env.FORCE_HYPERLINK?.trim().toLowerCase();
  if (force !== undefined && force !== "") return !(force === "0" || force === "false");
  if (!isTTY) return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  if (env.TERM === "dumb") return false;
  if (env.WT_SESSION) return true;
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      return atLeast(version(env.TERM_PROGRAM_VERSION), 3, 1);
    case "WezTerm":
    case "ghostty":
      return true;
    case "vscode":
      return atLeast(version(env.TERM_PROGRAM_VERSION), 1, 72);
  }
  if (env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID) return true;
  if (env.KONSOLE_VERSION) return true;
  // VTE (GNOME Terminal and friends) from 0.50.1, written as 5001; 0.50.0 crashed on it.
  if (env.VTE_VERSION) return Number(env.VTE_VERSION) >= 5001;
  return false;
}

/** `text` as a link to `url`. The caller decides whether links are on. */
export function osc8(text: string, url: string): string {
  // The URL arrives from `parseDirectLines`, which has already parsed it; this
  // keeps a stray control byte out of the escape all the same.
  const safe = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return `\u001b]8;;${safe}\u0007${text}\u001b]8;;\u0007`;
}
