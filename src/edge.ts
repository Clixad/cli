/**
 * What to do when something in front of the gateway answers instead of it.
 *
 * The gateway sits behind a platform edge with a WAF, and a WAF's managed rules
 * pattern-match request bodies for attack payloads. A coding agent's request
 * body is a conversation about code, so a session that tests path traversal, or
 * quotes a SQL injection string, or pastes a shell one-liner, carries exactly
 * the strings those rules exist to catch. The edge answers 403 with an HTML
 * error page and the request never reaches us.
 *
 * That is bad on its own and it used to be unrecoverable, for a reason specific
 * to how this CLI works: every turn resends the whole conversation. Once a
 * triggering string is in the history it is in *every* subsequent request, so
 * one blocked turn blocked the rest of the session and the only way out was to
 * throw the conversation away. Two things follow, and they are separate fixes:
 *
 *   - the request needs a second encoding the filter does not read as text
 *     (`encodeChatBody` in client.ts, and the retry around it), and
 *   - the response has to stop being rendered. It is an HTML page, several
 *     kilobytes of it, and it went into an `Error` message that the TUI printed
 *     verbatim — which blows past the terminal height, and ink's answer to a
 *     bottom region taller than the viewport is to clear the screen and replay
 *     every static line it has ever emitted. The scrollback and the render died
 *     together.
 *
 * So nothing here ever returns an upstream body to a caller. It returns a
 * classification and a sentence.
 */

/** A response that came from the edge, not from the gateway. */
export interface EdgeBlock {
  status: number;
  /**
   * Cloudflare's per-request id. The only handle that identifies this request
   * to whoever can read the WAF's logs, so it is the one piece of the error
   * page worth keeping — and the reason this is parsed at all rather than the
   * whole page being dropped on the floor.
   */
  rayId?: string;
  /** Who answered, when the response admits it (the `server` header). */
  via?: string;
}

/**
 * Was this 403 the edge rather than the gateway?
 *
 * Same test as `authFailure`'s, for the same reason: our gateway answers a
 * refusal with a JSON object carrying a string `error` (`signup_closed`, and
 * every other deliberate 403), and no WAF error page does. Asking what the body
 * *is* rather than matching on a vendor's markup means a corporate egress
 * proxy, a platform's own filter and a load balancer are all classified the
 * same way — the user's problem is identical in every case and so is the advice.
 *
 * Scoped to 403 on purpose. A challenge page (503) and an edge rate limit (429)
 * are different failures with different answers — they are transient, and a WAF
 * block is not — so they are classified by `detectEdgeOutage` instead. Widening
 * this would describe them as WAF blocks, and tell a user to `/clear` a
 * conversation that was never the problem.
 */
export function detectEdgeBlock(status: number, headers: Headers, body: string): EdgeBlock | undefined {
  if (status !== 403) return undefined;
  if (isGatewayError(body)) return undefined;
  const via = headers.get("server") ?? undefined;
  const ray = rayId(headers, body);
  return { status, ...(ray ? { rayId: ray } : {}), ...(via ? { via } : {}) };
}

/** Our own refusal: a JSON object carrying a string `error`. */
function isGatewayError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    return typeof parsed?.error === "string";
  } catch {
    return false;
  }
}

/**
 * The request id, from the header if it is there and from the page if it is not.
 *
 * `cf-ray` is `<16 hex>-<datacenter>`; support quotes only the hex, so the
 * suffix is dropped. The body fallback exists because the header is not always
 * forwarded through an intermediate hop, while the page always prints it.
 */
function rayId(headers: Headers, body: string): string | undefined {
  const header = headers.get("cf-ray");
  if (header) return header.split("-")[0];
  const text = body.replace(/<[^>]*>/g, " ");
  return /ray\s*id:?\s*([0-9a-f]{16})/i.exec(text)?.[1];
}

/** The block as one short line, for a log or a one-line report. */
export function edgeBlockSummary(block: EdgeBlock): string {
  const parts = [`${block.status} from ${block.via ?? "an intermediary"}`];
  if (block.rayId) parts.push(`ray ${block.rayId}`);
  return parts.join(", ");
}

/** Why the workaround did not save the request. */
export type EdgeOutcome =
  /** The compressed retry was blocked as well. */
  | "retried"
  /** The gateway is too old to accept a compressed body. */
  | "unsupported";

