/**
 * Claude-Code-style welcome banner for the Clixad REPL: a rounded box with a
 * pixel-art duck mascot, in the brand mango yellow. Truecolor + half-block art,
 * so it needs a modern terminal (VS Code / Windows Terminal / iTerm — all fine).
 */
import { homedir } from "node:os";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

const MANGO = fg(245, 184, 65);
const TEXT = fg(232, 240, 251);
const MUTED = fg(150, 165, 195);
const FAINT = fg(95, 112, 148);

/** Pixel palette for the duck. */
const PAL: Record<string, [number, number, number] | undefined> = {
  Y: [245, 184, 65], // mango body
  y: [255, 210, 115], // highlight
  O: [226, 126, 42], // beak / feet
  k: [30, 26, 40], // eye
};

// 14×14 duck (each char = one pixel). Rendered 2 rows per line via half-blocks.
const DUCK = [
  "....yYYYY.....",
  "...yYYYYYY....",
  "..YYYYYYYYY...",
  "..YYYYYYkYY...",
  "..YYYYYYYYYOO.",
  "..YYYYYYYYYOO.",
  ".YYYYYYYYYYY..",
  "YYYYYYYYYYYYY.",
  "YYYYYYYYYYYYYY",
  "YYYYYYYYYYYYYY",
  ".YYYYYYYYYYYY.",
  "..YYYYYYYYYY..",
  "...OO....OO...",
  "..............",
];
const DUCK_W = 14;

/** Render the duck to ANSI lines (7 lines, each DUCK_W visible columns wide). */
function duckLines(): string[] {
  const lines: string[] = [];
  for (let row = 0; row < DUCK.length; row += 2) {
    const top = DUCK[row]!;
    const bot = DUCK[row + 1] ?? "..............";
    let out = "";
    for (let col = 0; col < DUCK_W; col++) {
      const t = PAL[top[col] ?? "."];
      const b = PAL[bot[col] ?? "."];
      if (t && b) out += fg(...t) + bg(...b) + "▀" + R;
      else if (t) out += fg(...t) + "▀" + R;
      else if (b) out += fg(...b) + "▄" + R;
      else out += " ";
    }
    lines.push(out);
  }
  return lines;
}

interface Cell {
  text: string; // rendered (may contain ANSI)
  w: number; // visible width
}
const cell = (text: string, w: number): Cell => ({ text, w });
const padTo = (c: Cell | undefined, width: number): string =>
  (c?.text ?? "") + " ".repeat(Math.max(0, width - (c?.w ?? 0)));
/**
 * Cut to `max` **columns**, ellipsis included in the budget.
 *
 * Column-wise rather than code-unit-wise because the results feed `centered()`,
 * which computes the padding that keeps the box's right-hand border in one
 * column: a `cwd` with CJK in it measured by `.length` would pad a row half as
 * wide as it draws and bend the frame.
 */
const truncate = (s: string, max: number): string =>
  stringWidth(s) > max ? sliceColumns(s, Math.max(0, max - 1)) + "…" : s;

function centered(rendered: string, visibleW: number, colW: number): Cell {
  const lead = Math.max(0, Math.floor((colW - visibleW) / 2));
  return cell(" ".repeat(lead) + rendered, lead + visibleW);
}

/**
 * The one-line tip under the duck.
 *
 * It used to be the model id, which the status line under the input box already
 * shows on every frame — a second, never-changing copy of a number the user is
 * looking at anyway. A tip is the same row spent on something they don't know
 * yet, and it rotates so a daily user isn't shown the same one forever.
 *
 * Keys are what you actually press; descriptions stay short enough to survive
 * `MIN_BANNER_WIDTH`, where the left column is 30 columns wide.
 */
export const BANNER_TIPS: { key: string; desc: string }[] = [
  { key: "/init", desc: "make a CLIXAD.md" },
  { key: "shift+tab", desc: "switch mode" },
  { key: "@file", desc: "add a file to context" },
  { key: "ctrl+o", desc: "expand tool output" },
  { key: "esc", desc: "stop the current turn" },
  { key: "/compact", desc: "free up context" },
  { key: "/earn", desc: "top up credits" },
  // Two things the agent can now do that nothing else on screen mentions: it
  // starts commands that outlive a turn, and it borrows tools from MCP servers.
  { key: "/bg", desc: "background commands" },
  { key: "/mcp", desc: "list MCP servers" },
];

