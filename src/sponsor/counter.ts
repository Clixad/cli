/**
 * How many house lines this session showed. That is the entire measurement.
 *
 * ## What this deliberately is not
 *
 * It is not a log. There is no id per impression, no timestamp per impression,
 * and no record of which line ran alongside which prompt — because that triple
 * is a usage log of what somebody was doing and when, reconstructable from
 * nothing more than a counter with too many fields. A per-line tally is the
 * most that can be justified by "which of our own tips are people seeing", and
 * even that is only ever read in aggregate.
 *
 * It is also not a network client. Render's free tier is a single service, so an
 * HTTP call per impression would add a request per model call to the one process
 * that also has to answer reward postbacks — for a number nobody needs in real
 * time. The count lives in memory, dies with the process, and is reported (if it
 * ever is) as one aggregate on a call that was going to happen anyway.
 *
 * **Nothing here credits anything.** House content is not an earn path: no
 * grant, no ledger entry, nothing reported to the gateway. A line shown is a
 * line shown.
 */

export interface SponsorTally {
  /** Impressions this session, across all lines. */
  shown: number;
  /** Per-line counts, keyed by `SponsorLine.id`. Aggregate only. */
  byLine: Record<string, number>;
}

/**
 * A fresh counter.
 *
 * Constructed rather than module-global so a test does not inherit another
 * test's total, and so a second TUI in one process (there isn't one today)
 * would not silently share a tally.
 */
export function createTally(): SponsorTally {
  return { shown: 0, byLine: {} };
}

export function recordImpression(tally: SponsorTally, lineId: string): void {
  tally.shown += 1;
  tally.byLine[lineId] = (tally.byLine[lineId] ?? 0) + 1;
}

/**
 * The aggregate as it would be reported, once there is somewhere to report it.
 *
 * There is no such call today and this task deliberately does not add an
 * endpoint: `/v1/chat/completions` is an OpenAI-compatible surface that Kimi
 * CLI's kosong client also parses, so hanging a private field on its request
 * body means changing a contract we do not solely own, and `/v1/wallet` is a
 * GET with no body to carry it. Exported so the shape is settled and the
 * decision is a route, not a redesign.
 */
export function tallyReport(tally: SponsorTally): { shown: number; lines: Record<string, number> } {
  return { shown: tally.shown, lines: { ...tally.byLine } };
}
