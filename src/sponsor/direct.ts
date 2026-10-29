/**
 * Direct campaigns: a line a business booked for one of the three slots, for a
 * week, served by our own gateway rather than by ADtention.
 *
 * Once per model call the CLI asks `POST /v1/sponsor/direct`, naming the slots
 * that fit the terminal right now. For each slot the answer may carry a line to
 * show (with a signed token to report it with and a link to send a click
 * through), or `hold` (the slot is booked and this account has seen it enough
 * today: show no network line in it), or nothing (nothing booked: ask
 * ADtention as always). Until the first week is sold the answer is always
 * nothing, and the ask is what measures the inventory a week is priced on.
 *
 * The contract is the gateway's; this file is its reader, deliberately not an
 * import, because this program is bundled for npm and may import nothing but
 * npm packages.
 */
import { isAdFormat, type AdFormat } from "./formats.ts";

/** How long a model call waits for the answer before asking ADtention anyway. */
export const DIRECT_ASK_TIMEOUT_MS = 1_500;

/** The longest line we accept from the gateway, before the row cuts it to fit. */
const MAX_TEXT = 200;

export type DirectLine =
  | { format: AdFormat; text: string; serveToken: string; clickUrl: string }
  | { format: AdFormat; hold: true };

export interface DirectAnswer {
  /** False when the gateway does not know the route: stop asking this session. */
  supported: boolean;
  lines: DirectLine[];
  /**
   * The ask did not get an answer (a timeout, a 5xx, a broken body): nothing
   * is known about bookings this turn, which the caller treats as nothing
   * booked except where the last answer it had said there was.
   */
  failed?: boolean;
}

/**
 * Somebody else's copy made safe for a terminal: no escape sequences, no
 * control characters, no bidirectional overrides or invisible characters that
 * could make the row read differently from what was approved, one line.
 *
 * The gateway refuses all of these when the copy is submitted. This is the
 * second fence, because a terminal is the one surface where a stray byte can do
 * more than look wrong.
 */
export function sanitizeAdText(raw: string): string {
  return (
    raw
      // CSI and OSC sequences first, whole, so their parameters do not survive.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // Every remaining C0 and C1 control, DEL included.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      // Bidirectional embeddings, overrides and isolates.
      .replace(/[‪-‮⁦-⁩‎‏؜]/g, "")
      // Zero-width and invisible joiners or spaces.
      .replace(/[​-‍⁠﻿­]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The answer's lines, read defensively: an entry that is not exactly one of
 * the two shapes is dropped, never guessed at, and a slot appears at most once.
 * A malformed answer costs that entry, never the turn.
 */
export function parseDirectLines(body: unknown): DirectLine[] {
  const raw = (body as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(raw)) return [];
  const out: DirectLine[] = [];
  const seen = new Set<AdFormat>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (!isAdFormat(e.format) || seen.has(e.format)) continue;
    if (e.hold === true) {
      out.push({ format: e.format, hold: true });
      seen.add(e.format);
      continue;
    }
    if (typeof e.text !== "string" || typeof e.serve_token !== "string" || typeof e.click_url !== "string") continue;
    const text = sanitizeAdText(e.text).slice(0, MAX_TEXT);
    if (!text || !e.serve_token || e.serve_token.length > 2000) continue;
    let clickUrl: string;
    try {
      const url = new URL(e.click_url);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      clickUrl = url.toString();
    } catch {
      continue;
    }
    out.push({ format: e.format, text, serveToken: e.serve_token, clickUrl });
    seen.add(e.format);
  }
  return out;
}
