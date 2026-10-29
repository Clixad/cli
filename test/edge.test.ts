/**
 * The session that dies at the edge, and the terminal that dies with it.
 *
 * Reproduced against the live gateway: a session working on an MCP server's
 * path-traversal tests stopped mid-task. The gateway sits behind a WAF, the
 * conversation contained `../../../etc/passwd`, and the edge answered 403 with
 * an HTML error page. Two independent failures came out of that one request:
 *
 *   1. **It could not be recovered from.** Every turn resends the whole
 *      conversation, so the offending string was in every subsequent request
 *      and each one was blocked identically. The only way out was to throw the
 *      session away.
 *   2. **The response was printed.** `chat failed: 403 ${await res.text()}`
 *      put several kilobytes of Cloudflare's HTML into an `Error` that the TUI
 *      rendered verbatim, which is taller than any terminal — and ink's answer
 *      to a bottom region taller than the viewport is to clear the screen and
 *      replay every static line of the session.
 *
 * These are separate fixes and they are tested separately: the transport
 * retries once in its second encoding, and no upstream body ever reaches a
 * renderer again.
 */
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EdgeBlockedError,
  OUTAGE_RETRIES,
  detectEdgeBlock,
  detectEdgeOutage,
  edgeBlockSummary,
  safeDetail,
} from "../src/edge.ts";
import { CHAT_ENCODED_CONTENT_TYPE, GatewayClient } from "../src/client.ts";
import { errorNotice } from "../src/tui/views.tsx";
import type { CliConfig } from "../src/config.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
};

/** The real thing, near enough: a few KB of markup with a ray id in it. */
const CF_BLOCK_PAGE =
  `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>` +
  `<style>${"body{margin:0}".repeat(200)}</style></head><body>` +
  `<h1>Sorry, you have been blocked</h1>` +
  `<p>You are unable to access clixad.onrender.com</p>` +
  `<div class="cf-error-footer">Cloudflare Ray ID: <strong>a2f1f3165944196d</strong></div>` +
  `</body></html>`;

const CF_HEADERS = { "content-type": "text/html", "cf-ray": "a2f1f3165944196d-FRA", server: "cloudflare" };

function blocked(): Response {
  return new Response(CF_BLOCK_PAGE, { status: 403, headers: CF_HEADERS });
}

/** A finished, non-streaming completion the client will accept. */
function completion(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      clixad: { credits_charged: 12, balance: 900 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A finished SSE turn, in the frames `streamCompletion` actually writes. */
function stream(): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"clixad":{"credits_charged":3,"balance":7}}\n\n' +
      "data: [DONE]\n\n",
    { status: 200 },
  );
}

const MESSAGES = [{ role: "user" as const, content: "reject ../../../etc/passwd in the MCP server" }];

/** Stub fetch with a scripted sequence, and record what was sent. */
function script(...responses: Response[]) {
  const calls: { contentType: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ contentType: headers["Content-Type"] ?? "", body: init.body });
    return responses[calls.length - 1] ?? completion();
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function failure(call: Promise<unknown>): Promise<Error> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  if (!err) throw new Error("expected the call to reject, but it resolved");
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("telling the edge apart from the gateway", () => {
  it("reads a WAF page as a block, and keeps the ray id", () => {
    const block = detectEdgeBlock(403, new Headers(CF_HEADERS), CF_BLOCK_PAGE);
    // The datacentre suffix is dropped: support quotes the hex.
    expect(block).toEqual({ status: 403, rayId: "a2f1f3165944196d", via: "cloudflare" });
    expect(edgeBlockSummary(block!)).toContain("a2f1f3165944196d");
  });

  it("finds the ray id in the page when the header did not survive the hops", () => {
    const block = detectEdgeBlock(403, new Headers({ "content-type": "text/html" }), CF_BLOCK_PAGE);
    expect(block?.rayId).toBe("a2f1f3165944196d");
  });

  it("does not call the gateway's own 403 an edge block", () => {
    const body = JSON.stringify({ error: "signup_closed", message: "closed" });
    const headers = new Headers({ "content-type": "application/json" });
    expect(detectEdgeBlock(403, headers, body)).toBeUndefined();
  });

  it("leaves other statuses alone — a challenge and a rate limit are not this", () => {
    expect(detectEdgeBlock(503, new Headers(CF_HEADERS), CF_BLOCK_PAGE)).toBeUndefined();
    expect(detectEdgeBlock(429, new Headers(CF_HEADERS), CF_BLOCK_PAGE)).toBeUndefined();
  });
});

