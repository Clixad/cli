/**
 * The login streak, on the CLI's side of the wire.
 *
 * Two things are being held here, and both are about restraint rather than
 * arithmetic:
 *
 *  - **`claimStreak` never throws.** Three surfaces call it — a login, the REPL
 *    opening, `wallet` — and all three are decorating something that already
 *    works. A gateway too old for the route, a cold start, a dropped connection
 *    and an expired token all mean "say nothing about a streak"; a session that
 *    died over a status line would be a real loss for a made-up one.
 *  - **No credit figure originates in this program.** The CLI cannot import the
 *    pricing engine (the bundle ships standalone through npm), so every number
 *    `streakLabel` prints comes out of what the gateway sent. The test asserts
 *    the label follows the schedule it is handed rather than a constant, which is
 *    the same defence the sponsored line's `needs` placeholders provide.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, streakLabel, type StreakInfo } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
};

const JSON_OK = { status: 200, headers: { "content-type": "application/json" } };

function respond(body: string, init: ResponseInit = JSON_OK): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));
}

afterEach(() => vi.unstubAllGlobals());

const streak = (over: Partial<StreakInfo> = {}): StreakInfo => ({
  day: 3,
  credits: 400,
  claimed: true,
  balance: 5_400,
  schedule: [200, 300, 400, 500, 700, 900, 1000],
  length: 7,
  ...over,
});

describe("claimStreak", () => {
  it("reads back what the gateway granted", async () => {
    respond(
      JSON.stringify({
        day: 3,
        credits: 400,
        claimed: true,
        balance: 5_400,
        schedule: [200, 300, 400],
        length: 3,
      }),
    );
    const result = await new GatewayClient(config).claimStreak();
    expect(result).toEqual({
      day: 3,
      credits: 400,
      claimed: true,
      balance: 5_400,
      schedule: [200, 300, 400],
      length: 3,
    });
  });

  it("answers null on a 404, so an older gateway simply says nothing", async () => {
    respond("not found", { status: 404 });
    expect(await new GatewayClient(config).claimStreak()).toBeNull();
  });

  it("answers null on a 401 rather than throwing at the caller", async () => {
    // Every caller is beside something that already works. A stale token means
    // no streak line, not a stack trace on top of a session.
    respond(JSON.stringify({ error: "invalid token" }), { status: 401 });
    expect(await new GatewayClient(config).claimStreak()).toBeNull();
  });

  it("answers null when the connection fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await new GatewayClient(config).claimStreak()).toBeNull();
  });

  it("refuses a 200 that is not a streak", async () => {
    // A proxy or an SSO page answering 200 with its own JSON must not become a
    // streak of `undefined` that the label then renders as "day NaN".
    respond(JSON.stringify({ hello: "world" }));
    expect(await new GatewayClient(config).claimStreak()).toBeNull();
  });
});

describe("the premium half of the streak (2026-10-06 to 2026-10-19)", () => {
  it("is gone: an older gateway's block is ignored, and the label says nothing about premium", async () => {
    respond(
      JSON.stringify({ day: 2, credits: 300, claimed: true, balance: 1, schedule: [200, 300, 400], length: 3, premium: { min_day: 3, daily_credits: 10_000 } }),
    );
    const claimed = await new GatewayClient(config).claimStreak();
    expect(claimed).not.toHaveProperty("premium");
    expect(streakLabel(claimed!)).toBe("daily streak: day 2 of 3 · +300 credits · tomorrow 400");
  });
});

describe("streakLabel", () => {
  it("announces the grant, and what tomorrow is worth", () => {
    expect(streakLabel(streak())).toBe("daily streak: day 3 of 7 · +400 credits · tomorrow 500");
  });

  it("says nothing happened when today was already counted", () => {
    // The claim is idempotent and three surfaces make it, so a label that
    // announced a grant every time would report the same 400 credits three
    // times before breakfast.
    expect(streakLabel(streak({ claimed: false, credits: 0 }))).toBe(
      "daily streak: day 3 of 7 · today's already counted",
    );
  });

  it("quotes the same rung again once the ramp has flattened", () => {
    // Day 7 of 7: tomorrow pays what today paid, because the ramp is a ramp and
    // not a wheel. Read out of the schedule, so extending it needs no edit here.
    expect(streakLabel(streak({ day: 7, credits: 1000 }))).toBe(
      "daily streak: day 7 of 7 · +1,000 credits · tomorrow 1,000",
    );
  });

  it("takes every figure from the schedule it was handed", () => {
    // The defence against a literal creeping into this program: with a different
    // ramp, the line has to say different numbers.
    expect(streakLabel({ ...streak(), schedule: [1, 2, 3], length: 3, day: 2, credits: 2 })).toBe(
      "daily streak: day 2 of 3 · +2 credits · tomorrow 3",
    );
  });

  it("draws nothing when the gateway sent no ramp", () => {
    expect(streakLabel(streak({ schedule: [], length: 0 }))).toBeNull();
  });

  it("groups five-figure amounts, like every other credit figure the CLI prints", () => {
    expect(streakLabel(streak({ credits: 12_345 }))).toContain("+12,345 credits");
  });
});