/**
 * What the user reads. Every line here is load-bearing.
 *
 * It names the cause, because a bare "403" on a coding tool reads as an expired
 * token and sends people to `/login`, which cannot help — the login request
 * goes to the same URL through the same filter. It says the request never
 * arrived, so nobody goes looking for it in a gateway log or wonders whether
 * they were charged. It carries the ray id, which is the only thing that
 * identifies the request to whoever can read the WAF's logs. And it says what
 * to do, which is not "try again": the conversation is resent every turn, so a
 * retry with the same history is blocked identically.
 */
export function edgeBlockMessage(block: EdgeBlock, outcome: EdgeOutcome): string {
  const head =
    `A security filter in front of the gateway rejected this request (${block.status}), so it\n` +
    `  never reached Clixad. Nothing was sent to a model and nothing was charged.\n` +
    `  Filters like that match on request contents, and a conversation about path\n` +
    `  traversal, SQL or shell commands looks like an attack payload to one.`;
  const tail =
    outcome === "retried"
      ? `\n  The compressed body this CLI falls back to was blocked as well.\n` +
        `  Every turn resends the whole conversation, so the next one will be blocked\n` +
        `  too — use /clear, or start a new session, to get past it.`
      : `\n  This gateway is too old to accept the compressed body that works around it.\n` +
        `  Update the gateway, or use /clear to drop the history that trips the filter.`;
  const id = block.rayId ? `\n  Request id (for support): ${block.rayId}` : "";
  return head + tail + id;
}

/**
 * The edge answered, and the gateway never got the chance to.
 *
 * The sibling of `EdgeBlock`, and the reason it is a separate type: a WAF block
 * is *deterministic* — the same bytes are blocked the same way forever, so the
 * fix is to change the bytes (`encodeChatBody`) or to drop the history that
 * carries them. These are the opposite. Nothing about the request caused them
 * and nothing about the request can avoid them; the only thing that helps is
 * asking again.
 *
 * They were found the way the 403 was — a session reporting `chat failed: 503`
 * and nothing else. `/v1/chat/completions` cannot produce a 503: the gateway
 * answers 400 for an unknown model, 401 for a bad token, 402 for an empty
 * wallet, 429 for its own limiter and 500 for a provider that failed, and a
 * provider failure mid-stream is an error *frame* rather than a status at all.
 * So a 503 on that route has always come from in front of it, and the CLI had
 * nothing to say about it beyond the number.
 */
export interface EdgeOutage {
  status: number;
  /**
   * Whether the request can be sent again, which is the only thing a caller
   * needs from this.
   *
   * `unreachable` — 503 and 429. Render's router has no instance to hand the
   * request to (a release, a restart, a cold start), or Cloudflare's limiter
   * answered ahead of the origin. Either way the gateway never saw it, so
   * nothing was metered and resending the identical bytes is exactly what
   * works.
   *
   * `interrupted` — 502 and 504. The origin *may* have taken the request and
   * answered into a connection that had already gone, in which case the turn
   * was generated, settled and charged. A retry there is a second bill for one
   * question, so these are reported rather than resent, and the sentence says
   * so instead of promising nothing was charged.
   */
  kind: "unreachable" | "interrupted";
  /** Cloudflare's per-request id, as on `EdgeBlock` and for the same reason. */
  rayId?: string;
  /** Who answered, when the response admits it (the `server` header). */
  via?: string;
  /** What the edge asked us to wait, when it said so and the figure is sane. */
  retryAfterMs?: number;
}

/** The statuses `detectEdgeOutage` can classify — cheap to test before peeking. */
const OUTAGE_STATUSES = new Set([429, 502, 503, 504]);

/** Whether a status is worth reading the body of to classify it. */
export function isOutageStatus(status: number): boolean {
  return OUTAGE_STATUSES.has(status);
}

/**
 * The longest `retry-after` worth honouring.
 *
 * The header is a number from somebody else, and a turn is a person waiting at
 * a prompt. Past this the backoff decides instead, which is bounded by
 * `OUTAGE_RETRIES` and cannot park a session for a quarter of an hour because
 * an intermediary said `retry-after: 900`.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Was this the edge failing rather than the gateway refusing?
 *
 * The same test `detectEdgeBlock` and `authFailure` use: our gateway answers
 * with a JSON object carrying a string `error`, and no router's error page
 * does. It matters most on 429, which both ends can send — the gateway's own
 * limiter (`rate_limited`, with a `retry_after_ms` the client should show) and
 * Cloudflare's (an HTML page). Reading the first as an outage would retry a
 * limit whose whole purpose is to be waited out, and swallow the message that
 * says so.
 */