describe("getting past the block", () => {
  it("retries the blocked request compressed, and that body carries no plaintext", async () => {
    const calls = script(blocked(), completion());
    const client = new GatewayClient(config);
    const turn = await client.chat(MESSAGES, "gemini-2.5-flash-lite");

    expect(turn.creditsCharged).toBe(12);
    expect(calls).toHaveLength(2);
    // First attempt is ordinary JSON: the route is OpenAI-compatible and other
    // clients speak it, so the workaround may never become the default.
    expect(calls[0]!.contentType).toBe("application/json");
    expect(calls[1]!.contentType).toBe(CHAT_ENCODED_CONTENT_TYPE);

    const sent = calls[1]!.body as Uint8Array;
    expect(Buffer.from(sent).includes(Buffer.from("../../../etc/passwd"))).toBe(false);
    // Same request, though — the workaround must not change what was asked.
    expect(JSON.parse(gunzipSync(Buffer.from(sent)).toString())).toEqual(
      JSON.parse(calls[0]!.body as string),
    );
  });

  it("keeps the working transport for the rest of the session", async () => {
    // The reason it must stick: the history that tripped the filter is resent
    // every turn, so going back to JSON means a blocked round-trip per turn.
    const calls = script(blocked(), completion(), completion());
    const client = new GatewayClient(config);
    await client.chat(MESSAGES, "gemini-2.5-flash-lite");
    await client.chat(MESSAGES, "gemini-2.5-flash-lite");

    expect(calls).toHaveLength(3);
    expect(calls[2]!.contentType).toBe(CHAT_ENCODED_CONTENT_TYPE);
  });

  it("says so once, so a silent transport change is not a mystery", async () => {
    script(blocked(), completion(), completion());
    const client = new GatewayClient(config);
    const notices: string[] = [];
    client.onNotice = (text) => notices.push(text);

    await client.chat(MESSAGES, "gemini-2.5-flash-lite");
    await client.chat(MESSAGES, "gemini-2.5-flash-lite");

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("a2f1f3165944196d");
    expect(notices[0]).not.toContain("<");
  });

  it("still explains a block that lands after the switch", async () => {
    // Found end to end: once the transport had switched, a later block skipped
    // classification altogether and came back as a bare status code with no ray
    // id — the same unexplained failure, one layer further in. There is nothing
    // left to try at that point, but it still has to be reported as what it is.
    const calls = script(blocked(), completion(), blocked());
    const client = new GatewayClient(config);
    await client.chat(MESSAGES, "gemini-2.5-flash-lite");
    const err = await failure(client.chat(MESSAGES, "gemini-2.5-flash-lite"));

    expect(calls).toHaveLength(3);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err.message).toContain("a2f1f3165944196d");
    // Not retried a second time: the compressed body is what was just refused.
    expect(calls[2]!.contentType).toBe(CHAT_ENCODED_CONTENT_TYPE);
  });

  it("does not retry the gateway's own 403", async () => {
    const own = new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const calls = script(own);
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));

    expect(calls).toHaveLength(1);
    // The body survived the peek: classifying a failure must not consume it.
    expect(err.message).toContain("forbidden");
  });

  it("explains a block that survived the retry, and says what actually helps", async () => {
    const calls = script(blocked(), blocked());
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));

    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err.message).toContain("a2f1f3165944196d");
    // Not "try again": the next turn carries the same history.
    expect(err.message).toContain("/clear");
    expect(err.message).toContain("nothing was charged");
  });

  it("distinguishes a gateway too old to accept the encoding", async () => {
    script(blocked(), new Response(JSON.stringify({ error: "Unsupported Media Type" }), { status: 415 }));
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));

    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect((err as EdgeBlockedError).outcome).toBe("unsupported");
    // A deploy fixes this one; /clear does not.
    expect(err.message).toContain("Update the gateway");
  });

  it("streams through the same path", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"clixad":{"credits_charged":3,"balance":7}}\n\n' +
      "data: [DONE]\n\n";
    const calls = script(blocked(), new Response(sse, { status: 200 }));
    const turn = await new GatewayClient(config).chatStream(MESSAGES, "gemini-2.5-flash-lite");

    expect(turn.message.content).toBe("hi");
    expect(calls[1]!.contentType).toBe(CHAT_ENCODED_CONTENT_TYPE);
  });
});

