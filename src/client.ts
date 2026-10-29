/**
 * Thin client for the Clixad gateway. This is the ONLY thing the CLI needs to
 * talk to — auth, model catalog, wallet, ads, and metered completions all go
 * through the gateway's OpenAI-compatible surface.
 */
import { gzipSync } from "node:zlib";
import type { CliConfig } from "./config.ts";
import { parseTaskShape, type TaskShape } from "./estimate.ts";
import { EXTRA_AD_FORMATS, type AdFormat, type ExtraAdFormat } from "./sponsor/formats.ts";
import { parseDirectLines, type DirectAnswer } from "./sponsor/direct.ts";
import {
  EdgeBlockedError,
  EdgeOutageError,
  OUTAGE_RETRIES,
  detectEdgeBlock,
  detectEdgeOutage,
  edgeBlockSummary,
  isOutageStatus,
  outageWaitMs,
  outageWaitNotice,
  type OutageResends,
  peek,
  safeDetail,
  type EdgeBlock,
} from "./edge.ts";

/**
 * The content type that carries a gzipped chat body.
 *
 * The gateway declares the same string. This program keeps its own copy because
 * the published bundle may import nothing but npm packages, and a test that can
 * see both holds the two together, the same deal the duck logo and the model
 * catalog live under.
 *
 * Vendor-specific rather than `application/gzip`, because it is not a generic
 * archive: it is one request body, in one encoding, on one route. The encoding
 * is named in the content type rather than in `Content-Encoding`, because it is
 * a second representation of the request that only this route accepts, not a
 * transfer detail for anything on the way to decode.
 */
export const CHAT_ENCODED_CONTENT_TYPE = "application/vnd.clixad.chat+gzip";

/**
 * The same request body, gzipped.
 *
 * Used only after something in front of the gateway has refused the plain JSON
 * body, which happens to legitimate requests: a conversation about code can
 * quote `../../../etc/passwd` or an SQL injection string, and a filter that
 * looks for such text in request bodies takes it for an attack. The compressed
 * body is the same conversation in an encoding that filter does not read as
 * text.
 *
 * This is never the first thing tried. See `postChat`.
 */
export function encodeChatBody(json: string): Uint8Array {
  return gzipSync(Buffer.from(json, "utf8"));
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  tier: string;
  ad_fundable: boolean;
  /** Context window in tokens; the REPL compacts before it fills up. */
  context_window?: number;
  credits_per_mtoken_input: number;
  credits_per_mtoken_output: number;
  est_credits_per_task: number;
  est_ads_per_task: number;
  /**
   * Whether the free tier's daily allowance may be spent on this model.
   *
   * Optional, and every reader treats it as such: a gateway older than the free
   * tier sends nothing, and "this deployment has no free tier" is what absent
   * has to mean — a client that defaulted it to `true` would advertise free
   * models on a gateway that charges for every one of them.
   */
  free?: boolean;
  /**
   * The `/effort` settings this model takes, cheapest first. Empty: nothing to
   * set. Absent: a gateway older than the setting, which is treated the same,
   * since a setting that gateway would ignore is not one to offer.
   */
  efforts?: string[];
  /** What the model runs at with no setting: a level, or "on" when it has none to name. */
  default_effort?: string;
  /**
   * Which credits pay for this model: `budget` takes any credit, `premium`
   * only credits earned on the offer walls or bought, until the account has
   * bought credits once. Absent on a gateway older than the rule, which is
   * read as "no rule": nothing is marked, and nothing is locked.
   */
  access?: "budget" | "premium";
  /**
   * Whether auto mode is offered on this model (`autoMode` in the catalog).
   * Absent on a gateway older than the field, which is read as "not offered":
   * a mode that runs commands nobody approved is not one to switch on by guess.
   */
  auto_mode?: boolean;
}

/**
 * The column the `/model` picker and `clixad models` print beside a model id,
 * padded to one width: its class, and `locked` for a premium model this
 * account cannot use yet.
 *
 * Locked means the gateway said so: premium access read (`premium` from
 * `/v1/wallet?premium=1`), no purchase, and no earned credits at all. Unknown
 * is never locked, since marking a model this account may well be able to use
 * would be the worse mistake. A gateway that sends no `access` gets the tier,
 * which is what this column always showed.
 */
export function accessColumn(m: Pick<ModelInfo, "tier" | "access">, premium: PremiumAccess | undefined): string {
  if (m.access === undefined) return m.tier.padEnd(8);
  if (m.access === "budget") return "budget  ";
  return premiumLocked(premium) ? "locked  " : "premium ";
}

/** Whether premium models are closed to this account, as far as the gateway has said. */
export function premiumLocked(premium: PremiumAccess | undefined): boolean {
  return premium !== undefined && !premium.unlocked && premium.credits <= 0;
}

/**
 * "an offer-wall survey or $3 unlocks it": what a locked premium row says, from
 * the gateway's unlock price, and the survey alone where nothing can be bought.
 * "Offer-wall" because our own surveys pay bonus credits, which never reach a
 * premium model (2026-10-19).
 */
export function premiumUnlockHint(unlockUsd: number | null | undefined): string {
  return typeof unlockUsd === "number" && unlockUsd > 0
    ? `premium: an offer-wall survey or ${usd(unlockUsd)} unlocks it`
    : "premium: an offer-wall survey unlocks it";
}

/** The gateway's headline (`premiumUnlockHeadline`), rebuilt from the same figure. */
export function premiumHeadline(unlockUsd: number | null | undefined): string {
  return typeof unlockUsd === "number" && unlockUsd > 0
    ? `Premium: complete an offer-wall survey or buy credits from ${usd(unlockUsd)}.`
    : "Premium: complete an offer-wall survey to unlock it.";
}

/** 5 → "$5", 7.5 → "$7.50": a pack price as the premium hints quote it. */
export function usd(v: number): string {
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

/**
 * ", from $3": the cheapest pack, as the clause the paywall and the free-limit
 * notice put after `/buy`. Empty where the gateway did not say (an older one,
 * or one that sells nothing), which leaves the sentence as it always was.
 */
export function packsFromClause(cheapestUsd: number | null | undefined): string {
  return typeof cheapestUsd === "number" && cheapestUsd > 0 ? `, from ${usd(cheapestUsd)}` : "";
}

/**
 * What one call may spend right now, per kind of model, as the gateway worked
 * it out (2026-10-12): its earned credits plus what is left of today's limit on
 * bonus credits on a budget model, its earned credits plus what is left of the
 * login streak allowance on a premium one. Sent on `/v1/wallet?premium=1`, at
 * the end of every paid call and on every refusal, always beside the balance it
 * was worked out from. The status line shows the one for the model in use.
 *
 * Finished figures, `grantLabel`'s rule: `apps/cli` cannot import the rules,
 * and a copy of them here would be one nothing forces to agree.
 */
export interface Spendable {
  /** Credits one call on a budget model may spend. */
  budget: number;
  /** Credits one call on a premium model may spend. */
  premium: number;
  /** What `budget` becomes at 00:00 UTC if nothing is spent or granted before then. */
  budgetAfterReset: number;
}

/**
 * The gateway's `spendable` block, or undefined. Read defensively: a block
 * that is missing a figure is no block at all, because a usable figure made up
 * here would be the wrong number this exists to stop showing.
 */
export function parseSpendable(raw: unknown): Spendable | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!ok(r.budget) || !ok(r.premium) || !ok(r.budget_after_reset)) return undefined;
  return { budget: r.budget, premium: r.premium, budgetAfterReset: r.budget_after_reset };
}

/** What `/v1/wallet?premium=1` says about premium models for this account. */
export interface PremiumAccess {
  /** Premium models take every credit: the account bought before 2026-10-19. */
  unlocked: boolean;
  /** What a premium call may spend right now: credits from offers and purchases. */
  credits: number;
}

/**
 * "~18 ads/task on completion (median)": the effort estimate as the picker
 * shows it.
 *
 * Three things it must never do. It must not round down to "0 ads/task": the
 * estimate divides by a whole offer's payout, so a cheap model lands at 0.04 and
 * `toFixed(1)` prints `0`, which reads as free. Below one the honest floor is
 * "<1". It must say **on completion**, because the estimate assumes an offer
 * that actually credited, and a screenout is the normal case. And it must name
 * the median: the gateway divides by the median completed CPX offer, and the
 * offers somebody actually lands on pay well below and well above it.
 */
export function adsPerTaskLabel(estAdsPerTask: number): string {
  const effort = estAdsPerTask >= 1 ? `~${estAdsPerTask} ads/task` : "<1 ad/task";
  return `${effort} on completion (median)`;
}

/**
 * "~51,000 credits on completion (median)": every pre-completion earn figure.
 *
 * It takes `grant_per_ad`, which the gateway derives from the median completed
 * CPX offer in its ledger. One number stands in for a wall whose payouts spread
 * widely, so it may only appear with the median label; without it, a figure
 * next to a balance reads as what the next offer will pay. The gateway no longer
 * sends `grant_per_ad_range`, the advertised spread with no wall, count or date,
 * so a range is not an input here at all.
 *
 * `on completion` is part of the label, matching the landing page, the blog and
 * the clips. Never a bare `+N`: a plus sign in front of a figure the user has
 * not earned yet reads as a balance that is already on its way.
 */
export function grantLabel(grantPerAd: number | undefined): string {
  // No usable figure means no figure. Zero printed here would read as a payout.
  if (typeof grantPerAd !== "number" || !Number.isFinite(grantPerAd) || grantPerAd <= 0) {
    return "credits on completion";
  }
  return `~${grantPerAd.toLocaleString("en-US")} credits on completion (median)`;
}

/**
 * The login streak as one line, written once for the surfaces that draw it.
 *
 * Both the one-shot commands and the REPL show this, and they cannot share a
 * *rendered* string with colour in it — the subcommands use ANSI and the TUI uses
 * Ink — but they can and must share the wording and the arithmetic. Every figure
 * comes out of `streak.schedule`, which the gateway sent: nothing here is a
 * literal, for the reason `grantLabel` takes its figure as an argument.
 *
 * It says what happened, not merely where the streak is. `claimed` is the whole
 * distinction: the claim is idempotent per day and is called from three places,
 * so a line that announced a grant on every one of them would be announcing the
 * same 400 credits three times before breakfast.
 *
 * Returns `null` when there is nothing worth a row — an empty schedule means a
 * gateway that answered something we cannot render, and a silent streak is the
 * correct outcome there.
 */
