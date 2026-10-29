/**
 * Serving a sponsored line from ADtention, here, in the CLI.
 *
 * This file is the exception to a rule the rest of this codebase keeps: the CLI
 * does not talk to a paid third party, because it ships to strangers over npm
 * and a program the user owns must not hold a credential or an earning event.
 * `web_search` goes through the gateway for exactly that reason.
 *
 * It is here anyway because the network's SDK is built for client-side
 * serving, and serving from the gateway is not a shape it supports. So the
 * serve happens on the user's machine, from the user's address, and the
 * gateway is told about the impression afterwards.
 *
 * The gateway decides what an impression is worth and whether to credit it at
 * all, never this program. Nothing here needs to be trusted, which is the only
 * reason any of it is allowed to be here.
 *
 * Two things this file does *not* hold. There is no publisher id in the source
 * and none in the bundle: it arrives from `GET /v1/sponsor/config` per session,
 * so it can be rotated without a release and stops being served the moment an
 * account is closed. And there is no salt — the subject arrives already hashed,
 * so this program cannot derive one user's subject from another's id.
 */
import { isCategory, SponsorSlot, type Sponsor } from "@adtention/sdk";
import type { AdFormat } from "./formats.ts";
import { adFitsFormat } from "./render.ts";

/**
 * What one slot serves with: a format's publisher id, and the category, subject
 * and dwell every format shares.
 */
export interface SponsorConfig {
  publisherId: string;
  category?: string;
  /** The opaque, salted per-user tag the network scopes its dwell and cap by. */
  subject?: string;
  /** The network's own per-subject dwell, so ours cannot drift from it. */
  dwellMs?: number;
}

/** One line, plus everything the gateway needs to decide what it was worth. */
export interface ServedLine {
  id: string;
  text: string;
  impressionId: string;
  billable: boolean;
  fromCache: boolean;
  credit: number;
}

/** Longest ad text we will hand to the renderer. */
const MAX_TEXT_CHARS = 200;

/**
 * The line as it goes to the screen, or `undefined` when there is nothing.
 *
 * The SDK sanitises ad text on the way out of `serve()` — ANSI sequences and
 * every control byte stripped, trimmed — which is the part that matters for a
 * string headed to a terminal status line, and it is done there rather than
 * trusted from the network. What is left to do is length: the TUI truncates to
 * the terminal width anyway, but a source that will pass on whatever arrives is
 * one that will one day pass on a megabyte.
 *
 * This used to live in the gateway. It moved with the serve, unchanged, because
 * it belongs next to whoever first touches the network's bytes.
 */
export function sponsorLineText(ad: Sponsor): string | undefined {
  const text = typeof ad.text === "string" ? ad.text.trim() : "";
  if (!text) return undefined;
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS).trimEnd() : text;
}

/**
 * A serve function for one format, under one session's configuration.
 *
 * One slot per format, because a slot is one publisher id and holds its own
 * dwell cache: three formats sharing a slot would share a cache, and the
 * sidebar would be handed the top bar's cached line with its impression id —
 * one impression claimed twice, under two providers.
 *
 * `serveOnly: true` is the load-bearing option, for the reason it was
 * load-bearing in the gateway and more so here: it locks the client to serving,
 * so `register()` throws and construction throws without a publisher id. A CLI
 * that could register would, on the first release with a missing config, start
 * minting an earning account per install — orphaned revenue nobody can log into,
 * and a fleet of publisher accounts ADtention never agreed to. `identityStore`
 * is likewise never passed: self-registration is precisely that behaviour, and
 * it is opt-in in the SDK for the same reason it is refused here.
 *
 * `timeoutMs` is well under the SDK's 5s default because nothing waits on this.
 * The house line is already painted by the time it answers, so a slow network
 * costs an impression rather than a turn.
 */
export function createSponsorSlot(
  config: SponsorConfig,
  format: AdFormat = "top_bar",
): {
  serve(cols: number, signal?: AbortSignal): Promise<ServedLine | null>;
} {
  const slot = new SponsorSlot({
    publisherId: config.publisherId,
    serveOnly: true,
    // `isCategory` is the SDK's own guard, and it is checked here even though
    // the gateway already validated its category at boot, because the
    // interesting direction is the other one: an older CLI against a newer
    // gateway that has learned a seventh category. Passing an unknown value
    // through would be rejected per serve and look exactly like empty
    // inventory; dropping it falls back to `general`, which the SDK documents
    // as always filling from broad inventory. A worse-targeted line beats none.
    ...(isCategory(config.category) ? { category: config.category } : {}),
    ...(config.dwellMs && config.dwellMs > 0 ? { dwellMs: config.dwellMs } : {}),
    timeoutMs: 2_500,
    // Deliberately silent. A failed serve is not something the person at the
    // keyboard can act on, and this program's output is a coding session — an ad
    // network's transport error printed into it would be the single most
    // annoying line in the product.
    onError: () => {},
  });

  return {
    async serve(cols, signal) {
      // **Refused here, before the network call, and not at render time.**
      //
      // A serve is the billable event on ADtention's side: an impression id
      // comes back from it, and an advertiser is charged for a line that was
      // fetched whether or not a terminal ever had room to draw it. Fetching
      // into a terminal too narrow to show the copy and then discarding it is
      // therefore not a harmless optimisation to skip — it manufactures exactly
      // the impression this slot must never produce, one nobody read and
      // somebody paid for.
      //
      // The check lives *inside* `serve` rather than at the one call site, for
      // the reason the write tools call `ctx.permit` inside the tool: a gate a
      // caller has to remember is a gate that a second caller will not have.
      // The width has to be handed in because this module knows about a network
      // and nothing about a terminal, and it must be read at the moment of the
      // serve — the caller's closure is built once per session, so a width
      // captured there would be the width the session started at. Each format
      // has its own floor (`adFitsFormat`): the card needs a far wider terminal
      // than a row does.
      if (!adFitsFormat(format, cols)) return null;
      // `next()` does not throw on a serve failure: it reports through `onError`
      // and answers from its cache, and `null` means there was neither.
      const ad = await slot.next({
        ...(config.subject ? { subject: config.subject } : {}),
        ...(isCategory(config.category) ? { category: config.category } : {}),
      });
      // The signal is checked after rather than passed in — the SDK takes no
      // AbortSignal, and a line for a turn that has ended must not be painted.
      if (signal?.aborted || !ad) return null;
      const text = sponsorLineText(ad);
      if (!text) return null;
      return {
        id: ad.adId,
        text,
        impressionId: ad.impressionId,
        billable: ad.billable,
        fromCache: ad.fromCache,
        credit: ad.credit,
      };
    },
  };
}
