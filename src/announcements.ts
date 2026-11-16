/**
 * One-time announcements in the REPL: said once per install, when the gateway
 * shows the change has happened, and never again.
 *
 * Each has an id that goes into `config.seenNotices` once it has been drawn.
 * A brand-new account is not told about a change to an arrangement it never
 * had, and the id is stored for it all the same, so it does not appear on its
 * second start either.
 */
import type { StreakInfo } from "./client.ts";
import type { CliConfig } from "./config.ts";

/** The free-usage change of 14 November 2026. */
export const CREDIT_MODEL_NOTICE_ID = "credit-model-2026-11-14";

/**
 * What changed, and that nothing anybody already has is taken. Every figure is
 * left out on purpose: the allowance and what a survey adds are the gateway's,
 * and the REPL's other lines already quote them.
 */
export const CREDIT_MODEL_NOTICE =
  "Since 14 November the budget models are free every day up to a daily limit, and our own surveys and\n" +
  "  the daily login streak raise that limit instead of adding credits. Credits you already have stay in\n" +
  "  your balance and work as before.";

/**
 * The announcement to draw at this start, if any. The streak claim is the
 * signal that the gateway runs the change: from then on it says the streak
 * added free usage, and a gateway from before says nothing of the kind.
 */
export function creditModelNotice(
  config: Pick<CliConfig, "seenNotices">,
  streak: StreakInfo | null | undefined,
  newAccount: boolean,
): { text: string | null; markSeen: boolean } {
  if (config.seenNotices?.includes(CREDIT_MODEL_NOTICE_ID)) return { text: null, markSeen: false };
  if (!streak?.freeAllowance) return { text: null, markSeen: false };
  return { text: newAccount ? null : CREDIT_MODEL_NOTICE, markSeen: true };
}

/** The config with `id` added to what this install has seen. */
export function withNoticeSeen<T extends Pick<CliConfig, "seenNotices">>(config: T, id: string): T {
  config.seenNotices = [...(config.seenNotices ?? []), id];
  return config;
}