describe("a search that trips the same filter", () => {
  it("tells the model what happened and what to do instead", async () => {
    script(blocked());
    const err = await failure(new GatewayClient(config).webSearch("reject ../../../etc/passwd"));
    expect(err.message).toContain("security filter");
    expect(err.message).toContain("a2f1f3165944196d");
    expect(err.message).toContain("web_fetch");
    expect(err.message).not.toContain("<");
  });

  it("leaves the gateway's own errors alone", async () => {
    script(new Response(JSON.stringify({ message: "quota reached" }), { status: 429 }));
    const err = await failure(new GatewayClient(config).webSearch("anything"));
    expect(err.message).toBe("quota reached");
  });
});

/**
 * The other way a session dies at the edge.
 *
 * Reported as `chat failed: 503` and nothing else. `/v1/chat/completions`
 * cannot answer 503 — 400 unknown model, 401 bad token, 402 empty wallet, 429
 * its own limiter, 500 a failed provider, and a provider that dies mid-stream
 * is an error frame rather than a status — so every 503 seen on that route came
 * from in front of it, and the CLI printed the number and gave up. All fourteen
 * catalog models were checked against the live gateway first: every one of them
 * answers, so this was never about a model.
 */
describe("the edge failing rather than refusing", () => {
  /** Render's router with no instance to hand the request to. */
  const OUTAGE_PAGE =
    `<!DOCTYPE html><html><head><title>Service Unavailable</title></head>` +
    `<body><h1>Service Unavailable</h1>` +
    `<div>Cloudflare Ray ID: <strong>b1c2d3e4f5a60718</strong></div></body></html>`;

  function outage(status = 503, headers: Record<string, string> = {}): Response {
    return new Response(OUTAGE_PAGE, {
      status,
      headers: { "content-type": "text/html", server: "cloudflare", ...headers },
    });
  }

  it("reads a router's 503 as transient, not as a WAF block", () => {
    const found = detectEdgeOutage(503, new Headers({ server: "cloudflare" }), OUTAGE_PAGE);
    expect(found).toMatchObject({ status: 503, kind: "unreachable", rayId: "b1c2d3e4f5a60718" });
    // And the WAF classifier still declines it, which is what keeps the advice
    // from becoming "/clear the conversation" for a restart.
    expect(detectEdgeBlock(503, new Headers({ server: "cloudflare" }), OUTAGE_PAGE)).toBeUndefined();
  });

  it("calls a 502 and a 504 interrupted, because they may have been billed", () => {
    expect(detectEdgeOutage(502, new Headers(), "")?.kind).toBe("interrupted");
    expect(detectEdgeOutage(504, new Headers(), "")?.kind).toBe("interrupted");
  });

  it("does not call the gateway's own 429 an outage", () => {
    // Both ends can send a 429, and only one of them should be retried.
    const body = JSON.stringify({ error: "rate_limited", retry_after_ms: 4000 });
    expect(detectEdgeOutage(429, new Headers({ "content-type": "application/json" }), body)).toBeUndefined();
  });

  it("leaves every other status to the caller", () => {
    expect(detectEdgeOutage(403, new Headers(), OUTAGE_PAGE)).toBeUndefined();
    expect(detectEdgeOutage(500, new Headers(), "boom")).toBeUndefined();
  });

  it("resends the request and finishes the turn when the gateway comes back", async () => {
    vi.useFakeTimers();
    const calls = script(outage(), outage(), completion());
    const client = new GatewayClient(config);
    const notices: string[] = [];
    client.onNotice = (t) => notices.push(t);

    const pending = client.chat(MESSAGES, "gemini-2.5-flash-lite");
    await vi.runAllTimersAsync();
    const turn = await pending;

    expect(turn.creditsCharged).toBe(12);
    expect(calls).toHaveLength(3);
    // Identical bytes every time: nothing about the request caused this, so the
    // WAF's compressed workaround must not be dragged in.
    expect(calls.every((c) => c.contentType === "application/json")).toBe(true);
    expect(calls[0]!.body).toBe(calls[2]!.body);
    // Said once on the way in, once on the way out. A locked keyboard and a
    // silent half-minute is indistinguishable from a hang.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("did not answer");
    expect(notices[1]).toContain("answering again");
  });

  it("streams through the same path", async () => {
    vi.useFakeTimers();
    const calls = script(outage(), stream());
    const pending = new GatewayClient(config).chatStream(MESSAGES, "gemini-2.5-flash-lite");
    await vi.runAllTimersAsync();
    const turn = await pending;
    expect(turn.message.content).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of tries and explains what happened", async () => {
    vi.useFakeTimers();
    const calls = script(...Array.from({ length: OUTAGE_RETRIES + 1 }, () => outage()));
    const client = new GatewayClient(config);

    const pending = client.chat(MESSAGES, "gemini-2.5-flash-lite");
    const settled = failure(pending);
    await vi.runAllTimersAsync();
    const err = await settled;

    expect(calls).toHaveLength(OUTAGE_RETRIES + 1);
    expect(err.name).toBe("EdgeOutageError");
    expect(err.message).toContain("nothing was charged");
    // The opposite advice to the WAF block's, and the reason these are two
    // classifications rather than one: the conversation was never the problem.
    expect(err.message).toContain("do not /clear");
    expect(err.message).toContain("b1c2d3e4f5a60718");
    // The gateway this session is actually pointed at, not a baked-in one.
    expect(err.message).toContain(`${config.gatewayUrl}/healthz`);
    // The old message, which is what the bug report quoted.
    expect(err.message).not.toBe("chat failed: 503");
    // And the page it came from still never reaches a renderer.
    expect(err.message).not.toContain("<");
  });

  it("does not resend a 502, and does not promise it was free", async () => {
    const calls = script(outage(502), completion());
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));
    expect(calls).toHaveLength(1);
    expect(err.message).toContain("may have been generated and charged");
    expect(err.message).toContain("/wallet");
    expect(err.message).not.toContain("nothing was charged");
  });

  it("waits what the edge asked, when it asked for something sane", async () => {
    vi.useFakeTimers();
    const calls = script(outage(503, { "retry-after": "3" }), completion());
    const pending = new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite");

    // Past the first backoff step, which would have resent by now.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(1);

    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(2);
    await expect(pending).resolves.toMatchObject({ creditsCharged: 12 });
  });

  it("will not let retry-after shorten a wait, only lengthen it", async () => {
    // RFC 7231 allows `retry-after: 0`, `??` does not fall through zero, and the
    // documented half-minute schedule became six requests in a few hundred
    // milliseconds at a gateway that was already struggling.
    vi.useFakeTimers();
    const calls = script(
      ...Array.from({ length: OUTAGE_RETRIES + 1 }, () => outage(503, { "retry-after": "0" })),
    );
    const pending = new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite");
    const settled = failure(pending);

    await vi.advanceTimersByTimeAsync(900); // still inside the first backoff step
    expect(calls).toHaveLength(1);

    await vi.runAllTimersAsync();
    const err = await settled;
    // The schedule survived the header, and the sentence still says so.
    expect(calls).toHaveLength(OUTAGE_RETRIES + 1);
    expect(err.message).toContain(`resent ${OUTAGE_RETRIES} times over about 31s`);
  });

  it("quotes the wait that happened, not the one that was scheduled", async () => {
    vi.useFakeTimers();
    script(...Array.from({ length: OUTAGE_RETRIES + 1 }, () => outage(503, { "retry-after": "30" })));
    const pending = new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite");
    const settled = failure(pending);
    await vi.runAllTimersAsync();
    const err = await settled;

    // Five 30s waits. Summing the backoff schedule instead would say "31s" to
    // somebody who has just sat through two and a half minutes.
    expect(err.message).toContain(`resent ${OUTAGE_RETRIES} times over about 150s`);
  });

  it("says the wait is over even when the gateway's own answer is a refusal", async () => {
    vi.useFakeTimers();
    const paywall = new Response(
      JSON.stringify({ error: "insufficient_credits", message: "Out of credits.", balance: 0 }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const client = new GatewayClient(config);
    const notices: string[] = [];
    client.onNotice = (t) => notices.push(t);
    script(outage(), paywall);

    const pending = client.chat(MESSAGES, "gemini-2.5-flash-lite");
    const settled = failure(pending);
    await vi.runAllTimersAsync();
    await settled;

    // The outage ended — the gateway answered. Tied to `res.ok` this would have
    // left the wait visibly open forever.
    expect(notices.at(-1)).toContain("answering again");
  });

  it("claims nothing about the compressed body when the edge answered instead", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient(config);
    const notices: string[] = [];
    client.onNotice = (t) => notices.push(t);
    // Blocked, compressed, and the router answers the compressed one: that says
    // nothing about whether the filter would have passed it.
    const calls = script(blocked(), outage(), blocked(), completion());

    const pending = client.chat(MESSAGES, "gemini-2.5-flash-lite");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ creditsCharged: 12 });

    expect(calls.map((c) => c.contentType)).toEqual([
      "application/json",
      CHAT_ENCODED_CONTENT_TYPE,
      // Plain again: the transport was not pinned on a response that never
      // reached the gateway.
      "application/json",
      CHAT_ENCODED_CONTENT_TYPE,
    ]);
    // And "got through" is said once, about the attempt that actually did.
    expect(notices.filter((n) => n.includes("got through"))).toHaveLength(1);
    expect(notices.findIndex((n) => n.includes("got through"))).toBeGreaterThan(
      notices.findIndex((n) => n.includes("did not answer")),
    );
  });

  it("hands the gateway's own 429 back untouched, body and all", async () => {
    const body = JSON.stringify({ error: "rate_limited", message: "Too many requests — slow down." });
    const calls = script(
      new Response(body, { status: 429, headers: { "content-type": "application/json" } }),
    );
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));
    expect(calls).toHaveLength(1); // a limiter is waited out, never retried into
    expect(err.message).toContain("429");
    expect(err.message).toContain("slow down");
  });
});