export function streakLabel(streak: StreakInfo): string | null {
  if (streak.length <= 0 || streak.day <= 0) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  // The day is clamped to the ramp's length by the store, so somebody on their
  // fortieth consecutive day reads "day 7 of 7" — which is true of what they are
  // paid, and is the only number this program has been told.
  const where = `day ${streak.day} of ${streak.length}`;
  if (!streak.claimed) return `daily streak: ${where} · today's already counted`;
  // Tomorrow is the next rung, or the same one once the ramp has flattened —
  // read out of the schedule rather than assumed, so extending it needs no edit
  // here.
  const tomorrow = streak.schedule[Math.min(streak.day, streak.length - 1)];
  const next = tomorrow === undefined ? "" : ` · tomorrow ${n(tomorrow)}`;
  return `daily streak: ${where} · +${n(streak.credits)} credits${next}`;
}


/**
 * The referral summary as plain lines, written once for both surfaces that draw
 * it.
 *
 * `streakLabel`'s rule: the subcommand renders with ANSI and the REPL with Ink,
 * so what crosses this boundary is text and never a formatted string wearing one
 * surface's clothes. Every number comes out of what the gateway sent — the two
 * grant amounts included — because a figure typed into this program is a literal
 * nothing forces to agree with the engine.
 *
 * The **command to run is on its own line and says both halves of the deal**.
 * A code with no instructions is a code nobody passes on, and "you both get N"
 * is the part that makes somebody send it: the other person's bonus is not a
 * footnote to the sender's.
 *
 * It also states the condition rather than burying it. Nothing is paid until the
 * invited account has had an offerwall payout of its own, and a summary that
 * implied a signup was worth credits would be promising something this feature
 * deliberately does not do.
 */
export function referLines(info: ReferralInfo): string[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const lines = [
    `your code: ${info.code}`,
    `share it: clixad login --invite ${info.code}`,
    `you both get ${n(info.inviterCredits)} credits once they complete their first offer`,
  ];
  if (info.invited === 0) {
    // Said plainly rather than as three zeroes, which reads like a broken
    // command on the day somebody first runs it.
    lines.push("nobody has signed up with it yet");
    return lines;
  }
  const waiting = info.invited - info.credited;
  lines.push(
    `${n(info.invited)} signed up · ${n(info.credited)} completed an offer · ` +
      `${n(info.creditsEarned)} credits earned`,
  );
  if (waiting > 0) {
    // The normal case, not a failure: plenty of accounts sign up and never
    // finish an offer, and being screened out of one pays nothing.
    lines.push(`${n(waiting)} haven't completed an offer yet — that pays nothing until they do`);
  }
  if (info.remaining === 0 && info.maxCredited > 0) {
    lines.push(`you've been paid for the maximum of ${n(info.maxCredited)} referrals`);
  }
  return lines;
}

/**
 * A redeem outcome as a sentence, written once for both surfaces.
 *
 * `streakLabel`'s rule: the wording is shared and the colour is not. Each refusal
 * says what to do about it, because each of them has something different to do —
 * that is the entire reason the gateway reports five outcomes rather than a
 * boolean, and printing the raw status here would throw the distinction away
 * again on the last hop.
 *
 * `ok` is what a surface colours on. It is derived from the status rather than
 * from `credited`, so a code that somehow granted zero still reads as spent
 * rather than as an error.
 */
export function redeemMessage(result: RedeemResult): { ok: boolean; text: string } {
  switch (result.status) {
    case "redeemed":
      return { ok: true, text: `+${result.credited.toLocaleString("en-US")} credits` };
    case "used":
      return { ok: false, text: "that code has already been used" };
    case "expired":
      return { ok: false, text: "that code has expired" };
    case "wrong_account":
      // The one refusal with a fix that is not "check your typing": they may
      // simply be signed in as somebody else.
      return { ok: false, text: "that code belongs to a different account — check who you're signed in as" };
    default:
      return { ok: false, text: "that isn't a code we recognise — check it for typos" };
  }
}

/**
 * How each ledger reason reads to the person whose balance moved.
 *
 * The raw values are database enum labels (`ad_reversal`) and were printed as
 * such. `ad_reversal` is the one that matters: an ad network can charge a
 * conversion back long after the credits were granted, so a user sees credits
 * disappear with no action of their own — and a line item reading `ad_reversal`
 * next to `-40,000` explains nothing. It names the provider as the actor
 * because that is factually who reversed it; we neither chose it nor kept the
 * money.
 *
 * `ad_screenout_bonus` is the other one that has to say what it is. It is the
 * $0.01 CPX pays when somebody starts a survey and does not qualify, passed
 * through — about a fortieth of what finishing one pays. Labelled "offer reward"
 * it would read as payment for an offer the user knows they did not complete,
 * and next to a real reward in the same list it would make the two look like the
 * same kind of event.
 *
 * `ad_sponsor_impression` has the same problem in a sharper form: it is tens of
 * credits for a line that appeared above the input box while a model call ran,
 * which is the only entry in this list the user did nothing at all to cause. It
 * has to name the *thing that happened* — a sponsored line was shown — or a
 * small unexplained credit next to an offer reward reads as a rounding error in
 * the wallet.
 */
export const LEDGER_REASONS: Record<string, string> = {
  signup_bonus: "signup bonus",
  login_streak: "daily streak",
  feedback_bonus: "thanks for the feedback",
  referral_bonus: "referral bonus",
  redeem_code: "code redeemed",
  ad_reward: "offer reward",
  // Our own survey, and it is deliberately not called an offer. Every other
  // earn line on this list is a network paying for something; this one is us.
  // The name is the only place a user would ever learn the difference, and
  // "offer reward" would file it next to the wall it did not come from.
  own_survey_reward: "Clixad survey",
  ad_screenout_bonus: "screenout bonus (didn't qualify)",
  ad_sponsor_impression: "sponsored line shown",
  ad_reversal: "offer reward reversed by the provider",
  purchase: "credits purchased",
  usage: "model usage",
  refund: "refund",
};

/** A ledger reason as a human sentence fragment, falling back to the raw value. */
export function ledgerReasonLabel(reason: string): string {
  return LEDGER_REASONS[reason] ?? reason.replace(/_/g, " ");
}

/**
 * The parameters a session serves sponsored lines with, from
 * `GET /v1/sponsor/config`.
 *
 * The publisher id is here rather than in this program's source because a value
 * we fetch can be rotated without a release and stops being handed out the
 * moment an account is closed. The subject arrives already hashed by the
 * gateway, so the salt that scopes it never ships.
 *
 * `null` for "this gateway has no ad network", which is a supported state and
 * answers 200: the CLI keeps its own house inventory and has lost nothing.
 */
export interface SponsorConfigInfo {
  /** The top bar's publisher id. */
  publisherId: string;
  category?: string;
  subject?: string;
  dwellMs?: number;
  /**
   * The publisher id of every other format this gateway serves. Absent on a
   * gateway older than the formats, and without an entry for a format that is
   * switched off there — in both cases that slot is never served.
   */
  formats?: Partial<Record<ExtraAdFormat, string>>;
}

/**
 * The extra formats' publisher ids out of `/v1/sponsor/config`'s `formats`.
 *
 * Read defensively, row by row, for the paywall's `free_models` reason: a
 * malformed entry costs that format, never the top bar that every session
 * already serves. A format this build does not know is skipped — a newer
 * gateway may well have a fourth, and this CLI has nowhere to draw it.
 */
function extraFormatIds(raw: unknown): Partial<Record<ExtraAdFormat, string>> {
  const out: Partial<Record<ExtraAdFormat, string>> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const format of EXTRA_AD_FORMATS) {
    const entry = (raw as Record<string, unknown>)[format];
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>).publisher_id;
    if (typeof id === "string" && id.trim()) out[format] = id.trim();
  }
  return out;
}

/**
 * One impression, reported to `POST /v1/sponsor/impression`.
 *
 * Everything on it is what the SDK said, forwarded as it came. None of it is
 * trusted: the gateway decides what an impression is worth and whether to
 * credit it at all, so reporting `billable: false` honestly costs nothing.
 */
export interface ImpressionReport {
  impressionId: string;
  /**
   * The slot it was shown in. Absent means the top bar, which is what the
   * gateway reads a missing field as — so a top-bar report stays byte for byte
   * what every published CLI has always sent.
   */
  format?: AdFormat;
  adId?: string;
  billable: boolean;
  fromCache: boolean;
  credit: number;
}

/**
 * The login streak, as `POST /v1/streak/claim` answers it.
 *
 * The claim is idempotent per UTC day, so every surface that might be the first
 * thing a person touches today calls it and only one of them ever moves a
 * balance. `claimed` is what tells them apart: without it a CLI showing `day`
 * would announce a bonus on every command somebody typed.
 *
 * `schedule` carries the whole ramp because **no credit figure may originate in
 * this program**. It cannot import the gateway's pricing engine (the bundle
 * ships standalone through npm), so a number typed here is a literal nothing
 * forces to agree with the engine, which is the drift the sponsored line's `needs`
 * placeholders exist to prevent.
 */
/** The account's preferences as `/v1/account/settings` answers them. */
export interface AccountSettings {
  model: string | null;
  efforts: Record<string, string>;
  name: string | null;
  instructions: string | null;
  sponsorLine: boolean | null;
}

/** The settings body, field by field; anything malformed reads as unset. */
export function parseAccountSettings(body: unknown): AccountSettings | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const efforts: Record<string, string> = {};
  if (b.efforts && typeof b.efforts === "object" && !Array.isArray(b.efforts)) {
    for (const [k, v] of Object.entries(b.efforts as Record<string, unknown>)) if (typeof v === "string") efforts[k] = v;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    model: str(b.model),
    efforts,
    name: str(b.name),
    instructions: str(b.instructions),
    sponsorLine: typeof b.sponsor_line === "boolean" ? b.sponsor_line : null,
  };
}

export interface StreakInfo {
  /** Which day of the streak today is, 1-based and clamped to the ramp's length. */
  day: number;
  /** What this call granted. 0 on every call after the first one of the day. */
  credits: number;
  /** True when this call is what granted them — the only thing worth announcing. */
  claimed: boolean;
  balance: number;
  /** The whole ramp, so "tomorrow" can be quoted without a figure of our own. */
  schedule: number[];
  /** How many days the ramp distinguishes before it flattens. */
  length: number;
}

/**
 * One rating of one response, on its way to `POST /v1/feedback`.
 *
 * `session` and `turn` are the idempotency key and both come from here, because
 * the CLI is the only thing that knows which turn a rating is about. That is not
 * a security boundary: the fence against a client inventing them is the gateway's
 * daily credit ceiling. What the key buys is that a retry after a dropped
 * connection neither pays twice nor stores the same exchange twice.
 *
 * The prompt and the response travel because the point of collecting this is an
 * eval set, and an eval needs the input and the output. They are cut to length by
 * the gateway, which states where it cut.
 */