export function detectEdgeOutage(
  status: number,
  headers: Headers,
  body: string,
): EdgeOutage | undefined {
  if (!OUTAGE_STATUSES.has(status)) return undefined;
  if (isGatewayError(body)) return undefined;
  const kind = status === 502 || status === 504 ? "interrupted" : "unreachable";
  const via = headers.get("server") ?? undefined;
  const ray = rayId(headers, body);
  const wait = retryAfterMs(headers);
  return {
    status,
    kind,
    ...(ray ? { rayId: ray } : {}),
    ...(via ? { via } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  };
}

/** `retry-after` in milliseconds, when it is a sane number of seconds. */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined; // an HTTP-date, or junk
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** How many times a chat request is resent after the edge says it never arrived. */
export const OUTAGE_RETRIES = 5;

/**
 * How long to wait before attempt `n + 1`, doubling from a second.
 *
 * 1s, 2s, 4s, 8s, 16s — about half a minute in total, which is roughly what a
 * cold start on the gateway's host costs. Long enough to ride out the common
 * case, short enough that a genuinely dead gateway is reported rather than
 * waited on: a turn that hangs indefinitely is the failure this CLI already
 * fixed once, on the gateway's side of the stream.
 */
function outageBackoffMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}

/**
 * The wait before resending — ours, unless the edge asked for longer.
 *
 * `retry-after` may **lengthen** a wait and may never shorten one, the same
 * direction rule `sponsorGrant` applies to a payout a client reports: a number
 * from the other side moves this only the way that cannot hurt us. Read
 * literally it did the opposite, and `retry-after: 0` is the value that shows
 * why — RFC 7231 §7.1.3 allows it, it means "immediately", and a `??` does not
 * fall through zero. All five resends then fired back to back in a few hundred
 * milliseconds: a schedule documented as half a minute became a burst of six
 * requests at a gateway that was already struggling, and the "esc stops" notice
 * was printed and obsolete in the same frame.
 */
export function outageWaitMs(attempt: number, outage: EdgeOutage): number {
  return Math.max(outage.retryAfterMs ?? 0, outageBackoffMs(attempt));
}

/** The one line printed before the first wait, so the pause is not a mystery. */
export function outageWaitNotice(outage: EdgeOutage): string {
  return (
    `  The gateway did not answer that request (${edgeOutageSummary(outage)}).\n` +
    `  Nothing reached Clixad and nothing was charged. Waiting for it to come\n` +
    `  back and resending — esc stops.`
  );
}

/** The outage as one short line, for a notice or a log. */
export function edgeOutageSummary(outage: EdgeOutage): string {
  const parts = [`${outage.status} from ${outage.via ?? "an intermediary"}`];
  if (outage.rayId) parts.push(`ray ${outage.rayId}`);
  return parts.join(", ");
}

/**
 * What the user reads when the resends did not help, or when there were none.
 *
 * `edgeBlockMessage`'s rules, applied to the opposite failure. It names the
 * cause, because a bare `503` on a coding tool reads as the model being down
 * and sends people to `/model`, which cannot help — every model goes through
 * the same address. It says what was charged, and on `interrupted` it says the
 * honest thing rather than the comfortable one. It carries the ray id. And what
 * it advises is the opposite of the WAF block's: **not** `/clear`, because the
 * conversation was never the problem and throwing it away would cost the user a
 * session to fix something that had already fixed itself.
 */
