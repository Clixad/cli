/**
 * The sponsored line as it actually reaches a screen.
 *
 * `sponsor.test.ts` proves the pure parts — the gate, the truncation, the
 * rotation. This file proves the wiring, which is where the two claims that
 * matter most are either true or not: that the line appears **only while a model
 * call is running**, and that a non-interactive stdout gets nothing at all. Both
 * are properties of the composition, not of any function, so only a rendered
 * frame can settle them.
 *
 * It also pins the thing that has no other alarm: the line is drawn in the
 * bottom re-rendered region and never in `<Static>`, so it can never appear in
 * committed output. If someone moves it into an `Entry`, "shows during a call"
 * would still pass while the line silently became permanent scrollback.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import { AD_LABEL, SPONSOR_MARKER } from "../src/sponsor/render.ts";
import type { CliConfig } from "../src/config.ts";
import type { ServedLine } from "../src/sponsor/network.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};

const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 2,
  earned_usd_today: 0.04,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * A client whose every turn hangs until `release()` is called, so a frame can be
 * read while a call is genuinely in flight.
 *
 * Each turn gets its own gate rather than sharing one: a second turn against an
 * already-released gate would return instantly, and a test that reads the frame
 * afterwards would be asserting about an idle screen while looking like it was
 * asserting about a busy one.
 */
function hangingClient() {
  const gates: Array<() => void> = [];
  const client = {
    models: async () => [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }],
    wallet: async () => wallet,
    // A gateway with no ad network configured, which is what every deployment
    // without a publisher id answers — and what these tests are
    // about, since the house rotation is only observable when nothing replaces
    // it. It is also what makes them offline: with no publisher there is no
    // serve, so nothing here reaches ADtention. The remote path has its own
    // coverage in `sponsor.test.ts` and "reports an impression only for a line
    // it painted" below.
    sponsorConfig: async () => null,
    reportImpression: async () => 0,
    async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      opts.onDelta?.("thinking");
      await new Promise<void>((r) => gates.push(r));
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 7,
        balance: 4981,
      } as ChatTurn;
    },
  } as unknown as GatewayClient;
  return { client, release: () => gates.shift()?.() };
}

/**
 * The same client, with an ad network configured and a serve we control.
 *
 * The SDK is never constructed here — `createSponsorSlot` would talk to a real
 * network — so what is injected is one level up: a `sponsorConfig` that answers
 * with a publisher, and the report call recorded. What is under test is the rule
 * that only a *painted* line is reported, which is a property of `nextSponsor`'s
 * call-counter branch and of nothing else.
 */
function reportingClient(publisher = true) {
  const reported: string[] = [];
  const gates: Array<() => void> = [];
  const client = {
    models: async () => [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }],
    wallet: async () => wallet,
    sponsorConfig: async () =>
      publisher ? { publisherId: "pub_1", category: "devops", subject: "s", dwellMs: 15_000 } : null,
    reportImpression: async (r: { impressionId: string }) => {
      reported.push(r.impressionId);
      return 0;
    },
    async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      opts.onDelta?.("thinking");
      await new Promise<void>((r) => gates.push(r));
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 7,
        balance: 4981,
      } as ChatTurn;
    },
  } as unknown as GatewayClient;
  return { client, reported, release: () => gates.shift()?.() };
}

/** One line as ADtention's SDK hands it over, for the `sponsorServe` seam. */
const served: ServedLine = {
  id: "c_acme",
  text: "Acme Deploys — ship on Friday",
  impressionId: "imp_0001",
  billable: true,
  fromCache: false,
  credit: 0.00005,
};

/**
 * `render`, with the terminal-ness the App actually asks about.
 *
 * The gate reads `isTTY` off **ink's** stdout — the stream the row is drawn on
 * — and `ink-testing-library`'s stdout has no `isTTY` at all, so without this
 * every test here would be asserting on a slot that is switched off. Mirroring
 * `process.stdout` keeps the existing tests saying what they were written to
 * say: they pin the process, and the App sees the same answer.
 */
const renderTui = (tree: React.ReactElement) => {
  const result = render(tree);
  Object.defineProperty(result.stdout, "isTTY", {
    value: process.stdout.isTTY,
    configurable: true,
  });
  return result;
};

/** The sponsored row as the user would read it, or undefined if none is up. */
const sponsorLineOf = (frame: string | undefined) =>
  strip(frame ?? "")
    .split("\n")
    .find((l) => l.includes(SPONSOR_MARKER));

const savedTTY = process.stdout.isTTY;
const savedEnv = { ...process.env };

beforeEach(() => {
  // ink-testing-library writes to a fake stream, so the real stdout's TTY-ness is
  // whatever vitest's happens to be. Pin it, since it is exactly what is under test.
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env.NO_COLOR;
  delete process.env.CI;
  delete process.env.CLIXAD_SPONSOR;
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: savedTTY, configurable: true });
  process.env = { ...savedEnv };
});

