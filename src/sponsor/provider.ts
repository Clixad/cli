/**
 * The sponsored line, and the one thing a source of them has to do: hand back
 * the next line to show.
 *
 * Shaped after the gateway's offerwall providers deliberately — a provider tuple,
 * a type derived from it, and one small builder per provider — because that is
 * the abstraction that paid off when a second offerwall arrived: it was already
 * the right size, so a second network was a new function rather than a refactor. The
 * lesson from it was also what *not* to put behind the interface. Everything
 * network-specific stayed at the boundary there; here the interface is likewise
 * only "give me a line", not a fill pipeline, a targeting model or a schedule.
 *
 * There are two implementations, and they are different *shapes* rather than two
 * of a kind — which is the thing to keep straight when reading this file:
 *
 *  - `house` is our own inventory, picked by `SponsorSource.pick`, which is pure
 *    and synchronous. Same arguments, same line. No I/O, so the rotation is
 *    testable by construction and a line is on screen whether or not anything is
 *    reachable.
 *  - `adtention` is an ad network, fetched by `RemoteSponsorSource.fetch`, which
 *    is asynchronous and may answer `null` at any time.
 *
 * Widening the one interface to cover both was the obvious move and the wrong
 * one: it would make `pick` return a promise everywhere, which throws away the
 * property that our own content never depends on a network. Two interfaces cost
 * a few lines and keep "the house line always works" true by type rather than by
 * intention.
 *
 * **The network call used to be somewhere else.** `fetch` took a finished
 * line from the gateway. It is now served from here, by `network.ts`, because
 * the network's SDK is built for client-side serving. An impression is worth
 * credits and this program is run by strangers, so nothing it reports is taken
 * on trust: the gateway decides what an impression is worth and whether to
 * credit it at all.
 *
 * What has not changed is this file. `RemoteSponsorSource` still takes its
 * fetcher as an argument and still does no I/O of its own, so what moved is one
 * function passed in at the call site rather than the shape of anything here —
 * which is the payoff for having taken the fetcher rather than a client.
 */
import type { ImpressionReport } from "../client.ts";
import { HOUSE_LINES, type SponsorLine } from "./lines.ts";

export const SPONSOR_PROVIDERS = ["house", "adtention"] as const;
export type SponsorProviderId = (typeof SPONSOR_PROVIDERS)[number];

/**
 * The providers whose inventory is local, i.e. the ones `sponsorSource` can
 * build. Split out so the exhaustive switch there keeps its compile-error
 * property: a new *local* provider must be handled, while a remote one is
 * built by `adtentionSource` and does not belong in that switch at all.
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

/**
 * A line from somewhere else: asked for, not computed.
 *
 * The whole interface is one method that answers `null`, because that is the
 * honest shape of an ad network. There is no inventory to rotate through here
 * and no state to keep — the network holds both, along with its own per-user
 * dwell, and the gateway holds the account. What is left on this side is a
 * request and a fallback.
 */
export interface RemoteSponsorSource {
  readonly provider: "adtention";
  /**
   * The next line, or `null` when there is none — no inventory, no publisher
   * configured, an unreachable network or an older gateway. Every one of those
   * is the same event to a caller (keep showing the house line), so they are one
   * return value rather than an error type nobody could act on differently.
   */
  fetch(signal?: AbortSignal): Promise<RemotePick | null>;
}

/**
 * A network line, and the receipt for it.
 *
 * `impression` is what the caller reports to the gateway once the line has
 * actually been *shown* — which is why it rides along here rather than being
 * reported by whoever fetched it. A line that loses the race against the end of
 * a turn is dropped without being painted, and reporting an impression for it
 * would be billing an advertiser for a line nobody saw.
 */
export interface RemotePick extends SponsorPick {
  impression: ImpressionReport;
}

/**
 * The ADtention provider, over whatever fetches a line for it.
 *
 * Takes the fetcher rather than a client so this module keeps its one real
 * property — it does no I/O of its own — and so a test is a function returning
 * an object rather than a fake HTTP layer.
 */
export function adtentionSource(
  fetchLine: (signal?: AbortSignal) => Promise<RemotePick | null>,
): RemoteSponsorSource {
  return {
    provider: "adtention",
    async fetch(signal) {
      // **This must not reject, and that is stronger than "should not".** The
      // caller starts it with `void` and does not await it — a turn is already
      // running and a line is already on screen — so a rejection here is an
      // unhandled one, which is a Node process exiting. Losing somebody's
      // session over a status line nobody asked for is not a trade available at
      // any error rate. It matters more now than it did: the fetcher used to be
      // one of our own routes and is now an ad network's SDK, which is somebody
      // else's code with somebody else's idea of what to throw.
      let line: RemotePick | null;
      try {
        line = await fetchLine(signal);
      } catch {
        // try/catch and not `.catch()`, which was the first version and does not
        // hold: a fetcher that throws *synchronously* never returns the promise
        // `.catch` was going to be attached to, so the throw escapes anyway.
        return null;
      }
      if (!line) return null;
      const text = line.text.trim();
      // A blank line would render as the marker and nothing else, which reads as
      // a bug in our TUI rather than as an empty ad slot.
      if (!text) return null;
      return { ...line, text };
    },
  };
}