export function edgeOutageMessage(
  outage: EdgeOutage,
  resends: OutageResends,
  healthUrl?: string,
): string {
  if (outage.kind === "interrupted") {
    return (
      `Something in front of the gateway ended that request (${outage.status}) before an\n` +
      `  answer came back. Unlike a 503 it may have reached Clixad first, so the turn\n` +
      `  may have been generated and charged even though nothing arrived — that is why\n` +
      `  it was not resent automatically.\n` +
      `  Check /wallet, then send the message again. The conversation is intact.` +
      raySuffix(outage)
    );
  }
  const tried =
    resends.count > 0
      ? `\n  It was resent ${resends.count} time${resends.count === 1 ? "" : "s"} over about ` +
        `${Math.round(resends.waitedMs / 1000)}s and answered the same way.`
      : "";
  // The configured gateway's own healthcheck, never a hardcoded one: this CLI
  // is pointed at a local gateway during development and at whatever
  // `CLIXAD_GATEWAY_URL` says the rest of the time, and sending somebody to
  // check a *different* deployment's health is worse than sending them nowhere.
  const check = healthUrl ? `\n  ${healthUrl} says whether it is up.` : "";
  return (
    `The gateway did not answer that request (${outage.status}), so it never reached\n` +
    `  Clixad. Nothing was sent to a model and nothing was charged.${tried}\n` +
    `  This is the gateway being restarted or unreachable, not anything about the\n` +
    `  conversation — so do not /clear it. Send the message again in a minute.${check}` +
    raySuffix(outage)
  );
}

function raySuffix(outage: EdgeOutage): string {
  return outage.rayId ? `\n  Request id (for support): ${outage.rayId}` : "";
}

/**
 * What the resends actually cost, carried rather than recomputed.
 *
 * The sentence above quotes this back to somebody who has just watched the
 * clock, so it has to be the wait that happened and not the wait that was
 * scheduled. Summing `outageBackoffMs` was the first version and is wrong the
 * moment `retry-after` lengthens a step — five 30-second waits reported as
 * "about 31s", to a person who sat there for two and a half minutes.
 */
export interface OutageResends {
  /** How many times the request was sent again. */
  count: number;
  /** What those resends waited in total. */
  waitedMs: number;
}

/** A transient edge failure, kept apart from the WAF's deterministic one. */
export class EdgeOutageError extends Error {
  constructor(
    readonly outage: EdgeOutage,
    readonly resends: OutageResends,
    healthUrl?: string,
  ) {
    super(edgeOutageMessage(outage, resends, healthUrl));
    this.name = "EdgeOutageError";
  }
}

/** A 403 the edge produced, kept apart from the gateway's own refusals. */
export class EdgeBlockedError extends Error {
  constructor(
    readonly block: EdgeBlock,
    readonly outcome: EdgeOutcome,
  ) {
    super(edgeBlockMessage(block, outcome));
    this.name = "EdgeBlockedError";
  }
}

/** The longest upstream detail any error message may carry. */
const DETAIL_LIMIT = 200;

/**
 * An upstream response body, reduced to something that can be printed.
 *
 * Every `!res.ok` path used to interpolate `await res.text()` straight into an
 * `Error`, which is fine for the gateway's one-line JSON and catastrophic for
 * anything else answering on that URL — an HTML error page, a proxy's
 * diagnostic dump, a tunnel's landing page. Three separate hazards, all handled
 * here so that no call site has to remember them:
 *
 *   - **Length.** The TUI renders an error message as a notice. Thousands of
 *     rows of it is the frame-height failure described at the top of this file.
 *   - **Escape sequences.** A body is bytes from somewhere else. An ANSI escape
 *     inside one is not text, it is an instruction to the terminal — colour,
 *     cursor movement, or a clear — executed because we printed it.
 *   - **Markup.** Nobody reads `<div class="cf-error-details">` in a terminal.
 *     A `<title>` is the one part of an error page that says anything, so it is
 *     preferred and the rest of the tags go.
 *
 * Returns "" when there is nothing worth saying, so callers can append it
 * conditionally instead of printing a stray separator.
 */
export function safeDetail(body: string, limit = DETAIL_LIMIT): string {
  if (!body) return "";
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1];
  const source = title ?? body;
  const text = source
    // OSC and CSI sequences first: stripping the ESC on its own would leave the
    // parameter bytes behind as literal text.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/g, " ")
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, " ")
    .replace(/<[^>]*>/g, " ")
    // Everything else that is not text, including a lone ESC.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Read a response body once, and hand back a response that can still be read.
 *
 * Classifying a failure means looking at the body, and a `Response` body can
 * only be consumed once — so a call site that peeked at a 403 which turned out
 * to be the gateway's own had already destroyed it for the caller. Rebuilding
 * is cheap (these are error bodies) and it keeps the peek from being something
 * every caller has to know about.
 */
export async function peek(res: Response): Promise<{ body: string; res: Response }> {
  const body = await res.text().catch(() => "");
  return { body, res: new Response(body, { status: res.status, headers: res.headers }) };
}
