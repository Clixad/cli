/**
 * What a 401 from the gateway URL actually means.
 *
 * Every 401 used to become `AuthError` — "Not logged in. Run `clixad login`
 * first." That is right for a bad bearer token and actively misleading for
 * anything else answering on the gateway URL: a platform SSO page, an auth
 * proxy, an expired tunnel. Those all 401 too, and `clixad login` goes to the
 * same URL and fails the same way, so the advice is a loop with no exit. It
 * matters most exactly when the base URL has just moved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  GatewayClient,
  LEDGER_REASONS,
  MaintenanceError,
  PaywallError,
  PremiumLockedError,
  accessColumn,
  adsPerTaskLabel,
  grantLabel,
  ledgerReasonLabel,
  packsFromClause,
  premiumHeadline,
  premiumLocked,
  premiumUnlockHint,
} from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
};

/** Stub global fetch with a single canned response. */
function respond(body: string, init: ResponseInit): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));
}

const JSON_401 = { status: 401, headers: { "content-type": "application/json" } };
const HTML_401 = { status: 401, headers: { "content-type": "text/html" } };

/** Await a call that must reject, and hand back the error it rejected with. */
async function failure(call: Promise<unknown>): Promise<Error> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  if (!err) throw new Error("expected the call to reject, but it resolved");
  return err;
}

afterEach(() => vi.unstubAllGlobals());