export interface FeedbackReport {
  session: string;
  turn: number;
  rating: "up" | "down";
  model: string;
  prompt: string;
  response: string;
  steps?: number;
  /**
   * Whether the free tier paid for the rated turn.
   *
   * Sent because the gateway cannot know it — it does not record which turn a
   * rating is about, deliberately — and it is safe to send because it can only
   * ever **lower** the grant: `true` pays the reduced share, absent pays the
   * full amount. A client lying about it only pays itself less.
   *
   * Omitted rather than sent as `false` on a paid turn, so the body an older
   * gateway sees is byte-for-byte the one it has always seen.
   */
  free?: boolean;
}

/** What the gateway did with a rating. */
export interface FeedbackOutcome {
  /** False on a replay of a turn already rated — the first answer stands. */
  recorded: boolean;
  /** Credits granted. 0 on a replay and 0 past the day's ceiling. */
  credited: number;
  balance: number;
}

/**
 * An account's referral standing, from `GET /v1/referrals`.
 *
 * Every figure on it is the gateway's, including the two grant amounts, because
 * this program cannot import the gateway's pricing engine: the bundle ships
 * standalone through npm. `referLines` is the one place they are turned into
 * sentences.
 *
 * `invited` and `credited` are deliberately separate. Most of the gap between
 * them is the ordinary case rather than a failure: nothing is paid until the
 * invited account has had an offerwall payout of its own, and plenty of accounts
 * sign up and never finish an offer. A surface that showed only `credited` would
 * make a working referral look like a broken one for however long that takes.
 */
export interface ReferralInfo {
  code: string;
  invited: number;
  credited: number;
  creditsEarned: number;
  remaining: number;
  maxCredited: number;
  inviterCredits: number;
  inviteeCredits: number;
}

/**
 * What the gateway did with a redeem code.
 *
 * Five outcomes, because four of them are things somebody can act on: retype it,
 * check which account they are signed in as, or accept that it is spent. The CLI
 * turns each into a sentence (`redeemMessage`) rather than printing the status,
 * which is a database word.
 */
export type RedeemStatus = "redeemed" | "unknown" | "used" | "expired" | "wrong_account";

export interface RedeemResult {
  status: RedeemStatus;
  /** Credits granted. 0 on every status but `redeemed`. */
  credited: number;
  balance: number;
}

export interface WalletInfo {
  balance: number;
  ads_today: number;
  /** Net USD today's earn events paid us — the daily cap is on this, not on count. */
  earned_usd_today: number;
  /**
   * Attempts that screened out and paid a bonus today, and what they granted.
   * Absent on a gateway older than the screenout bonus, which is why every
   * reader treats them as optional rather than defaulting them to 0 — a missing
   * field is "this gateway does not know", not "none today".
   */
  screenouts_today?: number;
  screenout_credits_today?: number;
  max_reward_usd_per_day: number;
  /**
   * What the median completed CPX offer credits, printed only through
   * `grantLabel`. A gateway deployed before 2026-09-15 also sent
   * `grant_per_ad_range`, the advertised spread, which is not read.
   */
  grant_per_ad: number;
  /**
   * What the grants with no counterparty pay on this deployment.
   *
   * Optional, and every reader treats it as such: a gateway older than the field
   * sends nothing, and "this deployment pays nothing" is a different statement
   * from "this deployment did not say". The feedback prompt drops its figure
   * rather than inventing one, which is the same rule the sponsored line's
   * unresolvable `needs` placeholders follow.
   */
  rewards?: {
    feedback_credits?: number;
    /** What a rating pays when the free tier paid for the turn. */
    feedback_credits_free?: number;
    feedback_max_credits_per_day?: number;
  };
  /**
   * What is left of this account's free allowance today, and what it buys.
   *
   * `turns_left` is computed by the **gateway**, per model, and arrives
   * finished. This program cannot import the gateway's pricing engine (the
   * bundle ships standalone through npm), so a turn count divided out here would be a figure
   * nothing forces to agree with what the gateway meters. Same rule as
   * `grantLabel` taking its figure as an argument and `streakLabel` reading
   * its schedule off the response.
   *
   * A map rather than one number because that is the whole point of the model
   * list: the same allowance is roughly thirty turns on the cheapest model and
   * three on the dearest one in the set, and the picker exists to show it.
   *
   * Absent on an older gateway, and on a paused tier it arrives with
   * `credits_left: 0` and every estimate 0 — so there is no state where a reader
   * has to combine two fields to decide whether it may say "free".
   */
  free_tier?: {
    models: string[];
    daily_credits: number;
    credits_left: number;
    turns_left: Record<string, number>;
    /**
     * The free model worth naming, the one new accounts start on. Absent on an
     * older gateway, where the notices fall back to the model in use or the
     * first one with turns left.
     */
    recommended?: string;
  };
  /**
   * Whether premium models are open to this account. Sent only when asked for
   * (`wallet({ premium: true })`), and absent on an older gateway or when the
   * ledger could not be read, which every reader treats as unknown.
   */
  premium?: PremiumAccess;
  /** The wire form of `Spendable`, sent beside `premium`; read it with `parseSpendable`. */
  spendable?: unknown;
  ledger: { delta: number; reason: string; balanceAfter: number; ts: number }[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * What a gateway deployment can do, over and above serving models.
 *
 * Only search so far, and it is here because it is the one integration whose
 * absence should change the *tool schema* rather than produce an error at call
 * time — a tool advertised on every model call is paid for on every model call.
 */
export interface GatewayCapabilities {
  web_search: boolean;
}

/** One result from `GET /v1/web/search`. The wire shape, so it lives here. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** How old the index thinks the page is, when it says. */
  age?: string;
}

/**
 * A message's content, in the two shapes an OpenAI-compatible API accepts.
 *
 * A plain string is still what almost every message is, and keeping it means no
 * existing conversation — including the ones already on disk in
 * `~/.clixad/sessions` — has to change shape to be read back. The array form
 * exists for one reason: an image cannot travel as text, and `image_url` with a
 * `data:` URL is the encoding every provider behind the gateway understands.
 */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImageUrlPart;

/** An image on its way into a conversation, before it becomes a content part. */
export interface ImageAttachment {
  mimeType: string;
  /** Base64, without the data: prefix. */
  data: string;
  /** What it is, for the sentence next to it and for the TUI's notice. */
  label: string;
}

export function imagePart(image: ImageAttachment): ImageUrlPart {
  return { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * On an assistant turn that called tools: the model's reasoning behind the
   * calls, opaque, exactly as the gateway sent it. It has to go back with the
   * results — a thinking model handed its own tool call without it answers the
   * result with an empty message far more often, and Gemini 3's continuation is
   * keyed on it — and it is dropped once the turn is over (`withoutReasoning`),
   * since nothing after a final answer needs it and every call would pay for it.
   */
  reasoning_details?: ReasoningDetail[];
}

/** One block of a model's reasoning, never read here: see `ChatMessage`. */
export type ReasoningDetail = Record<string, unknown>;

/**
 * The conversation with the reasoning taken out, for everything that outlives
 * a turn: the history the next turn starts from and the session file.
 */
export function withoutReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.reasoning_details) return message;
    const { reasoning_details: _dropped, ...rest } = message;
    return rest;
  });
}

/**
 * The readable text of a message, whatever shape its content is in.
 *
 * Everything that measures, summarises, titles or prints a conversation needs
 * this, and each of them writing its own `typeof content === "string"` check is
 * how one of them ends up printing `[object Object]` to a user.
 */
export function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : `[image: ${imageMimeType(part) ?? "attached"}]`))
    .join("\n");
}

/** The declared type of an inline image part, for a label. */
function imageMimeType(part: ImageUrlPart): string | undefined {
  return /^data:([^;,]+)/.exec(part.image_url.url)?.[1];
}

/**
 * The conversation with the image bytes taken out, for writing to disk.
 *
 * A session file used to be text. An inlined screenshot is base64, so keeping
 * them would put megabytes into `~/.clixad/sessions` — fifty of those by
 * default — and hand every one of them back to the model on `--resume`, which
 * is not what resuming a conversation from three days ago is for.
 *
 * What is left behind is a sentence saying an image was there, so the
 * conversation still makes sense: a resumed turn that read "look at this" with
 * nothing after it would be a model being asked about something invisible. The
 * live conversation is untouched — only the copy that is persisted loses them.
 */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .map((part) =>
        part.type === "text" ? part.text : `[image not kept in the saved session: ${imageMimeType(part) ?? "attached"}]`,
      )
      .join("\n");
    return { ...message, content: text };
  });
}

export interface ChatResult {
  content: string;
  creditsCharged: number;
  balance: number;
  /** The free tier paid for this call. `creditsCharged` is then 0, honestly. */
  free?: boolean;
  /** What it would have cost. Only meaningful with `free`. */
  creditsWaived?: number;
  /** This account's allowance after the call. Only meaningful with `free`. */
  freeCreditsLeft?: number;
}

/** A single assistant turn, including any tool_calls it requested. */
export interface ChatTurn {
  message: ChatMessage;
  finishReason: string;
  creditsCharged: number;
  balance: number;
  /**
   * The free tier paid for this call rather than the wallet.
   *
   * `creditsCharged` is 0 and the balance did not move, which is exactly what an
   * older client sees and prints — correctly, if without the explanation. These
   * three fields are what let this one say why.
   */
  free?: boolean;
  creditsWaived?: number;
  freeCreditsLeft?: number;
  /** What may be spent next, worked out from `balance`; absent on a free call and from an older gateway. */
  spendable?: Spendable;
}

export interface ChatOptions {
  /** Tool schema advertised to the model (OpenAI function-tool format). */
  tools?: unknown;
  /**
   * The `/effort` setting, sent as `reasoning_effort`. Absent sends nothing,
   * and the request is byte for byte what it was before the setting existed.
   */
  effort?: string;
  /** Aborts the request; the REPL wires this to Esc. */
  signal?: AbortSignal;
  /** Called for every streamed content chunk. */
  onDelta?: (chunk: string) => void;
}

export interface CreditPackInfo {
  id: string;
  label: string;
  credits: number;
  price_usd: number;
}

/**
 * What the buyer declared before checkout: an express request that we begin
 * performance inside the withdrawal period, and an acknowledgment that the
 * right of withdrawal lapses once the credits are delivered. Both, or neither —
 * § 356 (5) BGB needs the pair.
 */
export interface WithdrawalConsent {
  requestImmediatePerformance: true;
  acknowledgeLossOfWithdrawal: true;
  /** When the declaration was made, ISO 8601. Recorded with the purchase. */
  at: string;
}

export interface CheckoutInfo {
  url: string;
  sessionId: string;
  pack: string;
  credits: number;
  price_usd: number;
}

