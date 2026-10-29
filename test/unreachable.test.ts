/**
 * A gateway that cannot be reached, said in words somebody can act on.
 *
 * Node reports every network failure as `TypeError: fetch failed`, and that bare
 * phrase is what `clixad models` printed on a train with no signal. Every
 * request the client makes goes through `gatewayFetch`, which names the host
 * and the code, and says what the failure means for the balance. That last part
 * is the one that must not be approximated: a connection that never opened
 * cannot have been charged, one that broke part way may have been.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, GatewayUnreachableError, gatewayFetch, shortfallHeadline } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";

const config: CliConfig = {
  gatewayUrl: "https://clixad.onrender.com",
  dashboardUrl: "https://clixad.onrender.com",
  token: "adg_test",
  model: "deepseek-v4-flash",
};

/** What undici throws: a TypeError whose cause carries the socket's code. */
function networkFailure(code: string, nested = false): TypeError {
  const socket = Object.assign(new Error(`connect ${code}`), { code });
  const cause = nested ? new AggregateError([socket], "all attempts failed") : socket;
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function failWith(err: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw err;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a gateway that cannot be reached", () => {
  it("names the host and the code instead of 'fetch failed'", async () => {
    failWith(networkFailure("ENOTFOUND"));
    const err = await new GatewayClient(config).models().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayUnreachableError);
    expect((err as Error).message).toContain("clixad.onrender.com (ENOTFOUND)");
    expect((err as Error).message).not.toContain("fetch failed");
  });

  it("says nothing was charged only when no connection was ever made", async () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      failWith(networkFailure(code));
      const err = await gatewayFetch("https://clixad.onrender.com/v1/models").catch((e: unknown) => e);
      expect((err as Error).message, code).toContain("nothing was charged");
    }
  });

  it("tells somebody to check their balance when the connection broke part way", async () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"]) {
      failWith(networkFailure(code));
      const err = await gatewayFetch("https://clixad.onrender.com/v1/chat/completions").catch((e: unknown) => e);
      expect((err as Error).message, code).not.toContain("nothing was charged");
      expect((err as Error).message, code).toContain("check your balance");
    }
  });

  it("assumes the worse case when there is no code at all", async () => {
    failWith(new TypeError("fetch failed"));
    const err = await gatewayFetch("https://clixad.onrender.com/v1/wallet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayUnreachableError);
    expect((err as Error).message).not.toContain("nothing was charged");
  });

  it("finds the code inside an AggregateError, which is how a refused dual-stack connect arrives", async () => {
    failWith(networkFailure("ECONNREFUSED", true));
    const err = await gatewayFetch("http://127.0.0.1:8787/v1/models").catch((e: unknown) => e);
    expect((err as Error).message).toContain("127.0.0.1:8787 (ECONNREFUSED)");
  });

  it("leaves an abort alone, so esc still reads as stopped rather than as a network fault", async () => {
    const ctl = new AbortController();
    ctl.abort();
    failWith(Object.assign(new DOMException("aborted", "AbortError")));
    const err = await gatewayFetch("https://clixad.onrender.com/v1/models", { signal: ctl.signal }).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(GatewayUnreachableError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("passes an HTTP error through untouched, because a response is an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await gatewayFetch("https://clixad.onrender.com/v1/models");
    expect(res.status).toBe(500);
  });
});


/**
 * Most refusals are not an empty wallet: the account still holds credits, just
 * not enough for one turn on the model it picked. "Out of credits" beside a
 * balance of twenty thousand reads as a bug.
 */
describe("the first line of a refusal", () => {
  it("says 'out of credits' only when the wallet is empty", () => {
    expect(shortfallHeadline({ balance: 0, estimatedCost: 16_500 })).toBe("Out of credits (this needs about 16,500).");
  });

  it("says what the turn needs and what there is when the wallet is short", () => {
    const line = shortfallHeadline({ balance: 20_000, estimatedCost: 41_250 }, "claude-fable-5.1");
    expect(line).toBe(
      "Not enough credits for this turn on claude-fable-5.1: it needs about 41,250, and the balance is 20,000.",
    );
    expect(line).not.toContain("Out of credits");
  });
});