describe("nothing upstream reaches the terminal", () => {
  // The exact regression: this string used to be the error message.
  it("never puts the block page in an error message", async () => {
    script(blocked(), blocked());
    const err = await failure(new GatewayClient(config).chat(MESSAGES, "gemini-2.5-flash-lite"));
    expect(err.message).not.toContain("<");
    expect(err.message).not.toContain("cf-error-footer");
    expect(err.message.length).toBeLessThan(700);
  });

  it("reduces an error page to its title", () => {
    expect(safeDetail(CF_BLOCK_PAGE)).toBe("Attention Required! | Cloudflare");
  });

  it("truncates, strips markup, and drops escape sequences", () => {
    expect(safeDetail("x".repeat(500))).toHaveLength(200);
    expect(safeDetail("<p>hello   there</p>")).toBe("hello there");
    expect(safeDetail("\u001b[31mred\u001b[0m")).toBe("red");
    expect(safeDetail("\u001b]0;retitled\u0007plain")).toBe("plain");
    expect(safeDetail("")).toBe("");
  });

  it("bounds an error notice in both directions", () => {
    // Either one alone is enough to overflow the frame: many short lines, or
    // one line that wraps forty times.
    const many = errorNotice(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));
    expect(many.split("\n")).toHaveLength(13); // 12 rows plus the "+N more" line
    expect(many).toContain("+388 more lines");

    const wide = errorNotice("y".repeat(100_000));
    expect(wide.split("\n")).toHaveLength(1);
    expect(wide.length).toBeLessThanOrEqual(2_400);
    // Twelve lines of a thousand: the budget is spent on the first two and a
    // half, and the rest are counted rather than printed.
    const both = errorNotice(Array.from({ length: 12 }, () => "z".repeat(1_000)).join("\n"));
    expect(both.length).toBeLessThanOrEqual(2_400 + 40);
    expect(both).toContain("+9 more lines");
  });

  it("prints the gateway's refusal at the daily limit whole, not to the 200th character", () => {
    // The message every published CLI cut at "Credits you earn on the of…"
    // (2026-10-12), as one line and as the lines the gateway now sends.
    const sentence =
      "You have reached your personal daily limit of 40,000 bonus credits (credits we granted, like the " +
      "signup bonus or our own surveys). It resets at 00:00 UTC (in about 9 h 3 min). Credits you earn on the " +
      "offer walls or buy have no daily limit, so you can keep going today with /earn or a pack from $3 (/buy). " +
      "There are no free turns left for you today. Nothing was charged for this request.";
    expect(errorNotice(sentence)).toBe(sentence);
    expect(errorNotice("one\ntwo\nthree", undefined, "  ")).toBe("one\n  two\n  three");
  });

  it("keeps a control sequence from being executed by the terminal", () => {
    // A body is bytes from somewhere else; an escape in it is an instruction.
    const notice = errorNotice("before\u001b[2Jafter");
    expect(notice).not.toContain("\u001b");
    expect(notice).not.toContain("[2J");
    expect(notice).toContain("before");
  });

  it("keeps real newlines, which are the only control character that means anything", () => {
    expect(errorNotice("one\ntwo")).toBe("one\ntwo");
  });
});