export interface DeviceStart {
  session: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export type DevicePoll =
  | { status: "pending"; interval?: number }
  | {
      status: "complete";
      token: string;
      userId: string;
      email: string;
      login: string;
      balance: number;
      created: boolean;
      signupBonus: number;
      /**
       * The model a new account starts on. Sent only with `created: true`, and
       * absent from a gateway older than the field; see `performLogin`.
       */
      default_model?: string;
    }
  // The gateway authorized the GitHub identity but refuses to create an account
  // for it (signups are waitlist-gated). Distinct from "denied", which is the
  // user declining on GitHub's page: this one is not retryable and the message
  // is the actionable part, so it must survive the HTTP layer rather than being
  // flattened into `http 403`.
  | { status: "closed"; message: string; waitlistUrl: string }
  // No answer of the gateway's own: Render's edge during a deploy or a restart,
  // a proxy, a 5xx with no body we wrote. Nothing about the approval on GitHub
  // has changed, so the caller polls again rather than sending the person back
  // to approve a code they may already have approved.
  | { status: "unavailable"; error: string }
  | { status: "error" | "denied" | "expired"; error?: string };

/** Body the gateway sends when signups are gated. */
interface SignupClosed {
  error: string;
  message: string;
  waitlist_url: string;
}

function asSignupClosed(status: number, data: unknown): SignupClosed | undefined {
  if (status !== 403) return undefined;
  const d = data as Partial<SignupClosed> | null;
  return d && d.error === "signup_closed" && typeof d.message === "string"
    ? { error: d.error, message: d.message, waitlist_url: d.waitlist_url ?? "https://clixad.io" }
    : undefined;
}

/** Signups are gated and this identity is not on the list. Not retryable. */
export class SignupClosedError extends Error {
  constructor(
    message: string,
    readonly waitlistUrl: string,
  ) {
    super(message);
    this.name = "SignupClosedError";
  }
}

/** A model this account could still run for nothing today, and for how long. */
export interface FreeAlternative {
  id: string;
  /** Roughly how many more free turns the allowance buys on it — the gateway's. */
  turnsLeft: number;
}

export class PaywallError extends Error {
  constructor(
    readonly balance: number,
    readonly estimatedCost: number,
    /** The median completed offer's grant, for the "what an offer pays" hint. */
    readonly grantPerAd: number,
    /**
     * What the gateway says is free *right now*, best first, or empty.
     *
     * Empty is the honest default and covers three different gateways: one too
     * old to send the field, one whose free tier is paused or out of budget, and
     * one answering a 402 for something that is never free (a web search). All
     * three mean the same thing to a caller — there is nothing to switch to —
     * so none of them needs telling apart, and the ad wall is the answer to all
     * of them.
     *
     * The turn counts are the **gateway's arithmetic**. This program cannot import
     * the pricing engine, so a number divided out here would be a figure nothing
     * forces to agree with what is actually metered — `grantLabel`'s rule and
     * `modelHint`'s.
     */
    readonly freeModels: FreeAlternative[] = [],
    /**
     * The cheapest pack, in USD, where the gateway sells packs; null from a
     * gateway that sells none or is too old to say. The notice puts it after
     * `/buy`, since somebody a little short is who the smallest pack is for.
     */
    readonly cheapestPackUsd: number | null = null,
    /**
     * One of our own surveys open to this account right now (2026-10-19): what
     * it pays and how many of today's are left. Only on a budget model, whose
     * refusal it can end without a screenout; null from an older gateway or
     * when none is open.
     */
    readonly ownSurvey: { credits: number; leftToday: number } | null = null,
  ) {
    super("Out of credits");
    this.name = "PaywallError";
  }
}

/**
 * A premium model refused because the credits that may pay for it, from the
 * offer walls or purchases, are not enough (2026-10-04).
 *
 * Not a `PaywallError`: the wallet may be full of bonus credits, and every
 * sentence the paywall says ("out of credits", "the balance is") would be
 * wrong about it. The message is the gateway's whole sentence, which is what
 * a caller with nothing better to do prints; the fields are what the REPL
 * builds its chooser from. Every figure is the gateway's, `grantLabel`'s rule.
 */
export class PremiumLockedError extends Error {
  constructor(
    message: string,
    readonly model: string,
    /** About what the turn needs at the minimum worthwhile answer. */
    readonly neededCredits: number,
    /** What the account may spend on premium right now. */
    readonly premiumCredits: number,
    /** The cheapest pack's price, or null on a deployment that sells none. */
    readonly unlockUsd: number | null,
    /** The median completed offer's grant. */
    readonly grantPerAd: number,
    /** Free models this account could switch to right now, best first. */
    readonly freeModels: FreeAlternative[],
    /** What may be spent per kind of model, with the balance it was worked out from. */
    readonly spendable?: { figures: Spendable; balance: number },
  ) {
    super(message);
    this.name = "PremiumLockedError";
  }
}

/**
 * A paid call refused by a daily limit on bonus credits: the account's own
 * (`paid_user_limit_reached`), the one across everybody (`paid_budget_spent`),
 * or one that could not be checked (`paid_budget_unavailable`). The message is
 * the gateway's, printed as it stands; what it adds is the figures the refusal
 * carried, so the status line says what is usable the moment it is printed.
 */
export class LimitRefusalError extends Error {
  constructor(
    message: string,
    readonly type: string,
    /** What may be spent per kind of model, with the balance it was worked out from. */
    readonly spendable?: { figures: Spendable; balance: number },
  ) {
    super(message);
    this.name = "LimitRefusalError";
  }
}

/**
 * The agent is switched off on the gateway (its maintenance switch, or a
 * provider balance that has run out), and every model call and search is
 * refused until it is back. The message is the gateway's one sentence, and it
 * is meant to be printed alone: not as an error, since nothing on this side
 * went wrong and nothing was charged.
 */
export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

/** The `error` a maintenance refusal carries, in a body or a stream frame. */
const MAINTENANCE = "maintenance";

/**
 * A 503 the gateway itself answered (an edge's never reaches here, `postChat`
 * resends or reports those): the maintenance switch, or anything else as the
 * message `httpFailure` makes of it.
 */
async function refusal503(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (body.error === MAINTENANCE && typeof body.message === "string") return new MaintenanceError(body.message);
  } catch {
    // not ours, or not JSON: the generic message below
  }
  const detail = safeDetail(text);
  return new Error(detail ? `${what} failed: 503 — ${detail}` : `${what} failed: 503`);
}

/** The refusals `LimitRefusalError` stands for. */
const LIMIT_REFUSALS = new Set(["paid_user_limit_reached", "paid_budget_spent", "paid_budget_unavailable"]);

/** `{ figures, balance }` when both arrived, undefined otherwise. */
function spendableAt(raw: unknown, balance: unknown): { figures: Spendable; balance: number } | undefined {
  const figures = parseSpendable(raw);
  return figures && typeof balance === "number" && Number.isFinite(balance) ? { figures, balance } : undefined;
}

/** `clixad.premium` on the refusal, as the stream frame and the 402 carry it. */
interface PremiumBody {
  model?: unknown;
  needed_credits?: unknown;
  premium_credits?: unknown;
  unlock_usd?: unknown;
  grant_per_ad?: unknown;
  free_models?: unknown;
}

function premiumLockedError(
  message: string,
  model: string,
  body: PremiumBody | undefined,
  spendable?: { figures: Spendable; balance: number },
): PremiumLockedError {
  // Read defensively, `paywallError`'s rule: a malformed field costs that
  // field, never the refusal.
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return new PremiumLockedError(
    message,
    typeof body?.model === "string" ? body.model : model,
    num(body?.needed_credits),
    num(body?.premium_credits),
    typeof body?.unlock_usd === "number" && body.unlock_usd > 0 ? body.unlock_usd : null,
    num(body?.grant_per_ad),
    freeAlternatives(body?.free_models),
    spendable,
  );
}

/**
 * The first line of a refusal, which says which of two situations this is.
 *
 * Every 402 used to open with "Out of credits", and most of them were not: an
 * account refused by the paywall usually still holds credits, just not enough
 * for one turn on the model it picked. "Out of credits" next to a balance of
 * twenty thousand reads as a bug, and it hides the cheaper way on, which is a
 * cheaper model. So an empty wallet is still "out of credits", and a short one
 * says what this turn needs and what there is. Both figures grouped, since five
 * digits is where an ungrouped number starts being misread.
 */
export function shortfallHeadline(err: { balance: number; estimatedCost: number }, model?: string): string {
  const n = (v: number) => Math.max(0, Math.round(v)).toLocaleString("en-US");
  if (err.balance <= 0) return `Out of credits (this needs about ${n(err.estimatedCost)}).`;
  return (
    `Not enough credits for this turn${model ? ` on ${model}` : ""}: ` +
    `it needs about ${n(err.estimatedCost)}, and the balance is ${n(err.balance)}.`
  );
}

/** The 402 body, as both the streaming and non-streaming paths read it. */
interface PaywallBody {
  balance: number;
  estimated_cost: number;
  grant_per_ad: number;
  free_models?: { id: string; turns_left: number }[];
  cheapest_pack_usd?: unknown;
  own_survey?: unknown;
}

function paywallError(body: PaywallBody): PaywallError {
  const pack = body.cheapest_pack_usd;
  return new PaywallError(
    body.balance,
    body.estimated_cost,
    body.grant_per_ad,
    freeAlternatives(body.free_models),
    typeof pack === "number" && Number.isFinite(pack) && pack > 0 ? pack : null,
    ownSurveyOffer(body.own_survey),
  );
}

/** A 402's `own_survey`, read defensively: anything unusable is no offer. */
function ownSurveyOffer(raw: unknown): { credits: number; leftToday: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { credits?: unknown; left_today?: unknown };
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return ok(o.credits) && ok(o.left_today) ? { credits: o.credits, leftToday: Math.floor(o.left_today) } : null;
}

/**
 * A refusal's `free_models`, read defensively: this is a body from a server
 * the CLI does not ship with, and a malformed entry must cost the offer
 * rather than the whole refusal.
 */
function freeAlternatives(list: unknown): FreeAlternative[] {
  return Array.isArray(list)
    ? list
        .filter(
          (m): m is { id: string; turns_left: number } =>
            !!m && typeof m.id === "string" && m.id.length > 0 && Number.isFinite(m.turns_left),
        )
        .map((m) => ({ id: m.id, turnsLeft: Math.max(0, Math.floor(m.turns_left)) }))
        .filter((m) => m.turnsLeft > 0)
    : [];
}

/**
 * The 402 a non-streamed request gets: the wallet's own, or the premium gate's.
 * Told apart by `error`, which the paywall's body has always carried.
 */
async function refusal402(res: Response, model: string): Promise<PaywallError | PremiumLockedError> {
  const body = (await res.json()) as PaywallBody & {
    error?: string;
    message?: string;
    premium?: PremiumBody;
    spendable?: unknown;
  };
  if (body.error === "premium_locked") {
    return premiumLockedError(body.message ?? "", model, body.premium, spendableAt(body.spendable, body.balance));
  }
  return paywallError(body);
}

/**
 * A 400 on a chat request: a conversation too long for its model at the
 * catalogue price (`prompt_too_long`) goes
 * out as the gateway's sentence, anything else as `httpFailure` words it.
 */
