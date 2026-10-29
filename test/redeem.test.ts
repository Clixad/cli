/**
 * Redeem codes, on the CLI's side of the wire.
 *
 * Almost all of it is `redeemMessage`, and that is the right place for the weight
 * to be: the gateway reports five outcomes rather than a boolean precisely so the
 * person who typed a code learns what to do next, and printing the raw status —
 * `wrong_account` — would throw that away again on the last hop.
 *
 * The other half is the split between a refusal and a failure. An expired code is
 * an *answer*: the request worked, the code did not. A gateway that is down is a
 * failure, and only that one throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, redeemMessage, type RedeemResult } from "../src/client.ts";
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

const result = (over: Partial<RedeemResult> = {}): RedeemResult => ({
  status: "redeemed",
  credited: 5_000,
  balance: 10_000,
  ...over,
});

describe("GatewayClient.redeem", () => {
  it("reads the outcome back", async () => {
    respond(JSON.stringify({ status: "redeemed", credited: 5_000, balance: 10_000 }));
    expect(await new GatewayClient(config).redeem("K7QM2XPDK7QM2XPD")).toEqual(result());
  });

  it("does not throw on a refusal, because a refusal is an answer", async () => {
    // The request worked; the code did not. A CLI that treated this as an error
    // would exit non-zero on somebody's typo.
    respond(JSON.stringify({ status: "used", credited: 0, balance: 4_000 }));
    expect((await new GatewayClient(config).redeem("x")).status).toBe("used");
  });

  it("throws when the gateway never answered", async () => {
    // The one case a script has to be able to see. `clixad redeem` sets a
    // non-zero exit code only here.
    respond("down", { status: 502 });
    await expect(new GatewayClient(config).redeem("x")).rejects.toThrow(/redeem failed: 502/);
  });

  it("reads an unrecognisable body as 'unknown' rather than crediting", async () => {
    respond(JSON.stringify({ hello: "world" }));
    expect(await new GatewayClient(config).redeem("x")).toEqual({
      status: "unknown",
      credited: 0,
      balance: 0,
    });
  });
});

describe("redeemMessage", () => {
  it("says what landed", () => {
    expect(redeemMessage(result())).toEqual({ ok: true, text: "+5,000 credits" });
  });

  it("gives each refusal its own thing to do", () => {
    // Five outcomes exist so that four of them are actionable. If any two of
    // these ever read the same, the distinction the gateway went to some trouble
    // to keep has been thrown away here.
    const texts = (["unknown", "used", "expired", "wrong_account"] as const).map(
      (status) => redeemMessage(result({ status, credited: 0 })).text,
    );
    expect(new Set(texts).size).toBe(4);
    for (const text of texts) expect(text.length).toBeGreaterThan(10);
  });

  it("sends somebody to the right fix for the wrong account", () => {
    // The one refusal whose answer is not "check your typing".
    expect(redeemMessage(result({ status: "wrong_account", credited: 0 })).text).toContain(
      "signed in as",
    );
  });

  it("marks only a redemption as ok", () => {
    expect(redeemMessage(result()).ok).toBe(true);
    for (const status of ["unknown", "used", "expired", "wrong_account"] as const) {
      expect(redeemMessage(result({ status, credited: 0 })).ok, status).toBe(false);
    }
  });

  it("reads a zero-credit redemption as spent, not as an error", () => {
    // Derived from the status rather than from `credited`, so a code that
    // somehow granted nothing still reads as used up rather than as a failure.
    expect(redeemMessage(result({ credited: 0 })).ok).toBe(true);
  });

  it("groups the figure like every other credit amount the CLI prints", () => {
    expect(redeemMessage(result({ credited: 1_000_000 })).text).toBe("+1,000,000 credits");
  });
});