/**
 * The mark that moves while the agent is working — Clixad's answer to Claude
 * Code's pulsing asterisk.
 *
 * That asterisk works because a star *is* a character family: ✳ ✶ ✻ ✽ are the
 * same mark at different weights, so one cell can breathe. A duck is not a
 * character family, and there is no way around that. Half-block pixel art was
 * tried at every size from three cells to four rows and the honest result is
 * that below the banner's 14×14 the duck stops being a duck and becomes a
 * yellow blob — recognisable only if you already know what it is meant to be.
 *
 * So the mark is an emoji, and the choice of *which* is a brand decision rather
 * than a naming one. `🦆` is the duck by name and a brown mallard by sight in
 * every system font — nothing to do with mango. `🐤` and `🐥` are a round yellow
 * body, an orange beak and a dark eye, which is exactly the palette the pixel
 * duck above is drawn from (`Y`, `O`, `k`). It reads as our duck; the codepoint's
 * name is not what anybody sees.
 *
 * Two frames, not more: side view and front view are the same bird turning to
 * look at you, which is the "moves a little bit" this is for. A longer cycle
 * (adding the hatching chick, say) tells a different story halfway through.
 */
export const DUCK_FRAMES = ["🐤", "🐥"];

/**
 * The fallback where an emoji cannot be drawn.
 *
 * A Linux virtual console and `TERM=dumb` genuinely cannot: there is no colour
 * emoji font behind them, and what arrives is a box or a gap. This is the
 * spinner that was there before, kept for exactly those two.
 */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Terminals that have no colour emoji font behind them. */
export function spinnerFrames(env: NodeJS.ProcessEnv = process.env): string[] {
  const term = env.TERM ?? "";
  return term === "linux" || term === "dumb" ? BRAILLE_FRAMES : DUCK_FRAMES;
}

/**
 * Ticks the working line spends on one frame.
 *
 * The clock next to it counts seconds, so it wants a fast tick; the duck does
 * not. At 120 ms a two-frame cycle is a strobe rather than a bird — this slows
 * the mark to a third of that without slowing the seconds down with it.
 */
export const SPINNER_TICKS_PER_FRAME = 3;

/** Which tip this launch shows. Explicit index for tests, random otherwise. */
export function bannerTip(index?: number): { key: string; desc: string } {
  const i = index ?? Math.floor(Math.random() * BANNER_TIPS.length);
  return BANNER_TIPS[((i % BANNER_TIPS.length) + BANNER_TIPS.length) % BANNER_TIPS.length]!;
}

export interface BannerOpts {
  name?: string;
  /** Signed up on the run that opened the REPL: greeted as new, not as back. */
  newAccount?: boolean;
  model: string;
  /** Undefined when the wallet could not be read; drawn as unavailable, never as 0. */
  balance: number | undefined;
  adsToday: number;
  /** Net USD earned today and the daily ceiling — the cap is on payout, not count. */
  earnedUsdToday: number;
  maxRewardUsd: number;
  cwd: string;
  version: string;
  /** Terminal width to fill; the box spans it edge to edge. */
  width?: number;
  /** Pin the rotating tip (tests); omitted, one is picked at random. */
  tipIndex?: number;
}

/** Below this the box no longer fits two columns — main.ts falls back to compactBanner. */
export const MIN_BANNER_WIDTH = 66;

/** The greeting: new accounts are welcomed, returning ones welcomed back. */
function greeting(opts: BannerOpts, nameWidth?: number): string {
  if (!opts.name) return "Welcome to Clixad!";
  const name = nameWidth === undefined ? opts.name : truncate(opts.name, nameWidth);
  return opts.newAccount ? `Welcome to Clixad, ${name}!` : `Welcome back, ${name}!`;
}

/** The wallet line: a figure when there is one, and a plain statement when not. */
function balanceLabel(opts: BannerOpts): string {
  return opts.balance === undefined ? "balance unavailable" : `${opts.balance.toLocaleString("en-US")} credits`;
}

/** "$0.42/$0.80 today" — kept short, it shares a row with the credit balance. */
function earnedLabel(opts: BannerOpts): string {
  return `$${opts.earnedUsdToday.toFixed(2)}/$${opts.maxRewardUsd.toFixed(2)} today`;
}
const RIGHT_MAX = 34; // the tips/wallet column stops growing; extra width goes to the duck