describe("401 handling", () => {
  it("treats the gateway's own JSON error as an auth failure", async () => {
    respond(JSON.stringify({ error: "invalid token" }), JSON_401);
    await expect(new GatewayClient(config).wallet()).rejects.toBeInstanceOf(AuthError);
  });

  // The case that used to send people round in circles.
  it("does not blame the token when 401 came from an SSO/proxy page", async () => {
    respond("<!doctype html><title>Authentication Required</title>", HTML_401);
    const err = await failure(new GatewayClient(config).wallet());
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err.message).toContain("without a Clixad error body");
    expect(err.message).toContain("CLIXAD_GATEWAY_URL");
  });

  // A JSON content-type is not enough on its own — proxies emit JSON errors too,
  // just not in our shape.
  it("does not blame the token for a JSON 401 that isn't ours", async () => {
    respond(JSON.stringify({ message: "Unauthorized", requestId: "abc" }), JSON_401);
    const err = await failure(new GatewayClient(config).wallet());
    expect(err).not.toBeInstanceOf(AuthError);
  });

  it("does not choke on a JSON content-type with an unparseable body", async () => {
    respond("not json at all", JSON_401);
    const err = await failure(new GatewayClient(config).wallet());
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err.message).toContain("without a Clixad error body");
  });

  it("applies to the metered paths too, naming the call that failed", async () => {
    respond("<html>login</html>", HTML_401);
    const streamErr = await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "gemini-2.5-flash-lite"),
    );
    expect(streamErr).not.toBeInstanceOf(AuthError);
    expect(streamErr.message).toMatch(/^chat:/);

    respond("<html>login</html>", HTML_401);
    const buyErr = await failure(
      new GatewayClient(config).checkout("starter", {
        requestImmediatePerformance: true,
        acknowledgeLossOfWithdrawal: true,
        at: "2026-09-08T00:00:00.000Z",
      }),
    );
    expect(buyErr.message).toMatch(/^checkout:/);
  });

  // Missing token is a client-side condition and never reaches the network, so it
  // stays an AuthError regardless of what the URL would have answered.
  it("still reports a missing token as an auth failure without calling out", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const anon = new GatewayClient({ ...config, token: undefined });
    await expect(anon.wallet()).rejects.toBeInstanceOf(AuthError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Every credit figure the CLI shows before an offer has been completed goes
 * through `grantLabel`. One number stands in for a wall whose payouts spread
 * widely, so it may only appear labelled as the median, with "on completion"
 * beside it; a bare figure next to a balance reads as what the next offer pays.
 */
describe("pre-completion earn figures", () => {
  it("labels the figure as the median, with the condition and no plus sign", () => {
    const label = grantLabel(51_000);
    expect(label).toBe("~51,000 credits on completion (median)");
    expect(label).not.toContain("+");
  });

  it("prints no figure at all when the gateway gives none it can use", () => {
    for (const missing of [undefined, 0, -1, Number.NaN]) {
      expect(grantLabel(missing), String(missing)).toBe("credits on completion");
      expect(grantLabel(missing), String(missing)).not.toMatch(/\d/);
    }
  });

  it("carries grant_per_ad from a 402 onto the paywall error", async () => {
    respond(
      JSON.stringify({ error: "insufficient_credits", balance: 12, estimated_cost: 1190, grant_per_ad: 51_000 }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "gemini-2.5-flash-lite"),
    )) as PaywallError;
    expect(err).toBeInstanceOf(PaywallError);
    expect(err.grantPerAd).toBe(51_000);
    expect(grantLabel(err.grantPerAd)).toBe("~51,000 credits on completion (median)");
  });

  it("carries the free models a 402 offers, as the way out that costs nothing", async () => {
    respond(
      JSON.stringify({
        error: "insufficient_credits",
        balance: 12,
        estimated_cost: 1190,
        grant_per_ad: 51_000,
        free_models: [
          { id: "gpt-5-nano", turns_left: 31 },
          { id: "kimi-k2.5", turns_left: 3 },
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
    )) as PaywallError;
    // Order is the gateway's — cheapest first, so the first row is the one that
    // buys the most turns — and it is not re-sorted here.
    expect(err.freeModels).toEqual([
      { id: "gpt-5-nano", turnsLeft: 31 },
      { id: "kimi-k2.5", turnsLeft: 3 },
    ]);
  });

  it("carries the cheapest pack a 402 names, and nothing for a figure it cannot use", async () => {
    const cases: [Record<string, unknown>, number | null][] = [
      [{ cheapest_pack_usd: 3 }, 3],
      [{}, null], // an older gateway, or one that sells no packs
      [{ cheapest_pack_usd: "3" }, null],
      [{ cheapest_pack_usd: 0 }, null],
      [{ cheapest_pack_usd: null }, null],
    ];
    for (const [extra, expected] of cases) {
      respond(
        JSON.stringify({ error: "insufficient_credits", balance: 12, estimated_cost: 1190, grant_per_ad: 1, ...extra }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
      const err = (await failure(
        new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-haiku-4.5"),
      )) as PaywallError;
      expect(err.cheapestPackUsd, JSON.stringify(extra)).toBe(expected);
    }
    expect(packsFromClause(3)).toBe(", from $3");
    expect(packsFromClause(7.5)).toBe(", from $7.50");
    expect(packsFromClause(null)).toBe("");
  });

  it("carries the own survey a 402 offers, and nothing for a body it cannot use (2026-10-19)", async () => {
    const cases: [Record<string, unknown>, { credits: number; leftToday: number } | null][] = [
      [{ own_survey: { credits: 10_000, left_today: 4 } }, { credits: 10_000, leftToday: 4 }],
      [{}, null], // an older gateway, a premium model, or no survey open
      [{ own_survey: { credits: "10000", left_today: 4 } }, null],
      [{ own_survey: { credits: 10_000, left_today: 0 } }, null],
      [{ own_survey: null }, null],
    ];
    for (const [extra, expected] of cases) {
      respond(
        JSON.stringify({ error: "insufficient_credits", balance: 12, estimated_cost: 1190, grant_per_ad: 1, ...extra }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
      const err = (await failure(
        new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "kimi-k2.5"),
      )) as PaywallError;
      expect(err.ownSurvey, JSON.stringify(extra)).toEqual(expected);
    }
  });

  it("offers nothing when the gateway says nothing, and treats the three silences alike", async () => {
    // An older gateway sends no field; a paused tier sends an empty list; a 402
    // for something never free (a web search) sends no field either. A caller
    // has the same thing to do in all three cases, so they arrive the same way.
    for (const extra of [{}, { free_models: [] }, { free_models: null }]) {
      respond(
        JSON.stringify({ error: "insufficient_credits", balance: 0, estimated_cost: 9, grant_per_ad: 1, ...extra }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
      const err = (await failure(
        new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
      )) as PaywallError;
      expect(err.freeModels).toEqual([]);
    }
  });

  it("drops entries it cannot use rather than the whole refusal", async () => {
    // The body comes from a server this CLI does not ship with. A malformed row
    // costs that row; a 402 that failed to parse would cost somebody the notice
    // telling them why their turn stopped.
    respond(
      JSON.stringify({
        error: "insufficient_credits",
        balance: 0,
        estimated_cost: 9,
        grant_per_ad: 1,
        free_models: [
          { id: "gpt-5-nano", turns_left: 4 },
          { id: "", turns_left: 9 },
          { id: "spent", turns_left: 0 },
          { id: "broken", turns_left: "lots" },
          null,
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
    )) as PaywallError;
    expect(err.freeModels).toEqual([{ id: "gpt-5-nano", turnsLeft: 4 }]);
  });

  // A gateway deployed before 2026-09-15 still sends the advertised range. It is
  // not carried anywhere: printed, it would be a spread with no wall, count or date.
  it("does not carry a grant_per_ad_range an older gateway still sends", async () => {
    respond(
      JSON.stringify({
        error: "insufficient_credits",
        balance: 12,
        estimated_cost: 1190,
        grant_per_ad: 51_000,
        grant_per_ad_range: [40_000, 300_000],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "gemini-2.5-flash-lite"),
    )) as PaywallError;
    expect(err.grantPerAd).toBe(51_000);
    expect("grantRange" in err).toBe(false);
  });
});

describe("the effort estimate", () => {
  it("names the median and the condition, and never rounds down to zero", () => {
    expect(adsPerTaskLabel(2.8)).toBe("~2.8 ads/task on completion (median)");
    expect(adsPerTaskLabel(0.04)).toBe("<1 ad/task on completion (median)");
  });
});

/**
 * A reversal is the only ledger entry a user cannot account for on their own:
 * the ad network charges a conversion back long after the reward was granted,
 * credits they had already earned disappear, and nothing they did caused it.
 */
describe("ledger reason labels", () => {
  it("explains a reversal as the provider's action, not an unexplained loss", () => {
    const label = ledgerReasonLabel("ad_reversal");
    expect(label).toBe("offer reward reversed by the provider");
    expect(label).not.toContain("_");
  });

  it("names every reason the store can write", () => {
    // Every ledger reason the gateway's store can write. Asserted
    // against the map rather than the function, because the function's fallback
    // would happily paper over a missing entry — which is how `ad_reversal`
    // reached a user's screen as `ad_reversal` in the first place.
    for (const reason of ["signup_bonus", "ad_reward", "purchase", "usage", "refund", "ad_reversal"]) {
      expect(LEDGER_REASONS, reason).toHaveProperty(reason);
      expect(ledgerReasonLabel(reason), reason).not.toContain("_");
    }
  });

  it("degrades to readable text for a reason it does not know", () => {
    expect(ledgerReasonLabel("some_new_reason")).toBe("some new reason");
  });
});

/** An SSE stream from raw text. */
function sse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("chatStream survives a frame it cannot parse", () => {
  it("skips it and still reports the answer and the credits", async () => {
    globalThis.fetch = (async () =>
      sse(
        `: keep-alive\n\n` +
        `data: {"choices":[{"delta":{"content":"hel"}}]}\n\n` +
        `data: <html>something in the middle wrote this</html>\n\n` +
        `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"clixad":{"credits_charged":7,"balance":93}}\n\n` +
        `data: [DONE]\n\n`,
      )) as typeof fetch;
    const turn = await new GatewayClient({ ...config }).chatStream([{ role: "user", content: "hi" }], "gpt-5-nano");
    expect(turn.message.content).toBe("hello");
    expect(turn.creditsCharged).toBe(7);
    expect(turn.balance).toBe(93);
    expect(turn.finishReason).toBe("stop");
  });
});

describe("the maintenance refusal", () => {
  const MESSAGE = "Clixad is currently down due to high demand. Please check again later.";
  const JSON_503 = { status: 503, headers: { "content-type": "application/json" } };

  it("is a MaintenanceError carrying the gateway's sentence, from a stream frame with no credits block", async () => {
    globalThis.fetch = (async () =>
      sse(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "error" }],
          error: { type: "maintenance", message: MESSAGE },
        })}\n\n` + `data: [DONE]\n\n`,
      )) as typeof fetch;
    const err = await failure(new GatewayClient({ ...config }).chatStream([{ role: "user", content: "hi" }], "kimi-k2.5"));
    expect(err).toBeInstanceOf(MaintenanceError);
    expect(err.message).toBe(MESSAGE);
  });

  it("is a MaintenanceError from a non-streamed 503 of the gateway's", async () => {
    respond(JSON.stringify({ error: "maintenance", message: MESSAGE }), JSON_503);
    const err = await failure(new GatewayClient({ ...config }).chat([{ role: "user", content: "hi" }], "kimi-k2.5"));
    expect(err).toBeInstanceOf(MaintenanceError);
    expect(err.message).toBe(MESSAGE);
  });

  it("leaves any other 503 of the gateway's as the failure it was", async () => {
    respond(JSON.stringify({ error: "database_stalled" }), JSON_503);
    const err = await failure(new GatewayClient({ ...config }).chatStream([{ role: "user", content: "hi" }], "kimi-k2.5"));
    expect(err).not.toBeInstanceOf(MaintenanceError);
    expect(err.message).toContain("chat failed: 503");
  });

  it("is a MaintenanceError from a web search too, and a plain 503 there still means no search key", async () => {
    respond(JSON.stringify({ error: "maintenance", message: MESSAGE }), JSON_503);
    const client = new GatewayClient({ ...config });
    const err = await failure(client.webSearch("vitest"));
    expect(err).toBeInstanceOf(MaintenanceError);
    respond(JSON.stringify({ error: "search_not_configured", message: "…" }), JSON_503);
    expect((await failure(client.webSearch("vitest"))).message).toContain("isn't enabled");
  });
});

describe("the sponsor config and report, with three formats", () => {
  const ok = (body: unknown) => respond(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("reads each extra format's publisher, row by row", async () => {
    ok({
      provider: "adtention",
      publisher_id: "pub_top",
      category: "devops",
      subject: "s",
      dwell_ms: 15_000,
      formats: {
        top_bar: { publisher_id: "pub_top" },
        sidebar_card: { publisher_id: "pub_side" },
        status_bar: { publisher_id: 7 }, // malformed: costs this row only
        banner: { publisher_id: "pub_banner" }, // a format this build cannot draw
      },
    });
    const conf = await new GatewayClient(config).sponsorConfig();
    expect(conf).toMatchObject({ publisherId: "pub_top", subject: "s" });
    expect(conf!.formats).toEqual({ sidebar_card: "pub_side" });
  });

  it("reads a gateway older than the formats as the top bar alone", async () => {
    ok({ provider: "adtention", publisher_id: "pub_top", category: "devops", subject: "s" });
    const conf = await new GatewayClient(config).sponsorConfig();
    expect(conf!.publisherId).toBe("pub_top");
    expect(conf!.formats).toBeUndefined();
  });

  it("sends a top-bar report exactly as before, and names any other format", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ credited: 5 }), { status: 200 });
      }),
    );
    const client = new GatewayClient(config);
    const base = { billable: true, fromCache: false, credit: 0.00005 };
    await client.reportImpression({ impressionId: "imp_1", ...base });
    await client.reportImpression({ impressionId: "imp_2", format: "top_bar", ...base });
    await client.reportImpression({ impressionId: "imp_3", format: "status_bar", ...base });
    expect("format" in bodies[0]!).toBe(false);
    expect("format" in bodies[1]!).toBe(false);
    expect(bodies[2]!.format).toBe("status_bar");
  });
});

// The device-flow poll is idempotent, so a failure that is not the gateway's own
// answer is something to poll through rather than the end of a login.
describe("devicePoll", () => {
  const signedOut: CliConfig = { ...config, token: undefined };

  it("reads an edge 5xx with no answer of ours in it as unavailable", async () => {
    respond("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    expect(await new GatewayClient(signedOut).devicePoll("s")).toEqual({ status: "unavailable", error: "http 502" });
    respond("", { status: 503 });
    expect(await new GatewayClient(signedOut).devicePoll("s")).toEqual({ status: "unavailable", error: "http 503" });
  });

  it("passes the gateway's own refusal through as it is", async () => {
    respond(JSON.stringify({ status: "error", error: "login_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    expect(await new GatewayClient(signedOut).devicePoll("s")).toEqual({ status: "error", error: "login_unavailable" });
    respond(JSON.stringify({ status: "error", error: "unknown_session" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    expect(await new GatewayClient(signedOut).devicePoll("s")).toEqual({ status: "error", error: "unknown_session" });
  });

  it("keeps a 4xx with no answer of ours as an error", async () => {
    respond("nope", { status: 404 });
    expect(await new GatewayClient(signedOut).devicePoll("s")).toEqual({ status: "error", error: "http 404" });
  });
});

describe("asking for booked lines", () => {
  const ask = () => new GatewayClient(config).directSponsor(["top_bar"], 80);

  it("reads a 404 as a gateway that does not know the route", async () => {
    respond(JSON.stringify({ error: "not found" }), { status: 404 });
    expect(await ask()).toEqual({ supported: false, lines: [] });
  });

  it("reads every other failure as nothing known this time, never as a throw", async () => {
    // `failed`: the caller keeps ADtention out of a slot the last answer said
    // was booked, rather than reading a timeout as "nothing booked".
    respond("upstream", { status: 503 });
    expect(await ask()).toEqual({ supported: true, lines: [], failed: true });
    respond("{not json", { status: 200 });
    expect(await ask()).toEqual({ supported: true, lines: [], failed: true });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await ask()).toEqual({ supported: true, lines: [], failed: true });
  });

  it("asks for the sponsor config as a CLI that shows booked lines", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ provider: "house" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await new GatewayClient(config).sponsorConfig()).toBeNull();
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${config.gatewayUrl}/v1/sponsor/config?direct=1`);
  });

  it("sends the slots and the width, and reads the lines", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ lines: [{ format: "top_bar", hold: true }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await ask()).toEqual({ supported: true, lines: [{ format: "top_bar", hold: true }] });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${config.gatewayUrl}/v1/sponsor/direct`);
    expect(JSON.parse(String(init.body))).toEqual({ formats: ["top_bar"], cols: 80 });
  });

  it("reports drawn booked lines to their own route, and never throws", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ credited: 5 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await new GatewayClient(config).reportDirectImpressions([{ format: "status_bar", serveToken: "tok" }])).toBe(5);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${config.gatewayUrl}/v1/sponsor/direct/impression`);
    expect(JSON.parse(String(init.body))).toEqual({ impressions: [{ format: "status_bar", serve_token: "tok" }] });
    expect(await new GatewayClient(config).reportDirectImpressions([])).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await new GatewayClient(config).reportDirectImpressions([{ format: "top_bar", serveToken: "t" }])).toBe(0);
  });
});

/**
 * The premium gate (2026-10-04) on the wire. A streamed refusal is an error
 * frame, which every published CLI prints as it stands; this CLI reads the
 * frame's `clixad.premium` too and builds a chooser from it. Neither shape may
 * turn into a `PaywallError`, whose every sentence would be wrong next to a
 * balance of bonus credits.
 */
describe("a premium refusal", () => {
  const PREMIUM_BODY = {
    model: "claude-opus-5.5",
    needed_credits: 16_500,
    premium_credits: 3_200,
    unlock_usd: 5,
    grant_per_ad: 41_000,
    free_models: [{ id: "deepseek-v4-flash", turns_left: 82 }],
  };
  const SENTENCE = "Premium: complete a survey or unlock from $5. Claude Opus 5.5 is a premium model.";

  it("is read out of the stream's error frame, with the gateway's figures", async () => {
    globalThis.fetch = (async () =>
      sse(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "error" }],
          error: { type: "premium_locked", message: SENTENCE },
          clixad: { credits_charged: 0, balance: 25_000, premium: PREMIUM_BODY },
        })}\n\n` + "data: [DONE]\n\n",
      )) as typeof fetch;
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
    )) as PremiumLockedError;
    expect(err).toBeInstanceOf(PremiumLockedError);
    expect(err).not.toBeInstanceOf(PaywallError);
    expect(err.message).toBe(SENTENCE);
    expect(err.neededCredits).toBe(16_500);
    expect(err.premiumCredits).toBe(3_200);
    expect(err.unlockUsd).toBe(5);
    expect(err.grantPerAd).toBe(41_000);
    expect(err.freeModels).toEqual([{ id: "deepseek-v4-flash", turnsLeft: 82 }]);
  });

  it("is read out of a 402 too, told apart from the wallet's by its error", async () => {
    respond(
      JSON.stringify({ error: "premium_locked", message: SENTENCE, balance: 25_000, premium: PREMIUM_BODY }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    const err = await failure(new GatewayClient(config).chat([{ role: "user", content: "hi" }], "claude-opus-5.5"));
    expect(err).toBeInstanceOf(PremiumLockedError);
  });

  it("costs a malformed field that field, never the refusal", async () => {
    globalThis.fetch = (async () =>
      sse(
        `data: ${JSON.stringify({
          error: { type: "premium_locked", message: SENTENCE },
          clixad: { credits_charged: 0, balance: 1, premium: { unlock_usd: "five", free_models: "none" } },
        })}\n\n` + "data: [DONE]\n\n",
      )) as typeof fetch;
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
    )) as PremiumLockedError;
    expect(err).toBeInstanceOf(PremiumLockedError);
    expect(err.model).toBe("claude-opus-5.5");
    expect(err.unlockUsd).toBeNull();
    expect(err.freeModels).toEqual([]);
  });

  it("ignores a streak block an older gateway still sends", async () => {
    // The login streak allowance ended on 2026-10-19; a gateway from before
    // then may still put one on the refusal, and it costs nothing.
    globalThis.fetch = (async () =>
      sse(
        `data: ${JSON.stringify({
          error: { type: "premium_locked", message: SENTENCE },
          clixad: {
            credits_charged: 0,
            balance: 1,
            premium: { ...PREMIUM_BODY, streak: { day: 2, min_day: 3, daily_credits: 10_000, credits_left: 0 } },
          },
        })}\n\n` + "data: [DONE]\n\n",
      )) as typeof fetch;
    const err = (await failure(
      new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "claude-opus-5.5"),
    )) as PremiumLockedError;
    expect(err).toBeInstanceOf(PremiumLockedError);
    expect(err).not.toHaveProperty("streak");
  });

  it("asks the wallet for premium access only when told to", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ balance: 1, ledger: [] }), { status: 200 });
      }),
    );
    const client = new GatewayClient(config);
    await client.wallet();
    await client.wallet(undefined, { premium: true });
    expect(urls).toEqual(["http://127.0.0.1:8787/v1/wallet", "http://127.0.0.1:8787/v1/wallet?premium=1"]);
  });

  it("reads the unlock price off the catalog, and nothing where none is sent", async () => {
    respond(JSON.stringify({ data: [], premium_unlock_usd: 5 }), { status: 200 });
    const client = new GatewayClient(config);
    await client.models();
    expect(client.premiumUnlockUsd).toBe(5);
    respond(JSON.stringify({ data: [] }), { status: 200 });
    await client.models();
    expect(client.premiumUnlockUsd).toBeNull();
  });
});

describe("the access column", () => {
  const premiumModel = { tier: "premium", access: "premium" as const };

  it("is the class, and locked only when the gateway said there is nothing to pay with", () => {
    expect(accessColumn({ tier: "mid", access: "budget" }, undefined)).toBe("budget  ");
    expect(accessColumn(premiumModel, undefined)).toBe("premium ");
    expect(accessColumn(premiumModel, { unlocked: false, credits: 0 })).toBe("locked  ");
    expect(accessColumn(premiumModel, { unlocked: false, credits: 1 })).toBe("premium ");
    expect(accessColumn(premiumModel, { unlocked: true, credits: 0 })).toBe("premium ");
    expect(premiumLocked(undefined)).toBe(false);
  });

  it("falls back to the tier on a gateway that sends no access", () => {
    expect(accessColumn({ tier: "mid" }, { unlocked: false, credits: 0 })).toBe("mid     ");
  });

  it("names the pack price only where there is one", () => {
    // "Offer-wall": our own surveys pay bonus credits, which never reach premium.
    expect(premiumUnlockHint(5)).toBe("premium: an offer-wall survey or $5 unlocks it");
    expect(premiumUnlockHint(null)).toBe("premium: an offer-wall survey unlocks it");
    expect(premiumHeadline(5)).toBe("Premium: complete an offer-wall survey or buy credits from $5.");
    expect(premiumHeadline(null)).toBe("Premium: complete an offer-wall survey to unlock it.");
  });
});
