/**
 * What the CLI says about the free models, and where.
 *
 * The free tier existed and almost nobody found it. Most accounts the paywall
 * stopped on a paid model, with their free allowance for the day untouched,
 * never ran a free model afterwards. `/model` marked the free rows, but only for
 * somebody who opened it. So the REPL now says it when it opens, when the balance runs out, and in
 * `/help`, and the one-shot commands say it when they are refused.
 *
 * Every figure here comes from the gateway: `turns_left` and `credits_left` off
 * `/v1/wallet`, or a 402's `free_models`. The wording lives in one place for
 * `streakLabel`'s reason, shared by the TUI and the shell commands, and what
 * crosses into either is a string rather than a figure somebody formats twice.
 */
import { usd, type FreeAlternative, type WalletInfo } from "./client.ts";

export type FreeTier = NonNullable<WalletInfo["free_tier"]>;

const turns = (n: number) => `about ${n.toLocaleString("en-US")} turn${n === 1 ? "" : "s"}`;

/**
 * Which free model to name, with the turns it has left, or undefined.
 *
 * The one in use when it is free and has turns left, since that is the model
 * the next turn runs on. Otherwise the gateway's recommendation, the model new
 * accounts start on. Otherwise the first in the list with anything left. A
 * model with no turns left is never named: pointing at it would send somebody
 * to a model the next request refuses.
 */
export function freeModelToName(free: FreeTier, current?: string): { id: string; turns: number } | undefined {
  const left = (id: string) => free.turns_left[id] ?? 0;
  const usable = (id: string | undefined): id is string =>
    id !== undefined && free.models.includes(id) && left(id) > 0;
  const id = usable(current) ? current : usable(free.recommended) ? free.recommended : free.models.find(usable);
  return id === undefined ? undefined : { id, turns: left(id) };
}

/**
 * The line the REPL prints when it opens, and again once the balance runs out,
 * or undefined when there is nothing to say.
 *
 * Silent on a gateway with no free tier and on a paused one (both arrive as a
 * zero daily allowance), and silent too when the allowance is spent while the
 * wallet still holds credits: that account's next turn runs, and a notice about
 * something it cannot use today is a notice that teaches people to skip them.
 */
export function freeTierNotice(o: {
  model: string;
  balance: number;
  free: FreeTier | undefined;
  /** The cheapest pack (the gateway's figure), named where nothing free is left; null or absent says nothing. */
  cheapestPackUsd?: number | null;
}): string | undefined {
  const free = o.free;
  if (!free || !(free.daily_credits > 0)) return undefined;
  const pick = free.credits_left > 0 ? freeModelToName(free, o.model) : undefined;

  if (!pick) {
    if (o.balance > 0) return undefined;
    const pack = o.cheapestPackUsd;
    return (
      "Your balance is empty and today's free turns are used up. They come back at midnight UTC, and /earn tops up before then" +
      (typeof pack === "number" && pack > 0 ? `, or a pack from ${usd(pack)} with /buy.` : ".")
    );
  }
  if (pick.id === o.model) {
    return `${pick.id} is free today, ${turns(pick.turns)} left. /model shows the other free models.`;
  }
  if (o.balance <= 0) {
    return `Your balance is empty, but ${pick.id} is still free today (${turns(pick.turns)}). /model switches to it, /earn tops up.`;
  }
  return `${free.models.length} models are free today. /model switches, and ${pick.id} has ${turns(pick.turns)} left.`;
}

/**
 * The `/help` line about the free models, or undefined when there are none.
 *
 * Quotes `credits_left` rather than a turn count: the REPL keeps that figure
 * current from every free call's usage event, while `turns_left` is only as
 * fresh as the last wallet read, and `/help` is typed at any point in a session.
 */
export function freeHelpLine(free: FreeTier | undefined): { label: string; desc: string } | undefined {
  if (!free || !(free.daily_credits > 0)) return undefined;
  if (free.credits_left <= 0) return { label: "free models", desc: "used up today, back at midnight UTC" };
  return {
    label: "free today",
    desc: `${free.models.length} models, ${free.credits_left.toLocaleString("en-US")} free credits left · /model switches`,
  };
}

/**
 * The line a one-shot command prints under "Out of credits" when something is
 * still free, or undefined.
 *
 * Runnable from a shell, since that is where it is read: `clixad model <id>`,
 * never `/model`, which is `NOT_SIGNED_IN`'s lesson about naming a command the
 * reader cannot type where they are.
 */
export function freeAlternativeLine(
  freeModels: readonly FreeAlternative[],
  { rerun = true }: { rerun?: boolean } = {},
): string | undefined {
  const first = freeModels.find((m) => m.turnsLeft > 0);
  if (!first) return undefined;
  return (
    `${first.id} is still free today (${turns(first.turnsLeft)}). ` +
    `Switch with \`clixad model ${first.id}\`${rerun ? " and run it again" : ""}.`
  );
}
