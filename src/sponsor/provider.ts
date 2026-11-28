/**
 * The house tip in the top bar, and the one thing a source of them has to do:
 * hand back the next line to show.
 *
 * Our own inventory, picked by `SponsorSource.pick`, which is pure and
 * synchronous. Same arguments, same line. No I/O, so the rotation is testable
 * by construction and a line is on screen whether or not anything is
 * reachable. Advertisements (a booked line, the network's ad, a fallback) come
 * from the gateway's answer instead, and replace this line when one arrives.
 */
import { HOUSE_LINES, type SponsorLine } from "./lines.ts";

export const SPONSOR_PROVIDERS = ["house"] as const;
export type SponsorProviderId = (typeof SPONSOR_PROVIDERS)[number];

/**
 * The providers whose inventory is local, i.e. the ones `sponsorSource` can
 * build. The exhaustive switch there keeps its compile-error property: a new
 * local provider must be handled.
 */
export type LocalSponsorProviderId = "house";

/**
 * Runtime figures a line may interpolate, already formatted by the caller.
 *
 * They arrive as finished strings rather than numbers so this module cannot
 * round, re-format or otherwise restate a money figure: the formatting lives in
 * `grantLabel` / `adsPerTaskLabel` (`client.ts`), which are also what the
 * wallet and the model picker print, and which bake in the "on completion" and
 * median labels. Absent means the CLI has not fetched it yet, and the line is
 * skipped.
 */
export interface SponsorFacts {
  /** `grantLabel(wallet.grant_per_ad)` */
  grant?: string;
  /** `adsPerTaskLabel(model.est_ads_per_task)` for the *current* model. */
  adsPerTask?: string;
}

export interface SponsorPick {
  id: string;
  text: string;
}

export interface SponsorSource {
  readonly provider: LocalSponsorProviderId;
  /**
   * The line for impression `index`, or `null` when nothing can be shown.
   *
   * `previousId` is what was shown last, and is never returned again — the one
   * rotation rule. If skipping it would leave nothing, the answer is `null`:
   * showing the same line twice running is worse than showing none.
   */
  pick(index: number, previousId: string | undefined, facts: SponsorFacts): SponsorPick | null;
}

/** Substitute a line's placeholder, or `null` if the figure isn't in hand. */
function fill(line: SponsorLine, facts: SponsorFacts): string | null {
  if (!line.needs) return line.text;
  const value = line.needs === "grant" ? facts.grant : facts.adsPerTask;
  // No value means the gateway hasn't answered yet (or is an older deployment
  // that omits the field). Skip the line rather than print the brace, and never
  // substitute a placeholder figure — a made-up credit number is the one thing
  // this file exists to make impossible.
  if (!value) return null;
  return line.text.replace(`{${line.needs}}`, value);
}

/**
 * Our own content, rotated by position.
 *
 * The rotation is deliberately the most boring one available: start at
 * `index % length` and walk forward. No weighting, no shuffling, no randomness —
 * an impression is a pure function of the counter, so a test can assert the
 * exact sequence and a bug reproduces on the first try.
 */
export function houseSource(lines: readonly SponsorLine[] = HOUSE_LINES): SponsorSource {
  return {
    provider: "house",
    pick(index, previousId, facts) {
      if (lines.length === 0) return null;
      const start = ((index % lines.length) + lines.length) % lines.length;
      for (let step = 0; step < lines.length; step++) {
        const line = lines[(start + step) % lines.length]!;
        if (line.id === previousId) continue;
        const text = fill(line, facts);
        if (text) return { id: line.id, text };
      }
      return null;
    },
  };
}

/** Our own inventory. Named so the call site reads as a choice. */
export function sponsorSource(provider: LocalSponsorProviderId = "house"): SponsorSource {
  switch (provider) {
    case "house":
      return houseSource();
  }
}