describe("the sponsored line in the TUI", () => {
  it("appears while a model call runs and goes when the call goes", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);

    // Nothing before a call: this is chrome for a call in flight, not a banner.
    expect(strip(lastFrame() ?? "")).not.toContain(SPONSOR_MARKER);

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    const during = strip(lastFrame() ?? "");
    expect(during).toContain(SPONSOR_MARKER);
    expect(during).toContain("working…"); // the spinner is untouched, and still says esc
    expect(during).toContain("esc to stop");

    release();
    await tick(80);
    expect(strip(lastFrame() ?? "")).not.toContain(SPONSOR_MARKER);
  });

  it("renders nothing at all when stdout is not a TTY", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    const during = strip(lastFrame() ?? "");
    expect(during).toContain("working…"); // the turn really is running
    expect(during).not.toContain(SPONSOR_MARKER);
    expect(during).not.toContain("clixad ·");
    release();
    await tick(40);
  });

  it("honours the config off switch", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(
      <App client={client} config={{ ...config, sponsor: false }} wallet={wallet} />,
    );

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    const during = strip(lastFrame() ?? "");
    expect(during).toContain("working…");
    expect(during).not.toContain(SPONSOR_MARKER);
    release();
    await tick(40);
  });

  it("honours CLIXAD_SPONSOR=0", async () => {
    process.env.CLIXAD_SPONSOR = "0";
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(strip(lastFrame() ?? "")).not.toContain(SPONSOR_MARKER);
    release();
    await tick(40);
  });

  it("never leaves the line in committed scrollback", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(strip(lastFrame() ?? "")).toContain(SPONSOR_MARKER);

    release();
    await tick(80);
    // Between turns there is none at all — the first was not committed anywhere.
    expect(strip(lastFrame() ?? "")).not.toContain(SPONSOR_MARKER);

    // A second turn, genuinely in flight. If the first line had been pushed into
    // <Static> it would still be sitting in the scrollback above this one, and
    // the frame would now hold two.
    stdin.write("again");
    await tick();
    stdin.write("\r");
    await tick(80);
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("working…");
    expect(frame.split(SPONSOR_MARKER).length - 1).toBe(1);

    release();
    await tick(40);
  });

  it("rotates: the second call does not repeat the first call's line", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);

    const lineOf = (frame: string) =>
      frame.split("\n").find((l) => l.includes(SPONSOR_MARKER))?.trim();

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    const first = lineOf(strip(lastFrame() ?? ""));
    expect(first).toBeTruthy();

    release();
    await tick(80);
    stdin.write("again");
    await tick();
    stdin.write("\r");
    await tick(80);
    const second = lineOf(strip(lastFrame() ?? ""));

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    release();
    await tick(40);
  });
});

describe("reporting an impression", () => {
  it("reports nothing when the gateway has no ad network", async () => {
    // No publisher means no serve, so there is no impression to report and no
    // request to ADtention at all. The house line still renders — that is what
    // "unconfigured is a supported state" looks like from the screen.
    const { client, reported, release } = reportingClient(false);
    const { stdin, lastFrame } = renderTui(<App client={client} config={config} wallet={wallet} />);
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain(SPONSOR_MARKER);
    expect(reported).toEqual([]);
    release();
    await tick(40);
  });

  it("reports nothing when the line is switched off, so the network is never asked", async () => {
    // The stronger claim since the serve moved into the CLI: off means no
    // request to the ad network, from a machine that then never contacts them.
    // The gate is checked before the fetch is started, not after it returns.
    //
    // Asserted on the **serve** and not only on the report, because those are
    // different claims: a serve that happened and answered nothing also reports
    // nothing. The privacy policy says the switch stops the request being made,
    // so the request is what has to be counted.
    process.env.CLIXAD_SPONSOR = "0";
    const { client, reported, release } = reportingClient();
    let serves = 0;
    const { stdin } = renderTui(
      <App
        client={client}
        config={config}
        wallet={wallet}
        sponsorServe={async () => {
          serves++;
          return null;
        }}
      />,
    );
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(serves).toBe(0);
    expect(reported).toEqual([]);
    release();
    await tick(40);
  });
});

