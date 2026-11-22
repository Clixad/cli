/**
 * Every request to the gateway names this program and its release, so the
 * gateway can tell the agent's calls from any other client's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_HEADER, gatewayFetch } from "../src/client.ts";
import { VERSION } from "../src/version.ts";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const seen: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }),
  );
  return seen;
}

describe("the client header", () => {
  it("rides on a request with plain headers, beside the ones it had", async () => {
    const seen = capture();
    await gatewayFetch("http://127.0.0.1:8787/v1/wallet", { headers: { Authorization: "Bearer t" } });
    expect(seen[0]!.headers).toEqual({ [CLIENT_HEADER]: `cli/${VERSION}`, Authorization: "Bearer t" });
  });

  it("rides on a request with none, and on a Headers object", async () => {
    const seen = capture();
    await gatewayFetch("http://127.0.0.1:8787/healthz");
    await gatewayFetch("http://127.0.0.1:8787/healthz", { headers: new Headers({ Accept: "application/json" }) });
    expect((seen[0]!.headers as Record<string, string>)[CLIENT_HEADER]).toBe(`cli/${VERSION}`);
    expect((seen[1]!.headers as Headers).get(CLIENT_HEADER)).toBe(`cli/${VERSION}`);
  });
});