async function refusal400(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (body.error === "prompt_too_long" && typeof body.message === "string") return new Error(body.message);
  } catch {
    // not ours, or not JSON: the generic message below
  }
  const detail = safeDetail(text);
  return new Error(detail ? `${what} failed: 400 — ${detail}` : `${what} failed: 400`);
}

/**
 * A 429 on a chat request: a daily limit's refusal (`LimitRefusalError`), or
 * anything else as the message `httpFailure` makes of it. A limit's sentence
 * is the gateway's and goes out whole; it used to arrive here as
 * "chat failed: 429 — " and the first two hundred characters of it.
 */
async function refusal429(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; spendable?: unknown; balance?: unknown };
    if (typeof body.error === "string" && LIMIT_REFUSALS.has(body.error) && typeof body.message === "string") {
      return new LimitRefusalError(body.message, body.error, spendableAt(body.spendable, body.balance));
    }
  } catch {
    // not ours, or not JSON: the generic message below
  }
  const detail = safeDetail(text);
  return new Error(detail ? `chat failed: 429 — ${detail}` : "chat failed: 429");
}

/**
 * The gateway could not be reached, or the connection to it broke before an
 * answer arrived.
 *
 * It exists because Node reports every one of those as a bare
 * `TypeError: fetch failed`, and that is what `clixad models` used to print on
 * a train with no signal: two words, no host, no cause and nothing to do. The
 * message names the host and the low-level code and says what to try.
 *
 * What it says about money depends on *when* it failed, and that is the one
 * part that must not be approximated. A connection that never opened (no DNS
 * answer, refused, unreachable, a TLS failure) sent nothing, so nothing can
 * have been charged, and saying so saves somebody a trip to `/wallet`. A
 * connection that dropped part way may have delivered a request the gateway
 * generated and billed, so that case says to check the balance before sending
 * it again, `EdgeOutage`'s "interrupted" rule for the same reason. It names no
 * command for that: the same sentence is read at the REPL, where it is
 * `/wallet`, and after a one-shot command, where it is `clixad wallet`, and an
 * instruction that cannot be carried out where it is read is a dead end. An abort is
 * never one of these: esc and ctrl+c are reported as "(stopped)" by the caller,
 * and turning them into a network error would say the connection failed when
 * the user stopped it.
 */
export class GatewayUnreachableError extends Error {
  constructor(
    readonly host: string,
    readonly code: string | undefined,
  ) {
    const where = `${host}${code ? ` (${code})` : ""}`;
    super(
      neverConnected(code)
        ? `Can't reach the Clixad gateway at ${where}. Nothing was sent, so nothing was charged. ` +
            "Check your connection and try again."
        : `The connection to the Clixad gateway at ${where} broke before an answer arrived. ` +
            "If that was a model call it may still have been charged, so check your balance before sending it again.",
    );
    this.name = "GatewayUnreachableError";
  }
}

/**
 * Codes that mean no connection was ever made, so no request can have arrived.
 * Anything else (a reset, a timeout on an open socket, an unknown code) is
 * treated as "may have arrived", which is the direction that cannot mislead
 * anybody about their balance.
 */
const NEVER_CONNECTED = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function neverConnected(code: string | undefined): boolean {
  return code !== undefined && NEVER_CONNECTED.has(code);
}

/** The low-level code behind undici's "fetch failed", when there is one. */
function networkCode(err: unknown): string | undefined {
  let cause: unknown = (err as { cause?: unknown })?.cause;
  // undici nests the socket error one or two levels down, depending on the
  // path, and a refused connection to a host with both an IPv4 and an IPv6
  // address arrives as an AggregateError holding one error per attempt.
  for (let depth = 0; depth < 3 && cause; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const inner = (cause as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      const first = inner.find((e) => typeof (e as { code?: unknown })?.code === "string");
      if (first) return (first as { code: string }).code;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `fetch`, with a network failure turned into `GatewayUnreachableError`.
 *
 * Every request this client makes to the gateway goes through here, so no
 * command and no REPL path can print "fetch failed" again. HTTP errors are
 * untouched: a response is an answer, and each caller decides what it means.
 */
export async function gatewayFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const aborted = init?.signal?.aborted || (err as { name?: unknown })?.name === "AbortError";
    if (aborted || !(err instanceof TypeError)) throw err;
    let host = String(url);
    try {
      host = new URL(url).host;
    } catch {
      // Not a URL we can parse; the raw string is still more useful than nothing.
    }
    throw new GatewayUnreachableError(host, networkCode(err));
  }
}

export class AuthError extends Error {
  constructor() {
    super("Not logged in. Run `clixad login` first.");
    this.name = "AuthError";
  }
}

/**
 * Decide what a 401 actually means.
 *
 * The gateway answers a bad bearer token with `{"error":"invalid token"}` as
 * JSON. Anything else sitting on the gateway URL — a platform's SSO/deployment
 * protection page, an auth proxy, a corporate egress gateway, a tunnel that has
 * expired — also answers 401, and typically with HTML. Mapping every 401 to
 * `AuthError` told those users to run `clixad login`, which cannot possibly
 * help: the login request is served by the same URL and fails the same way. The
 * fix is cheap and the failure it prevents is a loop with no exit.
 *
 * Bodies are read here rather than by the caller, so a call site cannot forget.
 */
async function authFailure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  if (isJson) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      // Our shape: a JSON object carrying a string `error`. Good enough to
      // distinguish us from every proxy, and it stays true if the message changes.
      if (typeof parsed.error === "string") return new AuthError();
    } catch {
      /* JSON content-type with an unparseable body — not ours. */
    }
  }
  return new Error(
    `${what}: the gateway returned 401 without a Clixad error body. The gateway URL ` +
      `may be pointing at something else — a login/SSO page, a proxy, or a stale ` +
      `deployment. Check it, or set CLIXAD_GATEWAY_URL.`,
  );
}

/** A 403, split into "the edge did this" and "the gateway did this". */
async function triage(res: Response): Promise<{ block?: EdgeBlock; res: Response }> {
  const peeked = await peek(res);
  const block = detectEdgeBlock(res.status, res.headers, peeked.body);
  return { ...(block ? { block } : {}), res: peeked.res };
}

/**
 * A failed request as one printable line.
 *
 * `${res.status} ${await res.text()}` was the shape everywhere, and it is only
 * safe while the thing answering is our gateway. When it is not — a WAF error
 * page, a proxy, a tunnel's landing page — that interpolation puts kilobytes of
 * somebody else's HTML into an `Error` the TUI renders verbatim. `safeDetail`
 * is the whole fix; this exists so no call site has to remember to call it.
 */
async function httpFailure(res: Response, what: string): Promise<string> {
  const detail = safeDetail(await res.text().catch(() => ""));
  return detail ? `${what} failed: ${res.status} — ${detail}` : `${what} failed: ${res.status}`;
}

