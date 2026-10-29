/**
 * When the sponsored line may be drawn, and what it looks like when it is.
 *
 * Both halves are pure functions taking their world as arguments rather than
 * reading `process` — not for elegance, but because "renders nothing when
 * piped" is a claim that has to be *tested*, and a module that reaches for
 * `process.stdout.isTTY` at import time can only be tested by lying to the
 * process.
 *
 * ## The off-by-default cases matter more than the on case
 *
 * This line must never reach a file. A CLI that writes marketing into a log,
 * a CI transcript or the left-hand side of a pipe has stopped being a tool and
 * started being spam, and unlike a terminal nobody is there to read past it.
 * So the gate is *deny*-shaped: it takes a specific TTY, a specific absence of
 * NO_COLOR and CI, and a config that has not turned it off. Anything it is
 * unsure about renders nothing.
 *
 * `NO_COLOR` is honoured even though the line is not colour: the convention
 * (https://no-color.org) is a request for plain, unadorned output, and a dim
 * decorative line pinned to the bottom of the screen is precisely the adornment
 * being declined. Treating it as "no ANSI colours, but keep the extras" is the
 * reading that makes the flag useless.
 */

import { sliceColumns, visibleLength } from "../banner.ts";
import { colorEnabled, type ColorEnv } from "../color.ts";
import type { AdFormat } from "./formats.ts";

/** The environment bits the gate consults. Passed in so tests can vary them. */
export interface SponsorEnv {
  NO_COLOR?: string;
  CI?: string;
  CLIXAD_SPONSOR?: string;
  TERM?: string;
}

export interface SponsorGateInput {
  /** `process.stdout.isTTY` — the stream the line would land on. */
  isTTY: boolean | undefined;
  env: SponsorEnv;
  /** `config.sponsor` from ~/.clixad/config.json. Absent means the default, on. */
  configEnabled?: boolean;
}

/**
 * Whether anything may be drawn at all.
 *
 * The env var wins over the config file, matching `CLIXAD_GATEWAY_URL` and the
 * rest of `ENV_OVERRIDES` in `config.ts`: the file is the standing preference,
 * the variable is the one-off. Both directions work — `CLIXAD_SPONSOR=1` turns
 * it back on for one run without editing the file — but only the off direction
 * is documented as load-bearing.
 */