/** Build the full welcome banner as a multi-line string, `width` columns wide. */
export function welcomeBanner(opts: BannerOpts): string {
  const width = Math.max(MIN_BANNER_WIDTH, opts.width ?? MIN_BANNER_WIDTH);
  const inner = width - 7; // │ + " " + L + " │ " + R + " " + │
  const rightW = Math.min(RIGHT_MAX, Math.max(26, inner - 30));
  const leftW = inner - rightW;
  const cwd = opts.cwd.replace(homedir(), "~").replace(/\\/g, "/");
  // The name gets what the column has left after the greeting around it, capped
  // at 18 as before: "Welcome to Clixad, " is five columns longer than
  // "Welcome back, ", and at the minimum width the column is 30 wide.
  const welcome = greeting(opts, Math.max(1, Math.min(18, leftW - (opts.newAccount ? 20 : 15))));

  const duck = duckLines();
  const home = truncate(cwd, leftW);
  // The tip replaces what used to be a second copy of the model id; the desc is
  // trimmed to whatever is left of the column after "◆ " and the key.
  const hint = bannerTip(opts.tipIndex);
  const hintDesc = truncate(hint.desc, Math.max(1, leftW - 3 - hint.key.length));
  const left: Cell[] = [
    centered(BOLD + TEXT + welcome + R, welcome.length, leftW),
    cell("", 0),
    ...duck.map((d) => centered(d, DUCK_W, leftW)),
    cell("", 0),
    centered(
      MANGO + "◆ " + R + BOLD + TEXT + hint.key + R + FAINT + " " + hintDesc + R,
      2 + hint.key.length + 1 + hintDesc.length,
      leftW,
    ),
    centered(FAINT + home + R, home.length, leftW),
  ];

  const tip = (k: string, d: string): Cell =>
    cell(MANGO + k + R + FAINT + " " + d + R, k.length + 1 + d.length);
  const right: Cell[] = [
    cell(BOLD + MANGO + "Getting started" + R, 15),
    tip("/help", "commands"),
    tip("/model", "switch model"),
    tip("/earn", "earn credits"),
    tip("/wallet", "balance & ads"),
    cell("", 0),
    cell(BOLD + MANGO + "Wallet" + R, 6),
    cell(TEXT + balanceLabel(opts) + R, balanceLabel(opts).length),
    // Without a wallet there is no earned figure either, and "$0.00/$0.00" is
    // two invented numbers rather than a statement of what is unknown.
    opts.balance === undefined ? cell("", 0) : cell(MUTED + earnedLabel(opts) + R, earnedLabel(opts).length),
  ];

  const rows = Math.max(left.length, right.length);
  const out: string[] = [];

  const label = `Clixad ${opts.version}`;
  const topPrefixLen = 3 + label.length + 1; // "╭─ " + label + " "
  const topDashes = width - topPrefixLen - 1; // minus closing ╮
  out.push(MANGO + `╭─ ${BOLD}${label}${R}${MANGO} ` + "─".repeat(Math.max(0, topDashes)) + "╮" + R);

  for (let i = 0; i < rows; i++) {
    const l = padTo(left[i], leftW);
    const r = padTo(right[i], rightW);
    out.push(`${MANGO}│${R} ${l} ${MANGO}│${R} ${r} ${MANGO}│${R}`);
  }

  out.push(MANGO + "╰" + "─".repeat(width - 2) + "╯" + R);
  return out.join("\n");
}

/**
 * Compact fallback for narrow terminals: duck + one-liner, no box.
 *
 * It used to ignore `width` entirely, which made it the *wrong* fallback: its
 * tip-and-balance row runs to about 45 columns, so at 40 or 30 it wrapped and
 * the banner the narrow path exists to provide was itself broken. Both text
 * rows are now cut to the width; the duck is 16 columns including its indent
 * and is left alone, since a clipped duck is worse than no duck.
 */
export function compactBanner(opts: BannerOpts): string {
  const width = Math.max(1, opts.width ?? MIN_BANNER_WIDTH);
  const welcome = truncate(greeting(opts), Math.max(1, width - 2));
  const hint = bannerTip(opts.tipIndex);
  const balance = balanceLabel(opts);
  // "  ◆ " + key + " " + desc + "  · " + balance
  const room = width - (4 + stringWidth(hint.key) + 1 + 4 + stringWidth(balance));
  // `truncate` spends its last column on the ellipsis, so a budget of one or
  // zero yields "…" — a description that is nothing but a mark saying there was
  // one. Below three columns the description is dropped instead.
  const desc = room >= 3 ? truncate(hint.desc, room) : "";
  const tipRow = desc
    ? `  ${MANGO}◆${R} ${BOLD}${TEXT}${hint.key}${R} ${FAINT}${desc}${R}  ${FAINT}·${R} ${balance}`
    : truncate(`  ${MANGO}◆${R} ${BOLD}${TEXT}${hint.key}${R}  ${FAINT}·${R} ${balance}`, width);
  // The duck is 14 columns plus a two-column indent. Narrower than that it is
  // not a duck, it is a wrapped smear across three rows.
  const duck = width >= DUCK_W + 2 ? duckLines().map((d) => "  " + d).join("\n") + "\n\n" : "";
  return `${duck}  ${BOLD}${TEXT}${welcome}${R}\n${tipRow}\n`;
}