/**
 * Sleep that gives up the instant the signal aborts.
 *
 * A deliberate third copy of the one in `login.ts` and `tools.ts` rather than a
 * shared module for six lines: what matters is the property, which is that no
 * wait in this CLI can swallow an esc for its own duration. An outage wait reaches
 * sixteen seconds on its own and half a minute when the edge asks for longer,
 * so a `setTimeout` that ignored the signal would be the single longest
 * unresponsive stretch in the product.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class GatewayClient {
  constructor(private config: CliConfig) {}

  /**
   * Told when the client had to change how it talks to the gateway.
   *
   * Set by the REPL, unset everywhere else. A transport that silently changes
   * itself is a thing the user should be able to see — it explains the pause,
   * and it is the difference between "the tool is being slow" and "something in
   * front of the gateway rejected that request". Left unset for `clixad -p` and
   * the one-shot commands, whose stdout exists to be piped.
   */
  onNotice?: (text: string) => void;

  /**
   * How chat bodies are being sent, for the rest of this process.
   *
   * Sticky once it moves. The conversation is resent in full every turn, so the
   * string that got the first request blocked is in every request after it —
   * going back to plain JSON would mean paying a blocked round-trip per turn to
   * rediscover the same thing.
   */
  private chatTransport: "json" | "encoded" = "json";

  private headers(auth = true): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) {
      if (!this.config.token) throw new AuthError();
      h.Authorization = `Bearer ${this.config.token}`;
    }
    return h;
  }

  /** Dev-only signup shortcut (production replaces this with GitHub OAuth). */
  async signupDev(
    email?: string,
    invite?: string,
  ): Promise<{ token: string; userId: string; email: string; balance: number; default_model?: string }> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/dev/users`, {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify({ ...(email ? { email } : {}), ...(invite ? { invite } : {}) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const closed = asSignupClosed(res.status, data);
      if (closed) throw new SignupClosedError(closed.message, closed.waitlist_url);
      throw new Error(`signup failed: ${res.status} ${JSON.stringify(data ?? "")}`);
    }
    return res.json() as Promise<{
      token: string;
      userId: string;
      email: string;
      balance: number;
      default_model?: string;
    }>;
  }

  /** Begin GitHub device-flow login. Returns null if the gateway has no GitHub
   *  configured (501), so the caller can fall back to the dev shortcut. */
  async deviceStart(): Promise<DeviceStart | null> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/auth/device/start`, {
      method: "POST",
      headers: this.headers(false),
    });
    if (res.status === 501) return null;
    if (!res.ok) throw new Error(await httpFailure(res, "device start"));
    return res.json() as Promise<DeviceStart>;
  }

  /** Poll once for device-flow completion. `invite` unlocks a gated signup. */
  async devicePoll(session: string, invite?: string): Promise<DevicePoll> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/auth/device/poll`, {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify(invite ? { session, invite } : { session }),
    });
    const data = (await res.json().catch(() => ({}))) as DevicePoll;
    const closed = asSignupClosed(res.status, data);
    if (closed) {
      return { status: "closed", message: closed.message, waitlistUrl: closed.waitlist_url };
    }
    if (!res.ok && !("status" in data && data.status)) {
      if (res.status >= 500 || res.status === 429) return { status: "unavailable", error: `http ${res.status}` };
      return { status: "error", error: `http ${res.status}` };
    }
    return data;
  }

  /**
   * Mint a single-use code the ad wall can trade for a session, so opening the
   * dashboard doesn't ask the user to paste a token by hand. Returns undefined if
   * the gateway can't issue one — the caller still opens the wall, just unsigned.
   */
  async handoffCode(): Promise<string | undefined> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/auth/handoff`, {
        method: "POST",
        headers: this.headers(),
      });
      if (!res.ok) return undefined;
      return (await res.json() as { code?: string }).code;
    } catch {
      return undefined;
    }
  }

  /**
   * Claim today's login-streak grant, or find out that today is already claimed.
   *
   * Safe to call from anywhere and as often as you like: the gateway keys it on
   * `(account, UTC day)`, so the second call of the day credits nothing and
   * answers with the same day number. That is what lets every surface which
   * might be somebody's first contact today — a login, the REPL opening,
   * `wallet` — claim without coordinating.
   *
   * **Never throws.** Like `sponsorConfig`, every caller is decorating something
   * that already works: a gateway too old to have the route, a cold start, a
   * dropped connection and an expired token all mean the same thing here, which
   * is "say nothing about a streak". A missed grant is claimed by the next
   * command; a session that died over one would be a real loss.
   */
  /**
   * The account's preferences, kept with the account so they
   * hold in the browser's chat and here. Null when they cannot be read, and on
   * a gateway too old to have them (404): a preference is never a reason for
   * the REPL not to open.
   */
  async getSettings(signal?: AbortSignal): Promise<AccountSettings | null> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/account/settings`, {
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return null;
      return parseAccountSettings(await res.json());
    } catch {
      return null;
    }
  }

  /**
   * Change the preferences a request names. Best-effort and never throws: a
   * model picked here is saved locally whatever the gateway says, and a
   * failed sync costs only that the browser's chat does not follow.
   */
  async saveSettings(change: Record<string, unknown>): Promise<AccountSettings | null> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/account/settings`, {
        method: "PUT",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) return null;
      return parseAccountSettings(await res.json());
    } catch {
      return null;
    }
  }

  async claimStreak(signal?: AbortSignal): Promise<StreakInfo | null> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/streak/claim`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<StreakInfo>;
      // A gateway answering something else entirely (a proxy, an SSO page that
      // happened to return 200) must not become a streak of `undefined`.
      if (typeof body.day !== "number" || typeof body.credits !== "number") return null;
      return {
        day: body.day,
        credits: body.credits,
        claimed: body.claimed === true,
        balance: typeof body.balance === "number" ? body.balance : 0,
        schedule: Array.isArray(body.schedule) ? body.schedule : [],
        length: typeof body.length === "number" ? body.length : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Send one rating, and answer what it was paid.
   *
   * **Never throws**, for `claimStreak`'s reason and one of its own: this is
   * called from a prompt that has already interrupted somebody, and the worst
   * possible outcome is that answering it takes the session down. A gateway too
   * old for the route, a cold start and an expired token all mean the same thing
   * — the rating is lost, which costs the user nothing and us one data point.
   *
   * `null` for "nothing to say"; an outcome with `credited: 0` for "recorded,
   * unpaid", which is what the daily ceiling looks like from here and is worth
   * telling the user apart from a grant.
   */
  async sendFeedback(report: FeedbackReport, signal?: AbortSignal): Promise<FeedbackOutcome | null> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/feedback`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          session_id: report.session,
          turn: report.turn,
          rating: report.rating,
          model: report.model,
          prompt: report.prompt,
          response: report.response,
          ...(report.steps === undefined ? {} : { steps: report.steps }),
          ...(report.free ? { free: true } : {}),
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<FeedbackOutcome>;
      return {
        recorded: body.recorded === true,
        credited: typeof body.credited === "number" ? body.credited : 0,
        balance: typeof body.balance === "number" ? body.balance : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * This account's referral code and standing, minting the code if it has none.
   *
   * **This one throws**, unlike `claimStreak` and `sendFeedback`. Those two
   * decorate something that already works and a failure costs a line of chrome;
   * this *is* the command — `clixad refer` with nothing to print is a command
   * that did not run, and saying so beats printing an empty summary.
   */
  async referral(signal?: AbortSignal): Promise<ReferralInfo> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/referrals`, {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401) throw await authFailure(res, "referrals");
    if (!res.ok) throw new Error(await httpFailure(res, "referrals"));
    const body = (await res.json()) as Record<string, unknown>;
    const num = (value: unknown) => (typeof value === "number" ? value : 0);
    if (typeof body.code !== "string" || !body.code) {
      throw new Error("the gateway did not return a referral code");
    }
    return {
      code: body.code,
      invited: num(body.invited),
      credited: num(body.credited),
      creditsEarned: num(body.credits_earned),
      remaining: num(body.remaining),
      maxCredited: num(body.max_credited),
      inviterCredits: num(body.inviter_credits),
      inviteeCredits: num(body.invitee_credits),
    };
  }

  /**
   * Spend a redeem code.
   *
   * **Throws**, like `referral` and unlike `claimStreak`: this is the command
   * itself, and somebody who typed a code and got silence has been told nothing.
   * A refusal is not a throw though — an expired or already-spent code answers
   * 200 with a status, because that is an answer rather than a failure.
   */
  async redeem(code: string, signal?: AbortSignal): Promise<RedeemResult> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/redeem`, {
      method: "POST",
      headers: this.headers(),
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ code }),
    });
    if (res.status === 401) throw await authFailure(res, "redeem");
    if (!res.ok) throw new Error(await httpFailure(res, "redeem"));
    const body = (await res.json()) as Partial<RedeemResult>;
    return {
      status: (body.status ?? "unknown") as RedeemStatus,
      credited: typeof body.credited === "number" ? body.credited : 0,
      balance: typeof body.balance === "number" ? body.balance : 0,
    };
  }

  /**
   * Both billing calls take a signal, for the reason `models` does: the only
   * surface that buys credits is now `/buy` at the REPL prompt, which awaits
   * them with the input box locked and "esc to stop" on screen.
   */
  async creditPacks(signal?: AbortSignal): Promise<{ enabled: boolean; packs: CreditPackInfo[] }> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/billing/packs`, { signal });
    if (!res.ok) throw new Error(`packs failed: ${res.status}`);
    return res.json() as Promise<{ enabled: boolean; packs: CreditPackInfo[] }>;
  }

  /**
   * `consent` carries the two declarations § 356 (5) BGB requires before we may
   * deliver digital content inside the withdrawal period. It is not optional:
   * the gateway refuses a checkout without it, because starting a purchase we
   * could not deliver instantly is worse than not starting one.
   */
  async checkout(pack: string, consent: WithdrawalConsent, signal?: AbortSignal): Promise<CheckoutInfo> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: this.headers(),
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ pack, consent }),
    });
    if (res.status === 401) throw await authFailure(res, "checkout");
    if (res.status === 501) throw new Error("Buying credits isn't enabled (Stripe not configured on the gateway).");
    if (!res.ok) throw new Error(await httpFailure(res, "checkout"));
    return res.json() as Promise<CheckoutInfo>;
  }

  // These take an optional signal for the REPL's sake: they are awaited while the
  // input box is locked, and a gateway that is cold-starting (Render's free tier,
  // the better part of a minute) would otherwise be indistinguishable from a
  // hung terminal. Nothing else passes one — a one-shot CLI command has Ctrl+C.
  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/models`, { signal });
    if (!res.ok) throw new Error(`models failed: ${res.status}`);
    const data = (await res.json()) as {
      data: ModelInfo[];
      capabilities?: Partial<GatewayCapabilities>;
      task_shape?: unknown;
      cli_latest?: unknown;
      retired_models?: unknown;
      premium_unlock_usd?: unknown;
    };
    // Recorded on the way past rather than fetched separately: the catalog is
    // already requested at startup, and one request is cheaper than two.
    this.seen = { web_search: data.capabilities?.web_search === true };
    this.unlockUsd =
      typeof data.premium_unlock_usd === "number" && data.premium_unlock_usd > 0 ? data.premium_unlock_usd : null;
    this.shape = parseTaskShape(data.task_shape);
    this.latest = typeof data.cli_latest === "string" ? data.cli_latest : undefined;
    // Read defensively, like every field a newer gateway adds: a malformed
    // entry costs that entry, and only ids the catalog actually lists count as
    // successors, so a map from a confused gateway cannot move anybody onto a
    // model that does not exist.
    const live = new Set(data.data.map((m) => m.id));
    this.retired = {};
    if (data.retired_models && typeof data.retired_models === "object") {
      for (const [from, to] of Object.entries(data.retired_models as Record<string, unknown>)) {
        if (typeof to === "string" && live.has(to) && !live.has(from)) this.retired[from] = to;
      }
    }
    return data.data;
  }

  /**
   * Model ids that were retired, and the live model that serves each one, as of
   * the last catalog fetch. Empty from a gateway that does not send the map.
   */
  get retiredModels(): Readonly<Record<string, string>> {
    return this.retired;
  }
  private retired: Record<string, string> = {};

  /**
   * The newest `clixad` published to npm, as the gateway last read it, or
   * undefined when it did not say. Undefined means unknown, never up to date.
   */
  get latestCli(): string | undefined {
    return this.latest;
  }
  private latest: string | undefined;

  /**
   * The task shape the cost preview assumes, as of the last catalog fetch, or
   * undefined when the gateway sent none (or one that did not parse). Undefined
   * means no estimate is shown at all, the silence an older gateway gets.
   */
  get taskShape(): TaskShape | undefined {
    return this.shape;
  }
  private shape: TaskShape | undefined;

  /**
   * What the gateway said it can do, as of the last catalog fetch.
   *
   * Defaults to **off**, and that direction is deliberate. The consequence of
   * guessing wrong is asymmetric: assuming search works when it does not means
   * every model call pays to advertise a tool that can only answer with an
   * error, and the model spends a round-trip finding that out. Assuming it does
   * not work when it does costs at most the first turn of a session, before the
   * catalog has come back.
   */
  get capabilities(): GatewayCapabilities {
    return this.seen;
  }
  private seen: GatewayCapabilities = { web_search: false };

  /**
   * What unlocks premium for every credit on the account (the cheapest pack,
   * USD), as of the last catalog fetch. Null where the gateway sells none or
   * did not say, which the hints read as "a survey unlocks it".
   */
  get premiumUnlockUsd(): number | null {
    return this.unlockUsd;
  }
  private unlockUsd: number | null = null;

  /**
   * `premium: true` asks for premium access too, which costs the gateway a read
   * of this account's whole ledger. Asked for where it is shown (`/model`,
   * `clixad models`), never by the polls `/earn` and a purchase run.
   */
  async wallet(signal?: AbortSignal, opts: { premium?: boolean } = {}): Promise<WalletInfo> {
    const url = `${this.config.gatewayUrl}/v1/wallet${opts.premium ? "?premium=1" : ""}`;
    const res = await gatewayFetch(url, { headers: this.headers(), signal });
    if (res.status === 401) throw await authFailure(res, "wallet");
    if (!res.ok) throw new Error(`wallet failed: ${res.status}`);
    return res.json() as Promise<WalletInfo>;
  }

  /**
   * Ask the gateway for a sponsored line, or `null` if it has none.
   *
   * **This never throws and never reports a failure to anybody.** Every caller is
   * painting a row of dim chrome that already has a house line in it, so there is
   * no state a user could act on and nothing a message would improve — a 404 from
   * a gateway older than the route, a 401, a cold start, a dropped connection and
   * an empty inventory are all the same event here, which is "keep showing ours".
   * That is the opposite of every other method on this client, and it is why the
   * catch is this broad rather than a list of statuses.
   */
  /**
   * The serve parameters for this session, or `null` for "no ad network".
   *
   * Fetched once per session rather than per model call: the publisher id and
   * the subject are stable for the life of an account, and the SDK's slot holds
   * its own dwell cache. This route used to be `GET /v1/sponsor/line`, and used
   * to be asked before every single call.
   *
   * Never throws, for the reason `sponsorLine` never threw: the caller starts it
   * beside a turn that is already running, and a status line must not be able to
   * take a session with it. A 404 (an older gateway that still serves lines
   * itself) and a 401 both land on `null`, which means the house line — the
   * correct outcome in both cases.
   */
  async sponsorConfig(signal?: AbortSignal): Promise<SponsorConfigInfo | null> {
    try {
      // `direct=1`: this CLI asks for booked lines first and keeps ADtention
      // out of a booked slot itself, so the gateway need not leave that slot
      // out of the config, which it does for CLIs that cannot.
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/sponsor/config?direct=1`, {
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      const publisherId = typeof body.publisher_id === "string" ? body.publisher_id.trim() : "";
      // `provider: "house"` is a successful answer meaning "use your own", and
      // it carries no publisher. Only an id is a configuration.
      if (!publisherId) return null;
      const formats = extraFormatIds(body.formats);
      return {
        publisherId,
        ...(typeof body.category === "string" ? { category: body.category } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(typeof body.dwell_ms === "number" ? { dwellMs: body.dwell_ms } : {}),
        ...(Object.keys(formats).length > 0 ? { formats } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Report one impression, and answer what it was credited.
   *
   * Fire-and-forget from the caller's point of view — the number comes back for
   * the session tally and for tests, and nothing on screen depends on it. Like
   * `sponsorConfig` it never throws: this is called from a `void`, and an
   * unhandled rejection there is a Node process exiting over a line of chrome
   * nobody asked for.
   *
   * **Call this after the model call the line was shown during has finished.**
   * The gateway credits an impression only once that call has been settled, so
   * a report that arrives while the call is still in flight is refused every
   * time, and silently, since a refused grant is a 200 with `credited: 0`. That
   * is the shape this shipped in once. `reportSponsor` in `app.tsx` is the
   * caller, and it fires from `runTurn`'s `finally` for exactly this reason.
   */
  async reportImpression(report: ImpressionReport, signal?: AbortSignal): Promise<number> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/sponsor/impression`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          impression_id: report.impressionId,
          ...(report.format && report.format !== "top_bar" ? { format: report.format } : {}),
          ...(report.adId ? { ad_id: report.adId } : {}),
          billable: report.billable,
          from_cache: report.fromCache,
          credit: report.credit,
        }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as { credited?: unknown };
      return typeof body.credited === "number" ? body.credited : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Ask for booked lines (step 2): one ask per model call, naming the slots
   * that fit the terminal now. See `sponsor/direct.ts` for the contract.
   *
   * Never throws, for `sponsorConfig`'s reason. A 404 means a gateway that
   * does not know the route, so `supported: false` tells the caller to stop
   * asking for the rest of the session; every other failure (a timeout, a 429,
   * a 5xx, a malformed body) is simply "nothing booked" this time.
   */
  async directSponsor(formats: readonly AdFormat[], cols: number, signal?: AbortSignal): Promise<DirectAnswer> {
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/sponsor/direct`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ formats, cols }),
      });
      if (res.status === 404) return { supported: false, lines: [] };
      if (!res.ok) return { supported: true, lines: [], failed: true };
      return { supported: true, lines: parseDirectLines(await res.json()) };
    } catch {
      return { supported: true, lines: [], failed: true };
    }
  }

  /**
   * Report the booked lines a turn drew, in one call, after the turn is over.
   * Never to `/v1/sponsor/impression`, which would credit them as ADtention's.
   * Never throws; answers what was credited, for the tally and for tests.
   */
  async reportDirectImpressions(
    impressions: ReadonlyArray<{ format: AdFormat; serveToken: string }>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (impressions.length === 0) return 0;
    try {
      const res = await gatewayFetch(`${this.config.gatewayUrl}/v1/sponsor/direct/impression`, {
        method: "POST",
        headers: this.headers(),
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ impressions: impressions.map((i) => ({ format: i.format, serve_token: i.serveToken })) }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as { credited?: unknown };
      return typeof body.credited === "number" ? body.credited : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Search the web, through the gateway.
   *
   * Here rather than in the tool because a search API needs a key, and the CLI
   * holding one would be the first provider credential it had ever held — the
   * exact thing the gateway exists to keep out of a program that ships to
   * strangers over npm. The gateway holds the key, rate-limits per account, and
   * answers 503 when no key is configured, which is a state a user can act on.
   */
  async webSearch(
    query: string,
    opts: { count?: number; signal?: AbortSignal } = {},
  ): Promise<WebSearchResult[]> {
    const url = new URL(`${this.config.gatewayUrl}/v1/web/search`);
    url.searchParams.set("q", query);
    if (opts.count) url.searchParams.set("count", String(opts.count));
    const res = await gatewayFetch(url, {
      headers: this.headers(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status === 401) throw await authFailure(res, "web search");
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
      if (body.error === MAINTENANCE && typeof body.message === "string") throw new MaintenanceError(body.message);
      throw new Error(
        "Web search isn't enabled on this gateway (no search key configured). Use web_fetch on a URL you know.",
      );
    }
    // A search costs credits — it is a provider charge, not tokens, so the
    // usual pre-authorization on a completion never saw it. Reported as the
    // paywall it is, so the REPL opens the ad wall rather than printing a code.
    if (res.status === 402) throw paywallError((await res.json()) as PaywallBody);
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? "Too many searches — wait a moment and try again.");
    }
    if (!res.ok) {
      // A query is in the URL, so it passes the same filter a chat body does —
      // and "reject ../../../etc/passwd" is a reasonable thing to search for.
      // There is no compressed form of a GET to fall back to, so this one is
      // only reported, and it is reported *to the model*: naming the cause and
      // an alternative is what turns a dead end into the next tool call, the
      // same reason an absent search key says "use web_fetch" rather than
      // returning nothing.
      const peeked = await peek(res);
      const block = detectEdgeBlock(res.status, res.headers, peeked.body);
      if (block) {
        throw new Error(
          `The search was rejected by a security filter in front of the gateway ` +
            `(${edgeBlockSummary(block)}); the query reads as an attack payload to it. ` +
            `Rephrase it without the literal payload, or use web_fetch on a URL you know.`,
        );
      }
      const body = (await peeked.res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `web search failed: ${res.status}`);
    }
    const data = (await res.json()) as { results?: WebSearchResult[] };
    return data.results ?? [];
  }

  // There is deliberately no way to earn from here. Earning goes through the
  // browser handoff (`handoffCode` above) to the ad wall, and the reward
  // arrives as a signed postback from the network to the gateway. Nothing comes
  // back to the CLI; a rising balance is the only signal, which is why both
  // `clixad earn` and the REPL's `/earn` poll `wallet()`.

  /** One POST to the chat route, in whichever transport is currently in use. */
  private sendChat(payload: unknown, encoded: boolean, signal?: AbortSignal): Promise<Response> {
    const json = JSON.stringify(payload);
    return gatewayFetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: encoded
        ? { ...this.headers(), "Content-Type": CHAT_ENCODED_CONTENT_TYPE }
        : this.headers(),
      body: encoded ? encodeChatBody(json) : json,
      signal,
    });
  }

  /**
   * POST a chat request, and keep asking while the answer is the edge's rather
   * than the gateway's.
   *
   * Two failures live in front of this route and they are opposites, which is
   * why they are two layers rather than one. A filter's 403 is *deterministic*:
   * the same bytes are refused identically forever, so `postWithFallbackEncoding`
   * below changes the encoding exactly once and never merely asks again. An
   * outage is the reverse: nothing about the request caused it, so nothing
   * about the request can avoid it, and asking again is the only move there is.
   *
   * Which outages may be asked again is `EdgeOutage.kind`'s decision, not this
   * loop's: `unreachable` never reached the gateway, `interrupted` may have
   * been generated and billed into a connection that had already gone.
   *
   * The two notices are the price of a locked keyboard. A turn that sits silent
   * for half a minute is indistinguishable from a hung one, so the wait is
   * announced before it starts and its end is announced when the answer finally
   * comes from the gateway.
   */
  private async postChat(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const resends: OutageResends = { count: 0, waitedMs: 0 };
    for (;;) {
      const res = await this.postWithFallbackEncoding(payload, signal);
      // Only four statuses can be an outage, and reading the body of anything
      // else would consume a response the caller still needs. `peek` rebuilds
      // the ones it does read, so the gateway's own 429 is handed back intact.
      if (!isOutageStatus(res.status)) {
        // Whatever the gateway says — a completion, a 402, a 500 — the outage
        // is over, because the answer is the gateway's. Said on `res.ok` alone
        // would leave somebody who waited half a minute for a 402 with a wait
        // that never visibly ended.
        if (resends.count > 0) {
          this.onNotice?.("  The gateway is answering again — the request went through.");
        }
        return res;
      }
      const peeked = await peek(res);
      const outage = detectEdgeOutage(res.status, res.headers, peeked.body);
      if (!outage) return peeked.res; // the gateway's own limiter, not the edge

      // A 502 or a 504 may already have been generated and billed on the other
      // side, so it is reported rather than resent — see `EdgeOutage.kind`.
      const health = `${this.config.gatewayUrl}/healthz`;
      if (outage.kind === "interrupted") throw new EdgeOutageError(outage, resends, health);
      if (resends.count >= OUTAGE_RETRIES) throw new EdgeOutageError(outage, resends, health);

      if (resends.count === 0) this.onNotice?.(outageWaitNotice(outage));
      const wait = outageWaitMs(resends.count, outage);
      await sleep(wait, signal);
      resends.count++;
      resends.waitedMs += wait;
      // An esc during the wait is felt here rather than a whole backoff later:
      // the next `fetch` carries the aborted signal and rejects immediately,
      // which every caller already reports as "(stopped)".
    }
  }

  /**
   * One POST, sent once more gzipped if a filter in front of the gateway
   * refused the plain body.
   *
   * Plain JSON first, always, on every fresh process. That is the OpenAI-compatible
   * contract this route serves — Kimi CLI's kosong client speaks it, and so does
   * anything else somebody points at `CLIXAD_GATEWAY_URL` — and a gateway that
   * has never heard of the encoded form must keep working. The compressed body
   * is a workaround for one specific failure, so it engages only once that
   * failure has actually happened.
   *
   * The retry is not a general "try again": a filter's 403 is deterministic,
   * and resending the identical bytes would be refused identically. It is the
   * *same* request in the second encoding (`encodeChatBody`), which is why it
   * is worth exactly one attempt and no more. General "try again" is `postChat`
   * above, around this, for the failure where it is the right answer.
   *
   * Four outcomes, and each has to be distinguishable or the user is left
   * guessing: the retry works (stick with it, say so once), the gateway answers
   * 415 because it predates this (say that — the fix is a deploy, not a
   * `/clear`), it is blocked again (say that too, and say that clearing the
   * history is the way out, because the history is what keeps triggering it), or
   * the edge answers instead of the gateway — in which case nothing is claimed
   * and nothing is remembered, because a 503 from a router says nothing at all
   * about whether the filter would have let that body through.
   */
  private async postWithFallbackEncoding(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const already = this.chatTransport === "encoded";
    const first = await this.sendChat(payload, already, signal);
    // Nothing but a 403 can be an edge block, and reading the body of anything
    // else would consume a response the caller still needs.
    if (first.status !== 403) return first;

    const { block, res } = await triage(first);
    if (!block) return res; // the gateway's own 403 — hand it back intact
    // Already compressed and blocked anyway: there is no second thing to try,
    // but this still has to be *reported* as what it is. Falling through to the
    // generic failure path here was how a session that switched transports and
    // was then blocked again ended up with a bare status code and no ray id —
    // the same unexplained failure, one layer further in.
    if (already) throw new EdgeBlockedError(block, "retried");

    const retry = await this.sendChat(payload, true, signal);
    if (retry.status === 415) throw new EdgeBlockedError(block, "unsupported");
    if (retry.status === 403) {
      const second = await triage(retry);
      if (second.block) throw new EdgeBlockedError(second.block, "retried");
      return second.res; // the gateway's own refusal of the encoded request
    }

    // The edge answered the compressed attempt too, so it never reached the
    // gateway and there is nothing to conclude from it: "got through" would be
    // false, and switching the transport on it would pin a session to an
    // encoding that was never actually tested against the filter. Handed back
    // for `postChat` to resend, which starts again from plain JSON.
    if (isOutageStatus(retry.status)) return retry;

    this.chatTransport = "encoded";
    this.onNotice?.(
      `  A security filter in front of the gateway blocked that request (${edgeBlockSummary(block)}).\n` +
        `  Resent with a compressed body, which got through. Nothing was lost, and the\n` +
        `  rest of this session will use the same encoding.`,
    );
    return retry;
  }

  /** Non-streaming chat. Kept for scripted/one-shot paths; the REPL streams. */
  async chat(
    messages: ChatMessage[],
    model: string,
    tools?: unknown,
    signal?: AbortSignal,
    effort?: string,
  ): Promise<ChatTurn> {
    const res = await this.postChat(
      { model, messages, stream: false, ...(tools ? { tools } : {}), ...(effort ? { reasoning_effort: effort } : {}) },
      signal,
    );
    if (res.status === 401) throw await authFailure(res, "chat");
    if (res.status === 402) throw await refusal402(res, model);
    if (res.status === 400) throw await refusal400(res, "chat");
    if (res.status === 429) throw await refusal429(res);
    if (res.status === 503) throw await refusal503(res, "chat");
    if (!res.ok) throw new Error(await httpFailure(res, "chat"));
    const data = (await res.json()) as {
      choices: { message: ChatMessage; finish_reason: string }[];
      clixad: ClixadMeta;
    };
    const choice = data.choices[0];
    if (!choice) throw new Error("chat: no choices in response");
    const spendable = parseSpendable(data.clixad.spendable);
    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      creditsCharged: data.clixad.credits_charged,
      balance: data.clixad.balance,
      ...freeMeta(data.clixad),
      ...(spendable ? { spendable } : {}),
    };
  }

  /**
   * Streaming chat. Calls `opts.onDelta` for each content chunk and assembles
   * the whole assistant turn — including `tool_calls`, which the gateway streams
   * with a per-call `index` (OpenAI style), so
   * the agent loop can stream *and* use tools in the same request.
   */
  async chatStream(messages: ChatMessage[], model: string, opts: ChatOptions = {}): Promise<ChatTurn> {
    const res = await this.postChat(
      {
        model,
        messages,
        stream: true,
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
      },
      opts.signal,
    );
    if (res.status === 401) throw await authFailure(res, "chat");
    if (res.status === 402) throw await refusal402(res, model);
    if (res.status === 503) throw await refusal503(res, "chat");
    if (!res.ok || !res.body) throw new Error(await httpFailure(res, "chat"));

    let content = "";
    let finishReason = "stop";
    let creditsCharged = 0;
    let free: ReturnType<typeof freeMeta> = {};
    let balance = 0;
    let streamError: string | undefined;
    let streamErrorType: string | undefined;
    let spendable: Spendable | undefined;
    let premiumRefusal: PremiumLockedError | undefined;
    const calls = new Map<number, ToolCall>();
    const reasoning: ReasoningDetail[] = [];

    for await (const evt of parseSSE(res.body)) {
      if (evt === "[DONE]") break;
      // Anything that is not one of our frames is skipped rather than thrown
      // over, the same rule the gateway applies on its own side of this
      // protocol. Every `data:` line on this stream is written by the gateway
      // today, so nothing reaches this branch; what it
      // prevents is one keep-alive or one line of somebody's HTML injected by
      // whatever sits between here and the gateway ending a turn mid-answer,
      // with a `SyntaxError` for a message.
      let json: StreamFrame;
      try {
        json = JSON.parse(evt) as StreamFrame;
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        content += delta;
        opts.onDelta?.(delta);
      }
      for (const [index, part] of (choice?.delta?.tool_calls ?? []).entries()) {
        accumulateToolCall(calls, part, index);
      }
      mergeReasoningDetails(reasoning, choice?.delta?.reasoning_details);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.error) {
        streamError = json.error.message || "the model stream failed";
        streamErrorType = json.error.type;
      }
      if (json.error?.type === "premium_locked") {
        premiumRefusal = premiumLockedError(
          streamError ?? "",
          model,
          json.clixad?.premium,
          spendableAt(json.clixad?.spendable, json.clixad?.balance),
        );
      }
      if (json.clixad) {
        creditsCharged = json.clixad.credits_charged;
        balance = json.clixad.balance;
        free = freeMeta(json.clixad);
        spendable = parseSpendable(json.clixad.spendable);
      }
    }

    // A stream that died mid-answer is not a finished turn: surface it rather than
    // hand back half a reply the agent loop would treat as the model's conclusion.
    // Noted after `[DONE]` so the credits frame is still read and reported.
    if (premiumRefusal) throw premiumRefusal;
    if (streamError && streamErrorType === MAINTENANCE) throw new MaintenanceError(streamError);
    if (streamError && streamErrorType && LIMIT_REFUSALS.has(streamErrorType)) {
      throw new LimitRefusalError(streamError, streamErrorType, spendable ? { figures: spendable, balance } : undefined);
    }
    if (streamError) throw new Error(streamError);

    const message: ChatMessage = { role: "assistant", content: content || null };
    if (calls.size > 0) {
      message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (reasoning.length) message.reasoning_details = reasoning;
    }
    return { message, finishReason, creditsCharged, balance, ...free, ...(spendable ? { spendable } : {}) };
  }
}

/**
 * The `clixad` block a completion carries.
 *
 * Two fields on a paid call — the shape every published CLI has read since the
 * first release — and three more when the free tier served it. The extra ones
 * are optional here rather than in a separate type because a response is one of
 * two shapes and a reader that has to branch on which before it can find the
 * balance is a reader that will one day forget to.
 */
interface ClixadMeta {
  credits_charged: number;
  balance: number;
  free?: boolean;
  credits_waived?: number;
  free_credits_left?: number;
  /** On a premium refusal only: what the chooser is built from. */
  premium?: PremiumBody;
  /** On a paid call or a refusal: the wire form of `Spendable`, read with `parseSpendable`. */
  spendable?: unknown;
}

/**
 * The free-tier half of a completion's meta, or nothing at all.
 *
 * Spread into a result rather than set unconditionally, so a paid turn carries
 * no `free` key rather than `free: false`. Everything downstream tests
 * `turn.free` for truth, and the two are equivalent there — but a session
 * transcript and a saved conversation both go through this, and a field that is
 * present-and-false on every paid turn since forever is noise that has to be
 * explained to whoever reads one next.
 */
function freeMeta(meta: ClixadMeta): {
  free?: boolean;
  creditsWaived?: number;
  freeCreditsLeft?: number;
} {
  if (meta.free !== true) return {};
  return {
    free: true,
    creditsWaived: meta.credits_waived ?? 0,
    freeCreditsLeft: meta.free_credits_left ?? 0,
  };
}

interface StreamFrame {
  choices?: {
    delta?: { content?: string; tool_calls?: ToolCallDelta[]; reasoning_details?: unknown };
    finish_reason?: string;
  }[];
  /** Present when the provider failed mid-stream: the gateway ends the stream with this frame. */
  error?: { type?: string; message?: string };
  clixad?: ClixadMeta;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * Merge one streamed tool_call fragment into the accumulator. Our gateway sends
 * each call complete in a single frame, but OpenAI-style providers split the
 * arguments across frames — concatenating handles both.
 */
function accumulateToolCall(calls: Map<number, ToolCall>, part: ToolCallDelta, fallbackIndex: number): void {
  const index = part.index ?? fallbackIndex;
  const current = calls.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
  if (part.id) current.id = part.id;
  if (part.function?.name) current.function.name = part.function.name;
  if (part.function?.arguments) current.function.arguments += part.function.arguments;
  calls.set(index, current);
}

/**
 * Fold one streamed `reasoning_details` delta into what has arrived so far.
 *
 * Our gateway sends the blocks already merged, with the tool calls; this still
 * merges, so a gateway or provider that streams them in pieces (one fragment
 * per token, sharing an `index`) is put back together rather than sent back as
 * a hundred blocks. A deliberate copy of the gateway's own merge: the published
 * bundle may import nothing but npm packages.
 */
export function mergeReasoningDetails(acc: ReasoningDetail[], delta: unknown): void {
  if (!Array.isArray(delta)) return;
  for (const piece of delta) {
    if (!piece || typeof piece !== "object") continue;
    const part = piece as ReasoningDetail;
    const existing =
      typeof part.index === "number" ? acc.find((block) => block.index === part.index) : undefined;
    if (!existing) {
      acc.push({ ...part });
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if (value === null || value === undefined) continue;
      if ((key === "text" || key === "summary" || key === "data") && typeof value === "string") {
        existing[key] = `${typeof existing[key] === "string" ? existing[key] : ""}${value}`;
      } else {
        existing[key] = value;
      }
    }
  }
}

/** Parse a fetch ReadableStream of Server-Sent Events into `data:` payloads. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }
}