describe("when the impression is reported", () => {
  // The bug this block exists for reached production and looked healthy the
  // whole way: config fetched, a real `imp_…` served, the report accepted, and
  // then nothing credited, on every turn, forever. The report was sent from the
  // branch that paints the line, and the gateway credits an impression only
  // once the model call it rode on has been settled, at the *end* of that call.
  // Nothing on either side was wrong except the moment.

  it("waits for the turn to finish, because the gateway has not settled the call yet", async () => {
    const { client, reported, release } = reportingClient();
    const { stdin, lastFrame } = renderTui(
      <App client={client} config={config} wallet={wallet} sponsorServe={async () => served} />,
    );

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(120);

    // The line is on screen and the turn is genuinely still running...
    const during = strip(lastFrame() ?? "");
    expect(during).toContain(served.text);
    expect(during).toContain("working…");
    // ...and nothing has been reported. This is the assertion the production bug
    // would have failed: the model call has not settled, so a report now can
    // never credit.
    expect(reported).toEqual([]);

    release();
    await tick(120);
    expect(reported).toEqual(["imp_0001"]);
  });

  it("reports a line once, not once per turn it stayed up for", async () => {
    const { client, reported, release } = reportingClient();
    const { stdin } = renderTui(
      <App client={client} config={config} wallet={wallet} sponsorServe={async () => served} />,
    );

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(120);
    release();
    await tick(120);

    stdin.write("again");
    await tick();
    stdin.write("\r");
    await tick(120);
    release();
    await tick(120);

    // Two turns, two serves, and the SDK's dwell means the second is the same
    // impression from its cache. The gateway counts an impression id once, but
    // the count is what says the pending slot was cleared as it fired.
    expect(reported.length).toBe(2);
    expect(new Set(reported)).toEqual(new Set(["imp_0001"]));
  });

  it("reports nothing for a line the network never filled", async () => {
    // House line only. No impression exists, so there is nothing to report — and
    // no house line is ever reported, because "sponsored" describes the slot,
    // not a transaction.
    const { client, reported, release } = reportingClient();
    const { stdin, lastFrame } = renderTui(
      <App client={client} config={config} wallet={wallet} sponsorServe={async () => null} />,
    );

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain(SPONSOR_MARKER);
    release();
    await tick(120);
    expect(reported).toEqual([]);
  });

  it("reports nothing when the fill lands after the turn it was asked for", async () => {
    // The counter has moved on, so the line was dropped rather than painted.
    // Reporting it would bill an advertiser for a line nobody saw.
    let resolveServe: (v: ServedLine | null) => void = () => {};
    const late = new Promise<ServedLine | null>((r) => {
      resolveServe = r;
    });
    const { client, reported, release } = reportingClient();
    const { stdin } = renderTui(
      <App client={client} config={config} wallet={wallet} sponsorServe={() => late} />,
    );

    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(80);
    // The turn ends while the serve is still in flight.
    release();
    await tick(120);
    resolveServe(served);
    await tick(120);

    expect(reported).toEqual([]);
  });
});

/**
 * The disclosure, on the screen rather than in the helper that builds it.
 *
 * The unit tests in `sponsor.test.ts` prove the row is *built* with a mark.
 * These prove it survives the trip: that a served line reaches the frame
 * labelled, that our own content in the same slot on the same turn does not,
 * and that both are still one row of chrome.
 */
describe("the ad mark on screen", () => {
  it("labels a served line and leaves our own line unlabelled", async () => {
    // The serve is held open on purpose: the house line is painted
    // synchronously and the network line replaces it when the fetch lands, so
    // both states are readable off the same slot on the same turn only if the
    // network is slower than the paint — which is also what it is in life.
    let land: (v: ServedLine) => void = () => {};
    const fetched = new Promise<ServedLine>((r) => {
      land = r;
    });
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = renderTui(
      <App client={client} config={config} wallet={wallet} sponsorServe={() => fetched} />,
    );
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(60);

    const MARKED = `${SPONSOR_MARKER} ${AD_LABEL} · `;
    const house = sponsorLineOf(lastFrame());
    expect(house, "a house line should be up first").toBeTruthy();
    expect(house).not.toContain(MARKED);

    land(served);
    await tick(120);
    const ad = sponsorLineOf(lastFrame());
    expect(ad).toContain(served.text);
    expect(ad).toContain(MARKED);
    // Ahead of the copy, not after it.
    expect(ad!.indexOf(AD_LABEL)).toBeLessThan(ad!.indexOf(served.text));

    release();
    await tick(60);
  });

  it("stays one row of chrome, marked or not", async () => {
    for (const serve of [async () => served, async () => null]) {
      const { client, release } = hangingClient();
      const { stdin, lastFrame } = renderTui(
        <App client={client} config={config} wallet={wallet} sponsorServe={serve} />,
      );
      stdin.write("hello");
      await tick();
      stdin.write("\r");
      await tick(140);

      const frame = strip(lastFrame() ?? "");
      const rows = frame.split("\n").filter((l) => l.includes(SPONSOR_MARKER));
      expect(rows).toHaveLength(1);
      release();
      await tick(60);
    }
  });
});
