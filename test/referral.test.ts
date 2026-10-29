/**
 * Referrals, on the CLI's side of the wire.
 *
 * The whole of this feature that lives in the CLI is one command and one
 * renderer, and what the renderer says is the feature: a code with no
 * instructions is a code nobody passes on, and a summary that implied a *signup*
 * was worth credits would be promising something the design deliberately does not
 * do. So the assertions here are mostly about wording, and they are the right
 * assertions to have — every figure in that wording came from the gateway, and
 * every claim in it is a claim about how the money works.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, referLines, type ReferralInfo } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
};

const JSON_OK = { status: 200, headers: { "content-type": "application/json" } };
const respond = (body: string, init: ResponseInit = JSON_OK) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));

afterEach(() => vi.unstubAllGlobals());

const info = (over: Partial<ReferralInfo> = {}): ReferralInfo => ({
  code: "K7QM2XPD",
  invited: 0,
  credited: 0,
  creditsEarned: 0,
  remaining: 20,
  maxCredited: 20,
  inviterCredits: 5_000,
  inviteeCredits: 5_000,
  ...over,
});

describe("GatewayClient.referral", () => {
  it("reads the summary back", async () => {
    respond(
      JSON.stringify({
        code: "K7QM2XPD",
        invited: 3,
        credited: 1,
        credits_earned: 5_000,
        remaining: 19,
        max_credited: 20,
        inviter_credits: 5_000,
        invitee_credits: 5_000,
      }),
    );
    expect(await new GatewayClient(config).referral()).toEqual(info({
      invited: 3,
      credited: 1,
      creditsEarned: 5_000,
      remaining: 19,
    }));
  });

  it("throws rather than printing an empty summary", async () => {
    // Unlike `claimStreak` and `sendFeedback`, this one *is* the command: a
    // `clixad refer` with nothing to print is a command that did not run, and
    // saying so beats four lines of zeroes.
    respond("nope", { status: 503 });
    await expect(new GatewayClient(config).referral()).rejects.toThrow(/referrals failed: 503/);
  });

  it("throws when the gateway answers 200 without a code", async () => {
    // A proxy or an SSO page answering with its own JSON must not become a
    // referral summary whose code is `undefined`.
    respond(JSON.stringify({ invited: 3 }));
    await expect(new GatewayClient(config).referral()).rejects.toThrow(/referral code/);
  });
});

describe("referLines", () => {
  it("leads with the code and the command that uses it", () => {
    const [code, share] = referLines(info());
    expect(code).toBe("your code: K7QM2XPD");
    // A code with no instructions is a code nobody passes on.
    expect(share).toBe("share it: clixad login --invite K7QM2XPD");
  });

  it("says what both people get, and on what condition", () => {
    const lines = referLines(info());
    // "You both get" is the half that makes somebody send it — the other
    // person's bonus is not a footnote to the sender's. And the condition is
    // stated rather than buried: a signup pays nothing.
    expect(lines[2]).toBe(
      "you both get 5,000 credits once they complete their first offer",
    );
  });

  it("takes both figures from the gateway, never from the CLI", () => {
    // The CLI cannot import the pricing engine, so a different grant has to
    // produce different wording.
    expect(referLines(info({ inviterCredits: 1_234 }))[2]).toContain("1,234 credits");
  });

  it("says plainly that nobody has used it yet", () => {
    // Three zeroes on the day somebody first runs this reads like a broken
    // command.
    expect(referLines(info())).toContain("nobody has signed up with it yet");
  });

  it("separates who signed up from who has actually earned", () => {
    const lines = referLines(info({ invited: 3, credited: 1, creditsEarned: 5_000, remaining: 19 }));
    expect(lines).toContain("3 signed up · 1 completed an offer · 5,000 credits earned");
    // The gap between the two is the ordinary case, not a failure: plenty of
    // accounts sign up and never finish an offer, and being screened out of one
    // pays nothing.
    expect(lines).toContain("2 haven't completed an offer yet — that pays nothing until they do");
  });

  it("does not invent a waiting line when everybody has converted", () => {
    const lines = referLines(info({ invited: 2, credited: 2, creditsEarned: 10_000, remaining: 18 }));
    expect(lines.join("\n")).not.toContain("haven't completed");
  });

  it("says when the cap has been reached", () => {
    const lines = referLines(info({ invited: 25, credited: 20, creditsEarned: 100_000, remaining: 0 }));
    expect(lines).toContain("you've been paid for the maximum of 20 referrals");
    // ...and the count keeps rising past it, which is the whole reason the cap
    // stops the crediting rather than the counting.
    expect(lines.join("\n")).toContain("25 signed up");
  });
});
