/**
 * What fills the three terminal places, as the gateway answers it.
 *
 * Once per turn the CLI asks `POST /v1/sponsor/direct`, naming the slots that
 * fit the terminal right now. For each slot the answer may carry a line a
 * business booked for the week (with a signed token to report it with and a
 * link to send a click through), or `hold` (the slot is booked and this
 * account has seen it enough today: show nothing else in it), or nothing.
 *
 * Where nothing is booked the answer may carry a network ad (`gravity`), and
 * a fallback line from our own list of referral programs for each place. The
 * order on screen is a booked line, then the network ad, then a fallback. The
 * network ad has two rules of its own: it is the only advertisement on screen
 * while it is up, so the other places stay empty and no fallback is drawn,
 * and it is drawn whole or not at all.
 *
 * Every one of them is an advertisement and is marked as one. None of the
 * three earns the person who sees it anything but a booked line.
 *
 * The contract is the gateway's; this file is its reader, deliberately not an
 * import, because this program is bundled for npm and may import nothing but
 * npm packages.
 */
import { isAdFormat, type AdFormat } from "./formats.ts";

/**
 * How long a turn waits for the answer. The house tip is on screen meanwhile,
 * so the cost of waiting is only that an ad arrives later. Long enough for the
 * gateway to ask the ad network, which it bounds at two and a half seconds.
 */
export const DIRECT_ASK_TIMEOUT_MS = 4_000;

/** The longest line we accept from the gateway. */
const MAX_TEXT = 200;

/** A line to show, with the token it is reported with and the address a click goes to. */
export interface ServedDirectLine {
  format: AdFormat;
  text: string;
  serveToken: string;
  clickUrl: string;
  /**
   * A booked line's short address, to print after the line where the
   * terminal cannot make the line itself a link, so it can be opened in every
   * terminal. Absent from an older gateway and from a fallback line, whose own
   * click address is already short.
   */
  shortUrl?: string;
}

/**
 * How a booked line could be opened where it was drawn, reported with its
 * impression: a hyperlink, the short address printed after it, or neither (a
 * terminal too narrow for the address that does not understand links). What
 * lets the advertiser read clicks against the lines that could be clicked.
 */
export type LinkMode = "link" | "address" | "none";

export type DirectLine = ServedDirectLine | { format: AdFormat; hold: true };

/**
 * A network ad for the top bar. Every address is a path on the gateway, which
 * passes impressions and clicks on to the network: this program fetches
 * nothing from anybody else.
 */
export interface GravityLine {
  text: string;
  /** Fetched once, when the line is first drawn. */
  impressionPath: string;
  /** Where a click goes, on the gateway. Absent when the ad has no link. */
  clickPath?: string;
  /** The network's own short address, printed where a terminal cannot link. */
  shortUrl?: string;
}

export interface DirectAnswer {
  /** False when the gateway does not know the route: stop asking this session. */
  supported: boolean;
  lines: DirectLine[];
  /**
   * The line for each place nothing is booked in, to show only where there is
   * no network ad. Absent from an older gateway.
   */
  fallbacks?: ServedDirectLine[];
  /** A network ad for the top bar, when nothing is booked. */
  gravity?: GravityLine;
  /**
   * The ask did not get an answer (a timeout, a 5xx, a broken body): nothing
   * is known about bookings this turn, so nothing but our own tip is drawn.
   */
  failed?: boolean;
  /**
   * The turn's measure token: reported back after the turn with how long each
   * place stayed on screen, which is what a booked week is forecast on.
   * Absent from an older gateway, and then nothing is reported.
   */
  measure?: string;
}

/** A path on the gateway the proxy serves, printable ASCII, of sane length. */
function gatewayTrackPath(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= 4000 && /^\/gravity\/[\x21-\x7e]+$/.test(raw) ? raw : undefined;
}

/**
 * The answer's network ad, or undefined: read like a booked line, and dropped
 * whole when any part of it is not what it should be. An ad without an
 * impression address could never be counted, so it is not drawn either.
 */
export function parseGravityLine(body: unknown): GravityLine | undefined {
  const raw = (body as { gravity?: unknown } | null)?.gravity;
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.text !== "string") return undefined;
  const text = sanitizeAdText(e.text);
  const impressionPath = gatewayTrackPath(e.impression_path);
  if (!text || text.length > MAX_TEXT || !impressionPath) return undefined;
  const clickPath = gatewayTrackPath(e.click_path);
  const shortUrl = typeof e.short_url === "string" && shortLinkText(e.short_url) ? e.short_url : undefined;
  return { text, impressionPath, ...(clickPath ? { clickPath } : {}), ...(shortUrl ? { shortUrl } : {}) };
}

/** The answer's measure token, or undefined: a string of sane length and nothing else. */
export function parseMeasure(body: unknown): string | undefined {
  const raw = (body as { measure?: unknown } | null)?.measure;
  return typeof raw === "string" && raw.length > 0 && raw.length <= 2000 ? raw : undefined;
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
    const line = readServedLine(e);
    if (!line) continue;
    out.push(line);
    seen.add(e.format);
  }
  return out;
}

/**
 * The answer's fallbacks, read by the same rules as a line to show: an entry
 * that is not exactly that shape is dropped, and a place appears at most once.
 * There is no `hold` among them: a place that is held has no fallback.
 */
export function parseFallbackLines(body: unknown): ServedDirectLine[] {
  const raw = (body as { fallbacks?: unknown } | null)?.fallbacks;
  if (!Array.isArray(raw)) return [];
  const out: ServedDirectLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const line = readServedLine(item as Record<string, unknown>);
    if (!line || out.some((o) => o.format === line.format)) continue;
    out.push(line);
  }
  return out;
}

/** One entry that carries a line to show, or null. */
function readServedLine(e: Record<string, unknown>): ServedDirectLine | null {
  if (!isAdFormat(e.format)) return null;
  if (typeof e.text !== "string" || typeof e.serve_token !== "string" || typeof e.click_url !== "string") return null;
  const text = sanitizeAdText(e.text).slice(0, MAX_TEXT);
  if (!text || !e.serve_token || e.serve_token.length > 2000) return null;
  let clickUrl: string;
  try {
    const url = new URL(e.click_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    clickUrl = url.toString();
  } catch {
    return null;
  }
  // The short address must be one we can print exactly as it opens.
  const shortUrl = typeof e.short_url === "string" && shortLinkText(e.short_url) ? e.short_url : undefined;
  return { format: e.format, text, serveToken: e.serve_token, clickUrl, ...(shortUrl ? { shortUrl } : {}) };
}

/** The longest address that is still worth printing beside a line. */
const MAX_LINK_TEXT = 40;

/**
 * The address to print after a line, so a terminal that does not understand
 * OSC 8 links can still open it: the host and path without the scheme
 * (`app.clixad.io/r/railway/t`), or undefined. Only an address with no query
 * and no fragment qualifies, so what is printed is exactly where a click goes;
 * a long signed click address stays behind the link and is never printed.
 */
export function shortLinkText(clickUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(clickUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) return undefined;
  const text = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  if (text.length > MAX_LINK_TEXT || !/^[\x21-\x7e]+$/.test(text)) return undefined;
  return text;
}