export function sponsorEnabled({ isTTY, env, configEnabled }: SponsorGateInput): boolean {
  // An explicit env var settles it either way, before anything else.
  const flag = env.CLIXAD_SPONSOR?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  const forced = flag === "1" || flag === "true" || flag === "on" || flag === "yes";

  // Not a terminal: piped, redirected, or captured. Nothing, ever — and this
  // one is checked before `forced`, because `CLIXAD_SPONSOR=1` exported into a
  // shell months ago must not be what puts a line into somebody's build log.
  if (!isTTY) return false;
  if (env.TERM === "dumb") return false;

  // Everything below is a preference, and an explicit `CLIXAD_SPONSOR=1` is a
  // more specific one than any of them.
  if (forced) return true;

  if (configEnabled === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  // CI is set by every major runner. A CI job that somehow has a TTY (a pty
  // allocated by the runner, `script -c`, a docker -t step) is still not a
  // person watching a screen.
  if (env.CI !== undefined && env.CI !== "") return false;

  return true;
}

/** The mark itself, which every row of this slot wears whatever else it says. */
export const SPONSOR_SIGIL = "✦";
/** How the line names itself, so it can never be mistaken for model output. */
export const SPONSOR_MARKER = `${SPONSOR_SIGIL} clixad ·`;

/**
 * Where a line came from, which is the only thing that decides whether it is
 * labelled as advertising.
 *
 * It is deliberately not derived from anything about the line itself. A house
 * line that happened to read like an advertisement would still be ours, and an
 * ad whose copy reads like a usage tip is still an ad — so the label follows
 * the source, never the text and never the position in the rotation.
 */
export type SponsorOrigin = "house" | "network";

/**
 * What an advertisement is marked with, ahead of its text.
 *
 * **Ahead of it**, because the point of the mark is to be read before the thing
 * it qualifies: a label at the end of the row tells you what you have already
 * finished reading. It is two columns plus its separator, and those five
 * columns come out of the space the ad copy gets — see `sponsorRow`.
 */
export const AD_LABEL = "Ad";

/** The rendered pieces of the line, each carrying its own spacing. */
export interface SponsorRow {
  /** `"  ✦ clixad · "` — ours, on every line, house or not. */
  marker: string;
  /** `"Ad · "` on an advertisement, `null` on our own content. Never truncated. */
  label: string | null;
  /** The line itself, cut to whatever the two above left. */
  body: string;
  /** Which of the two this is, so the renderer knows what to colour. */
  origin: SponsorOrigin;
}

const INDENT = "  ";
/** `"  ✦ clixad · "` — 13 columns. What every house line wears, unchanged. */
const HOUSE_MARKER_ROW = `${INDENT}${SPONSOR_MARKER} `;
/**
 * `"  ✦ "` — 4 columns. The same mark with our name taken off it.
 *
 * Used on an advertisement, and only where the name would cost the copy more
 * than it is worth. The `✦` is the part that carries the meaning — it says the
 * row is the tool's chrome and not the model talking — and it sits in the same
 * column, at the same indent, as the house lines the same session keeps showing
 * with the name spelled out. The name is what is dropped, never the mark.
 */
const AD_MARKER_ROW = `${INDENT}${SPONSOR_SIGIL} `;
/** `"Ad · "` — 5 columns, and they are not free. */
const LABEL_ROW = `${AD_LABEL} · `;
/**
 * Below this a house line is all chrome and no message.
 *
 * Advertisements are held to a much higher bar (`AD_MIN_COLS`), so this only
 * ever governs our own content — which is the right asymmetry: a usage tip cut
 * short still tells you a command exists, and nobody is billed for it.
 */
const MIN_BODY_COLS = 12;

/**
 * A short advertisement written for a one-line slot, in columns.
 *
 * **This is the one measured number the two thresholds below are derived
 * from**, rather than a round figure chosen because it looks like one. A short
 * ad in this format is a brand, a colon or dash, and a proposition of four or
 * five words, and the two samples the tests use (`Globex: plan sprints in 5
 * min` and `Acme Deploys — ship on Friday`) are 29 columns each. That is
 * evidence from two samples and a shape, not from a distribution; it is a
 * constant so that widening it is one edit when a real corpus turns up.
 */
const SHORT_AD_COLS = 29;

/**
 * The narrowest terminal an advertisement is served into at all.
 *
 * Below it nothing is fetched, so nothing is billed — see `adFitsWidth`, and
 * `network.ts`, which refuses the serve rather than the render. The number is
 * `SHORT_AD_COLS` plus the shortest prefix that still carries the disclosure:
 * at exactly this width a short ad renders **whole**, and one column less is
 * where the corpus stops producing a complete line at any length and the worst
 * case ends on half a word. That is also the standard the old layout failed —
 * at 40 columns it left `Nimbus: catch the err…`, a brand and a fragment.
 */
export const AD_MIN_COLS = visibleLength(AD_MARKER_ROW) + visibleLength(LABEL_ROW) + SHORT_AD_COLS;

/**
 * The narrowest terminal that still gets our name on an advertisement.
 *
 * The same rule with the long prefix: our name stays while it costs the copy
 * nothing — while a short ad still renders whole beside it — and goes as soon
 * as it would start eating the proposition. Above this the row reads
 * `✦ clixad · Ad · …`; between this and `AD_MIN_COLS` it reads `✦ Ad · …` and
 * the copy is nine columns better off.
 */
export const AD_FULL_PREFIX_MIN_COLS =
  visibleLength(HOUSE_MARKER_ROW) + visibleLength(LABEL_ROW) + SHORT_AD_COLS;

/**
 * Whether an advertisement may be *fetched* for a terminal this wide.
 *
 * The check belongs before the network call and not after it. A serve is the
 * billable event on ADtention's side, so an ad fetched into a terminal too
 * narrow to show it is an impression an advertiser pays for and nobody reads —
 * which is the one thing a slot like this must not manufacture. `network.ts`
 * calls it inside `serve()` so that no caller can route around it.
 */
export function adFitsWidth(cols: number): boolean {
  return cols >= AD_MIN_COLS;
}

/**
 * The sidebar card: a rule, then the copy, `SIDEBAR_BODY_COLS` wide.
 *
 * Nine columns wider than a short ad (`SHORT_AD_COLS`) — the same nine the top
 * bar gains when it drops our name — so the copy the format produces renders
 * whole with a longer proposition's worth of room to spare, and anything longer
 * is cut rather than wrapped onto a third row the layout never counted.
 */
const SIDEBAR_BODY_COLS = SHORT_AD_COLS + 9;
/** `"│ "` — what separates the card from the working line beside it. */
const SIDEBAR_RULE = "│ ";
/** The card's whole width: the rule and the copy. */
export const SIDEBAR_CARD_COLS = visibleLength(SIDEBAR_RULE) + SIDEBAR_BODY_COLS;

/**
 * The narrowest terminal a sidebar card is served into.
 *
 * The card shares its rows with the working line — the one row on screen that
 * says "esc to stop" — so the terminal has to hold the card and still leave the
 * working line room to be read at a glance. Fifty columns is that room: the
 * line during a model call is about thirty (`working… 12s · esc to stop` and
 * the duck), and the rest keeps the two from reading as one sentence. So 90,
 * and on the 80-column terminal most people never resize there is no card at
 * all. That is the intended outcome, not a gap: the card is the format that
 * costs the most attention, and it is the one that gives way first.
 */
export const SIDEBAR_MIN_COLS = 50 + SIDEBAR_CARD_COLS;

/**
 * Whether an advertisement in `format` may be *fetched* for a terminal this wide.
 *
 * `adFitsWidth`'s rule per format, for its reason: a serve is the billable
 * event, so the width is refused before the network is asked, never after. The
 * top bar and the status bar are both one row of `sponsorRow`, so they share its
 * floor; the card has its own.
 */
export function adFitsFormat(format: AdFormat, cols: number): boolean {
  return format === "sidebar_card" ? cols >= SIDEBAR_MIN_COLS : adFitsWidth(cols);
}

/** The two rows of a sidebar card, in pieces for the renderer to colour. */
export interface SidebarCard {
  /** `"│ "`, at the start of both rows. */
  rule: string;
  /** `"✦ Ad"` — the whole of the first row after the rule. Never cut. */
  label: string;
  /** The copy, cut to the card's width — the whole of the second row. */
  body: string;
}

/**
 * The card for a served line, or `null` where there is no room for one.
 *
 * **The mark is a row of its own, above the copy**, which is the top bar's
 * "ahead of the thing it qualifies" in a card's shape: the first thing read in
 * the card is that it is an advertisement. It is a network-only format — there
 * is no house card — so there is no `origin` to pass: everything drawn here is
 * somebody else's copy and is marked as such.
 *
 * Exactly two rows, whatever the copy: the layout puts them beside two rows it
 * has already counted, and a third would be a row nobody counted.
 */
export function sidebarCard(line: string, cols: number): SidebarCard | null {
  if (!adFitsFormat("sidebar_card", cols)) return null;
  const text = line.trim();
  if (!text) return null;
  const body =
    visibleLength(text) <= SIDEBAR_BODY_COLS ? text : `${sliceColumns(text, SIDEBAR_BODY_COLS - 1).trimEnd()}…`;
  return { rule: SIDEBAR_RULE, label: `${SPONSOR_SIGIL} ${AD_LABEL}`, body };
}

/**
 * The finished line, in pieces, truncated to the terminal width — never wrapped.
 *
 * Wrapping is the failure mode this guards against, not an aesthetic
 * preference: the TUI pins the input box to the bottom of the screen by
 * measuring the height of everything above it (`entryHeight` / `lineCount` in
 * `tui/views.tsx`), and `chromeHeight` counts this as exactly one row. A line
 * that silently became two would push the box off by one and keep pushing.
 * One row in, one row out.
 *
 * It returns pieces rather than a string because they are coloured
 * differently and the colours belong to the renderer, not here — the same
 * split as `MODE_LABEL` in `permissions.ts` against `MODE_STYLE` in
 * `views.tsx`. What stays here is the arithmetic, so there is one place that
 * knows how wide the row is.
 *
 * `origin` is required and has no default. A default would be a way for an
 * advertisement to arrive unlabelled through a call site somebody forgot to
 * update, and that is the one mistake this function exists to make impossible.
 *
 * Returns `null` when there is no row to draw: for our own content, when the
 * terminal is too narrow to say anything useful; for an advertisement, at the
 * much earlier point where it would stop being worth an impression.
 */
export function sponsorRow(line: string, cols: number, origin: SponsorOrigin): SponsorRow | null {
  const marker =
    origin === "house" || cols >= AD_FULL_PREFIX_MIN_COLS ? HOUSE_MARKER_ROW : AD_MARKER_ROW;
  const label = origin === "network" ? LABEL_ROW : null;

  // An advertisement is refused on width before anything else, and by the same
  // predicate the serve is refused by — so a row that could not have been
  // fetched cannot be drawn either, whichever side asks first.
  if (origin === "network" && !adFitsWidth(cols)) return null;

  const room = cols - visibleLength(marker) - (label ? visibleLength(label) : 0);
  if (room < MIN_BODY_COLS) return null;

  // Measured and cut in **columns**. It used to be `.length`, which is the
  // number of UTF-16 code units — the right answer only for ASCII. The house
  // inventory is ASCII, but a served line is somebody else's copy: a line of
  // CJK measured that way came back at 141 columns for an 80-column terminal,
  // wrapped onto a second row, and broke the one promise this function makes.
  const body = visibleLength(line) <= room ? line : `${sliceColumns(line, room - 1).trimEnd()}…`;
  return { marker, label, body, origin };
}

/** The same row as one plain string — no colour, for measuring and for tests. */
export function joinSponsorRow(row: SponsorRow): string {
  return `${row.marker}${row.label ?? ""}${row.body}`;
}

/**
 * The finished line as one plain string, or `null`.
 *
 * A convenience over `sponsorRow`, and the shape every test measures, so that
 * "one row in, one row out" is asserted against the thing that is drawn rather
 * than against a second implementation of it.
 */
export function sponsorText(line: string, cols: number, origin: SponsorOrigin): string | null {
  const row = sponsorRow(line, cols, origin);
  return row && joinSponsorRow(row);
}

/**
 * Whether the advertisement may wear its colour.
 *
 * `colorEnabled` decides it almost entirely — a pipe, a redirect, `NO_COLOR`,
 * `TERM=dumb`, `FORCE_COLOR` either way — and this adds `CI` on top, which
 * `color.ts` deliberately does not consult. The asymmetry is the one already
 * written down there: a build log with coloured diagnostics in it is useful,
 * and a build log with a coloured advertisement in it is not.
 *
 * It is reachable at all only because `CLIXAD_SPONSOR=1` overrides the
 * preference half of `sponsorEnabled` — the sponsored line is otherwise
 * already silent under `NO_COLOR` and under `CI`. With the colour refused the
 * row still renders, and still carries its label: the mark is information, not
 * decoration, and it is the last thing that may be dropped.
 */
export interface AdColorGateInput {
  /** `stdout.isTTY` — the stream the escapes would land on. */
  isTTY: boolean | undefined;
  /**
   * Everything both gates read.
   *
   * Spelled out rather than reusing `SponsorEnv`: that type belongs to
   * `sponsorEnabled`, which genuinely does not consult `FORCE_COLOR`, and
   * widening it would make it claim otherwise. A gate's input type is a list of
   * what the gate looks at.
   */
  env: ColorEnv & Pick<SponsorEnv, "CI">;
}

export function adColorEnabled({ isTTY, env }: AdColorGateInput): boolean {
  if (!colorEnabled({ isTTY, env })) return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  return true;
}