/**
 * Start on a clean screen: whatever was in the terminal (shell prompt, npm's
 * `> tsx …` lines) is pushed out of view and the cursor homed, so the banner is
 * the first thing you see.
 *
 * Erase escapes alone are not enough — VS Code's terminal on Windows ignores
 * them in this position, which left the npm output visible. Printing a screenful
 * of newlines first is the part that always works (it simply scrolls), and the
 * erase sequences then clean up on terminals that do honour them.
 *
 * The gate is **stdout only**, which is a change: it used to pass whenever
 * *either* stream was a terminal, on the reasoning that a TTY stdin means
 * somebody is watching even if npm handed us a piped stdout. It does not
 * follow, and the cost of being wrong is forty newlines and a clear-screen
 * sequence written into a file — `clixad > log.txt` from an interactive shell
 * hit exactly that. This is `title.ts`'s rule for `title.ts`'s reason: an
 * escape in a redirected stream is corruption in a log. Nothing is lost when
 * the check refuses, either, because a piped stdout is one ink renders
 * non-interactively anyway.
 */
export function clearScreen(out: Pick<NodeJS.WriteStream, "isTTY" | "write" | "rows"> = process.stdout): void {
  if (!out.isTTY) return;
  out.write("\n".repeat(out.rows ?? 40));
  out.write("\x1b[2J\x1b[3J\x1b[H\x1b[0f");
}

/**
 * How many terminal **columns** a string occupies, ANSI escapes ignored.
 *
 * This is the measurement the whole layout stands on — `lineCount`, `tailRows`
 * and `headRows` in `tui/views.tsx` all reduce to it, and `app.tsx` hands out
 * the rows of the bottom region against what they report. It used to be
 * `.replace(ansi, "").length`, i.e. a count of UTF-16 code units, which is the
 * right answer only for ASCII:
 *
 *   - a CJK or fullwidth character is one code unit and **two** columns, so a
 *     line of Chinese measured half its true height;
 *   - `✅` `❌` `⭐` are one code unit and two columns (East Asian Wide), and
 *     models emit them constantly;
 *   - a ZWJ sequence (`👨‍👩‍👧`) is eight code units and two columns, and a
 *     regional-indicator flag is four and two;
 *   - a combining mark adds a code unit and no column at all.
 *
 * Undercounting is the direction that breaks the screen: the budget then keeps
 * more rows than fit, the bottom region grows past the viewport, and ink falls
 * back to clearing the terminal and replaying every static line of the session
 * — the exact failure `views.tsx` was written to prevent, reopened for any
 * answer that is not plain ASCII. Measured at 80x20, streaming one reply:
 * ASCII triggered that fallback once, the same reply in Chinese eleven times.
 *
 * `string-width` is **ink's own** measurement — `wrap-ansi` and `widest-line`,
 * which decide where ink actually wraps, both reduce to it — so using it here
 * makes our arithmetic agree with the layout by construction rather than by
 * coincidence. It is already installed as ink's dependency and is deduped, so
 * naming it in `package.json` adds no install weight; it is named there anyway
 * because `build.mjs` marks every bare specifier external, and a bundle may
 * only import what npm will actually install.
 */
export function visibleLength(s: string): number {
  return stringWidth(s);
}

/**
 * The first `columns` terminal columns of a string, ANSI kept intact.
 *
 * Two things a `String.prototype.slice` cannot do, both of which showed up as
 * bugs. It counted escape bytes as visible width, so a coloured diff line
 * clipped to eighty columns kept seventy-five characters of text and the five
 * that a `\x1b[31m` costs; and it cut wherever the index landed, which for a
 * colour span means the **closing** `\x1b[0m` is dropped and the colour bleeds
 * down the frame into whatever is drawn under it.
 *
 * `slice-ansi` indexes in columns, re-emits the styles that were open at the
 * cut and closes them at the end, and refuses to split a double-width
 * character down the middle. It is ink's own dependency, like `string-width`.
 */
export function sliceColumns(s: string, columns: number): string {
  if (columns <= 0) return "";
  return stringWidth(s) <= columns ? s : sliceAnsi(s, 0, columns);
}


