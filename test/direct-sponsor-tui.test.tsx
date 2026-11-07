/**
 * Booked lines (step 2) as they reach a terminal.
 *
 * Until the first week is sold the gateway answers every ask with nothing
 * booked, so this file is the only place a booked line, a hold and their
 * reports can be seen before a customer pays for one. Each claim is asserted on
 * what ink wrote to a terminal it believed was real:
 *
 *  - the ask names only the slots that fit the terminal, and is not made with
 *    the sponsored line switched off;
 *  - a booked line replaces ADtention in its slot (ADtention is not asked
 *    there, because a serve is billed), marked as an advertisement;
 *  - a `hold` leaves the slot without a network line;
 *  - nothing booked, or an older gateway, is exactly the session before;
 *  - a booked line is reported once, after the turn, to its own route, and
 *    only if it was drawn;
 *  - a fallback line is drawn only where neither a booked line nor ADtention
 *    filled the place, marked as an advertisement, with its short address
 *    after it where everything fits, and reported to its own route.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { clearCount, fakeStdin, fakeTerminal, isFrame, plain, restoreProcessStdout, settle, type FakeTerminal } from "./helpers/terminal.tsx";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatTurn, GatewayClient, ImpressionReport, WalletInfo } from "../src/client.ts";
import type { ServedLine } from "../src/sponsor/network.ts";
import type { AdFormat, ExtraAdFormat } from "../src/sponsor/formats.ts";
import {
  parseDirectLines,
  parseFallbackLines,
  sanitizeAdText,
  shortLinkText,
  type DirectAnswer,
  type ServedDirectLine,
} from "../src/sponsor/direct.ts";
import { AD_LABEL, SIDEBAR_MIN_COLS } from "../src/sponsor/render.ts";

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

const catalog = [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }];

const NETWORK: Record<AdFormat, ServedLine> = {
  top_bar: { id: "c_top", text: "Globex: plan sprints in 5 min", impressionId: "imp_top", billable: true, fromCache: false, credit: 0.00005 },
  sidebar_card: { id: "c_side", text: "Nimbus: catch the error first", impressionId: "imp_side", billable: true, fromCache: false, credit: 0.00005 },
  status_bar: { id: "c_status", text: "Acme Deploys: ship on Friday", impressionId: "imp_status", billable: true, fromCache: false, credit: 0.00005 },
};

const BOOKED_TEXT = "Rehearsal GmbH: deploy previews in one click";
const BOTH: readonly ExtraAdFormat[] = ["sidebar_card", "status_bar"];

/**
 * A client whose turn hangs until released, recording both kinds of report.
 *
 * Released, the turn ends in an error rather than an answer. The reports go
 * out from `runTurn`'s `finally` either way, and an error leaves
 * `~/.clixad/config.json` alone: a finished turn saves the turn count, and with
 * a config no `loadConfig` handed out that save writes every field, `model`
 * included, into the one test HOME every file shares. That raced the paywall
 * test's own reading of the model it had just saved.
 */
function watchingClient() {
  const network: ImpressionReport[] = [];
  const direct: Array<Array<{ format: AdFormat; serveToken: string; visibleMs?: number; link?: string }>> = [];
  const fallback: Array<Array<{ format: AdFormat; serveToken: string }>> = [];
  const views: Array<{ measure: string; places: Array<{ format: AdFormat; visibleMs: number }> }> = [];
  let release: () => void = () => {};
  const client = {
    models: async () => catalog,
    wallet: async () => wallet,
    sponsorConfig: async () => null,
    reportImpression: async (r: ImpressionReport) => {
      network.push(r);
      return 0;
    },
    reportDirectImpressions: async (items: Array<{ format: AdFormat; serveToken: string }>) => {
      direct.push(items);
      return 0;
    },
    reportAffiliateImpressions: async (items: Array<{ format: AdFormat; serveToken: string }>) => {
      fallback.push(items);
      return items.length;
    },
    reportSponsorViews: async (measure: string, places: Array<{ format: AdFormat; visibleMs: number }>) => {
      views.push({ measure, places });
      return places.length;
    },
    chatStream: async (): Promise<ChatTurn> => {
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error("turn over");
    },
  } as unknown as GatewayClient;
  return { client, network, direct, fallback, views, release: () => release() };
}

function servingAll(asked: AdFormat[]) {
  return async (_cols: number, _signal?: AbortSignal, format: AdFormat = "top_bar") => {
    asked.push(format);
    return NETWORK[format];
  };
}

/** An asker that records what it was asked and answers `answer`. */
function asking(answer: DirectAnswer, asks: Array<{ formats: readonly AdFormat[]; cols: number }>) {
  return async (formats: readonly AdFormat[], cols: number) => {
    asks.push({ formats, cols });
    return answer;
  };
}

const booked = (format: AdFormat) => ({ format, text: BOOKED_TEXT, serveToken: `tok_${format}`, clickUrl: "https://clixad.onrender.com/r/x" });

const mounted: Array<{ unmount: () => void }> = [];

function mount(term: FakeTerminal, props: Partial<React.ComponentProps<typeof App>> = {}, stdin = fakeStdin()) {
  const app = render(<App client={watchingClient().client} config={config} wallet={wallet} {...props} />, {
    stdout: term as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounted.push(app);
  return app;
}

afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount();
  await settle(20);
  restoreProcessStdout();
  delete process.env.CLIXAD_SPONSOR;
});

const lastFrame = (term: FakeTerminal): string[] => {
  const frames = term.writes.filter(isFrame);
  return plain(frames[frames.length - 1] ?? "").split("\n");
};

describe("the ask", () => {
  it("names only the slots that fit, with the width", async () => {
    const asks: Array<{ formats: readonly AdFormat[]; cols: number }> = [];
    const term = fakeTerminal(30, SIDEBAR_MIN_COLS - 1);
    mount(term, { initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [] }, asks) });
    await settle(250);
    expect(asks).toEqual([{ formats: ["top_bar", "status_bar"], cols: SIDEBAR_MIN_COLS - 1 }]);
  });

  it("is not made with the sponsored line switched off", async () => {
    process.env.CLIXAD_SPONSOR = "0";
    const asks: Array<{ formats: readonly AdFormat[]; cols: number }> = [];
    mount(fakeTerminal(30, 120), { initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [] }, asks) });
    await settle(250);
    expect(asks).toEqual([]);
  });
});

describe("a booked line", () => {
  it("takes the slot, marked as an advertisement, and ADtention is not asked for it", async () => {
    const term = fakeTerminal(30, 120);
    const { client, network, direct, release } = watchingClient();
    const served: AdFormat[] = [];
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingAll(served),
      sponsorFormats: BOTH,
      sponsorDirect: asking({ supported: true, lines: [booked("top_bar")] }, []),
    });
    await settle(300);

    const rows = lastFrame(term);
    const top = rows.findIndex((r) => r.includes(BOOKED_TEXT));
    expect(top).toBeGreaterThan(-1);
    expect(rows[top]).toContain(`${AD_LABEL} ·`);
    expect(served.sort()).toEqual(["sidebar_card", "status_bar"]);
    expect(clearCount(term)).toBe(0);

    release();
    await settle(150);
    // Its own route, once, with its token; never as an ADtention impression.
    // With how long it stayed on screen in one stretch, and how it could be
    // opened: here neither, a test terminal understands no links and the line
    // carries no short address.
    expect(direct).toEqual([[{ format: "top_bar", serveToken: "tok_top_bar", visibleMs: expect.any(Number), link: "none" }]]);
    expect(direct[0]![0]!.visibleMs).toBeGreaterThan(200);
    expect(network.map((r) => r.impressionId).sort()).toEqual(["imp_side", "imp_status"]);
  });

  it("fills the card and the status bar too, without the gateway handing out ADtention there", async () => {
    const term = fakeTerminal(30, 120);
    const { client, direct, release } = watchingClient();
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingAll([]),
      sponsorDirect: asking({ supported: true, lines: [booked("sidebar_card"), booked("status_bar")] }, []),
    });
    await settle(300);
    const out = plain(term.output());
    expect(out.split(BOOKED_TEXT.slice(0, 20)).length - 1).toBeGreaterThanOrEqual(2);
    release();
    await settle(150);
    expect(direct).toHaveLength(1);
    expect(direct[0]!.map((d) => d.format).sort()).toEqual(["sidebar_card", "status_bar"]);
  });

  it("is not reported when the turn ends before it was drawn", async () => {
    const term = fakeTerminal(30, 120);
    const { client, direct } = watchingClient();
    let answer: (a: DirectAnswer) => void = () => {};
    const slow = () => new Promise<DirectAnswer>((r) => (answer = r));
    const app = mount(term, { client, initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: slow });
    await settle(100);
    app.unmount();
    answer({ supported: true, lines: [booked("top_bar")] });
    await settle(100);
    expect(direct).toEqual([]);
  });
});

describe("hold, nothing booked, and an older gateway", () => {
  it("a hold leaves the slot without a network line", async () => {
    const term = fakeTerminal(30, 120);
    const served: AdFormat[] = [];
    mount(term, {
      initialTask: "go",
      sponsorServe: servingAll(served),
      sponsorFormats: BOTH,
      sponsorDirect: asking({ supported: true, lines: [{ format: "top_bar", hold: true }] }, []),
    });
    await settle(300);
    expect(served.sort()).toEqual(["sidebar_card", "status_bar"]);
    expect(plain(term.output())).not.toContain(NETWORK.top_bar.text);
  });

  it("nothing booked is the session it always was", async () => {
    const term = fakeTerminal(30, 120);
    const served: AdFormat[] = [];
    mount(term, { initialTask: "go", sponsorServe: servingAll(served), sponsorDirect: asking({ supported: true, lines: [] }, []) });
    await settle(300);
    expect(served).toEqual(["top_bar"]);
    expect(plain(term.output())).toContain(NETWORK.top_bar.text);
  });

  it("an asker that throws is nothing booked, not a crash", async () => {
    const term = fakeTerminal(30, 120);
    const served: AdFormat[] = [];
    const throwing = () => {
      throw new Error("boom");
    };
    mount(term, { initialTask: "go", sponsorServe: servingAll(served), sponsorDirect: throwing as never });
    await settle(300);
    expect(served).toEqual(["top_bar"]);
  });
});

describe("a booked line's link", () => {
  afterEach(() => {
    delete process.env.FORCE_HYPERLINK;
  });

  it("is a link to the gateway's click address where the terminal understands one, and still one row", async () => {
    process.env.FORCE_HYPERLINK = "1";
    const term = fakeTerminal(30, 120);
    mount(term, {
      initialTask: "go",
      sponsorServe: servingAll([]),
      sponsorDirect: asking({ supported: true, lines: [booked("top_bar"), booked("status_bar")] }, []),
    });
    await settle(300);
    const raw = term.output();
    expect(raw).toContain(`\u001b]8;;https://clixad.onrender.com/r/x\u0007`);
    expect(clearCount(term)).toBe(0);
    const rows = lastFrame(term).filter((r) => r.includes(BOOKED_TEXT));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("is plain text everywhere else", async () => {
    process.env.FORCE_HYPERLINK = "0";
    const term = fakeTerminal(30, 120);
    mount(term, { initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [booked("top_bar")] }, []) });
    await settle(300);
    expect(term.output()).not.toContain("\u001b]8;;");
    expect(lastFrame(term).some((r) => r.includes(BOOKED_TEXT))).toBe(true);
  });
});

describe("measured the way the market measures it (2026-11-07)", () => {
  afterEach(() => {
    delete process.env.FORCE_HYPERLINK;
  });
  const SHORT = "https://app.clixad.io/a/k3p9xq";
  const withShort = (format: AdFormat) => ({ ...booked(format), shortUrl: SHORT });

  it("prints the short address where the terminal cannot make the line a link, and reports it as one to open", async () => {
    process.env.FORCE_HYPERLINK = "0";
    const term = fakeTerminal(30, 120);
    const { client, direct, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [withShort("top_bar")] }, []) });
    await settle(300);
    const row = lastFrame(term).find((r) => r.includes("Rehearsal GmbH"))!;
    expect(row).toContain("app.clixad.io/a/k3p9xq");
    expect(term.output()).not.toContain("\u001b]8;;");
    expect(clearCount(term)).toBe(0);
    release();
    await settle(150);
    expect(direct[0]![0]).toMatchObject({ format: "top_bar", link: "address" });
  });

  it("keeps the address at 80 columns, cutting the copy to make room for it", async () => {
    process.env.FORCE_HYPERLINK = "0";
    const term = fakeTerminal(30, 80);
    mount(term, { initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [withShort("top_bar")] }, []) });
    await settle(300);
    const row = lastFrame(term).find((r) => r.includes("Rehearsal"))!;
    expect(row).toContain("app.clixad.io/a/k3p9xq");
    expect(row).toContain("…");
    expect(clearCount(term)).toBe(0);
  });

  it("reports a line drawn as a link as one to open, and prints no address beside it", async () => {
    process.env.FORCE_HYPERLINK = "1";
    const term = fakeTerminal(30, 120);
    const { client, direct, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [withShort("top_bar")] }, []) });
    await settle(300);
    expect(plain(term.output())).not.toContain("app.clixad.io/a/k3p9xq");
    release();
    await settle(150);
    expect(direct[0]![0]).toMatchObject({ format: "top_bar", link: "link" });
  });

  it("reports how long each place it asked about stayed on screen, with the turn's measure", async () => {
    const term = fakeTerminal(30, 120);
    const { client, views, release } = watchingClient();
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingAll([]),
      sponsorDirect: asking({ supported: true, lines: [booked("top_bar")], measure: "measure_1" }, []),
    });
    await settle(300);
    release();
    await settle(150);
    expect(views).toHaveLength(1);
    expect(views[0]!.measure).toBe("measure_1");
    expect(views[0]!.places.map((p) => p.format).sort()).toEqual(["sidebar_card", "status_bar", "top_bar"]);
    // The top bar held a line from the answer on; the two others were never drawn here.
    expect(views[0]!.places.find((p) => p.format === "top_bar")!.visibleMs).toBeGreaterThan(200);
    expect(views[0]!.places.find((p) => p.format === "status_bar")!.visibleMs).toBe(0);
  });

  it("reports no measure to a gateway that sent none", async () => {
    const term = fakeTerminal(30, 120);
    const { client, views, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorServe: servingAll([]), sponsorDirect: asking({ supported: true, lines: [booked("top_bar")] }, []) });
    await settle(300);
    release();
    await settle(150);
    expect(views).toEqual([]);
  });
});

describe("an ask that fails", () => {
  it("keeps ADtention out of a slot the last answer said was booked, and asks it everywhere else", async () => {
    const term = fakeTerminal(30, 120);
    const { client, release } = watchingClient();
    const served: AdFormat[] = [];
    let n = 0;
    const flaky = async (): Promise<DirectAnswer> => {
      n += 1;
      if (n === 1) return { supported: true, lines: [{ format: "top_bar", hold: true }] };
      return { supported: true, lines: [], failed: true };
    };
    const stdin = fakeStdin();
    mount(term, { client, initialTask: "go", sponsorServe: servingAll(served), sponsorFormats: BOTH, sponsorDirect: flaky }, stdin);
    await settle(250);
    expect(served.sort()).toEqual(["sidebar_card", "status_bar"]);
    release();
    await settle(150);
    // A second turn, whose ask fails: the top bar stays without a network line.
    served.length = 0;
    stdin.send("again");
    await settle(40);
    stdin.send("\r");
    await settle(300);
    expect(n).toBe(2);
    expect(served.sort()).toEqual(["sidebar_card", "status_bar"]);
    release();
    await settle(100);
  });

  it("is nothing booked when no answer ever said otherwise", async () => {
    const term = fakeTerminal(30, 120);
    const served: AdFormat[] = [];
    mount(term, { initialTask: "go", sponsorServe: servingAll(served), sponsorDirect: asking({ supported: true, lines: [], failed: true }, []) });
    await settle(300);
    expect(served).toEqual(["top_bar"]);
  });
});

describe("reading the answer", () => {
  it("drops every entry that is not exactly one of the two shapes", () => {
    const lines = parseDirectLines({
      lines: [
        { format: "top_bar", text: "ok", serve_token: "t", click_url: "https://x.test/r" },
        { format: "top_bar", hold: true }, // a second entry for one slot
        { format: "banner", hold: true },
        { format: "status_bar", text: "", serve_token: "t", click_url: "https://x.test" },
        { format: "status_bar", text: "x", serve_token: "t", click_url: "javascript:alert(1)" },
        { format: "sidebar_card", hold: "yes" },
        "nonsense",
      ],
    });
    expect(lines).toEqual([{ format: "top_bar", text: "ok", serveToken: "t", clickUrl: "https://x.test/r" }]);
    expect(parseDirectLines({ lines: "x" })).toEqual([]);
    expect(parseDirectLines(null)).toEqual([]);
  });

  it("takes every escape, control and invisible character out of the copy", () => {
    expect(sanitizeAdText("\u001b[31mRed\u001b[0m text")).toBe("Red text");
    expect(sanitizeAdText("Link \u001b]8;;https://evil.test\u0007here\u001b]8;;\u0007")).toBe("Link here");
    expect(sanitizeAdText("abc‮dcba")).toBe("abcdcba");
    expect(sanitizeAdText("zero​width⁠join")).toBe("zerowidthjoin");
    expect(sanitizeAdText("two\nlines\r\there")).toBe("two lines here");
    expect(sanitizeAdText("\u0007bell\u009bcsi")).toBe("bell csi");
  });
});

// ---- fallback lines ------------------------------------------------------------

const FALLBACK: Record<AdFormat, string> = {
  top_bar: "Railway: $20 in credits at signup",
  sidebar_card: "Railway: $20 credits when you sign up",
  status_bar: "$300 Vultr credit to test, 30 days",
};
const SLOT_CODE: Record<AdFormat, string> = { top_bar: "t", sidebar_card: "c", status_bar: "s" };
const fallbackFor = (format: AdFormat): ServedDirectLine => ({
  format,
  text: FALLBACK[format],
  serveToken: `aff_${format}`,
  clickUrl: `https://app.clixad.io/r/${format === "status_bar" ? "vultr" : "railway"}/${SLOT_CODE[format]}`,
});
const ALL_FALLBACKS = (["top_bar", "sidebar_card", "status_bar"] as const).map(fallbackFor);

/** ADtention with nothing to serve in any place. */
function servingNone(asked: AdFormat[]) {
  return async (_cols: number, _signal?: AbortSignal, format: AdFormat = "top_bar") => {
    asked.push(format);
    return null;
  };
}

describe("a fallback line", () => {
  afterEach(() => {
    delete process.env.FORCE_HYPERLINK;
  });

  it("fills every place ADtention leaves empty, marked as an advertisement, with its short address after it", async () => {
    const term = fakeTerminal(30, 120);
    const { client, network, direct, fallback, release } = watchingClient();
    const asked: AdFormat[] = [];
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingNone(asked),
      sponsorFormats: BOTH,
      sponsorDirect: asking({ supported: true, lines: [], fallbacks: ALL_FALLBACKS }, []),
    });
    await settle(300);

    // ADtention was asked first, everywhere.
    expect(asked.sort()).toEqual(["sidebar_card", "status_bar", "top_bar"]);
    const rows = lastFrame(term);
    const top = rows.find((r) => r.includes(FALLBACK.top_bar));
    expect(top).toContain(`${AD_LABEL} · ${FALLBACK.top_bar} · app.clixad.io/r/railway/t`);
    expect(rows.some((r) => r.includes(`${FALLBACK.status_bar} · app.clixad.io/r/vultr/s`))).toBe(true);
    // The card: the address on the label's row, the copy whole on its own.
    expect(rows.some((r) => r.includes(`✦ ${AD_LABEL} · app.clixad.io/r/railway/c`))).toBe(true);
    expect(rows.some((r) => r.includes(FALLBACK.sidebar_card))).toBe(true);
    expect(clearCount(term)).toBe(0);

    release();
    await settle(150);
    // Reported to its own route, once, and never as a booked or an ADtention line.
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.map((f) => f.serveToken).sort()).toEqual(["aff_sidebar_card", "aff_status_bar", "aff_top_bar"]);
    expect(direct).toEqual([]);
    expect(network).toEqual([]);
  });

  it("is not drawn where ADtention has a line, and not reported", async () => {
    const term = fakeTerminal(30, 120);
    const { client, network, fallback, release } = watchingClient();
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingAll([]),
      sponsorFormats: BOTH,
      sponsorDirect: asking({ supported: true, lines: [], fallbacks: ALL_FALLBACKS }, []),
    });
    await settle(300);
    const out = plain(term.output());
    for (const text of Object.values(FALLBACK)) expect(out).not.toContain(text);
    release();
    await settle(150);
    expect(fallback).toEqual([]);
    expect(network.map((r) => r.impressionId).sort()).toEqual(["imp_side", "imp_status", "imp_top"]);
  });

  it("never takes a booked or held place, even if one arrives for it", async () => {
    const term = fakeTerminal(30, 120);
    const { client, fallback, release } = watchingClient();
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: servingNone([]),
      sponsorFormats: BOTH,
      sponsorDirect: asking(
        {
          supported: true,
          lines: [booked("top_bar"), { format: "status_bar", hold: true }],
          fallbacks: ALL_FALLBACKS,
        },
        [],
      ),
    });
    await settle(300);
    const out = plain(term.output());
    expect(out).toContain(BOOKED_TEXT);
    expect(out).not.toContain(FALLBACK.top_bar);
    expect(out).not.toContain(FALLBACK.status_bar);
    release();
    await settle(150);
    expect(fallback.flat().map((f) => f.format)).toEqual(["sidebar_card"]);
  });

  it("replaces our own tip in the top bar, and the tip stays when there is no fallback", async () => {
    const withTerm = fakeTerminal(30, 120);
    mount(withTerm, {
      initialTask: "go",
      sponsorServe: servingNone([]),
      sponsorDirect: asking({ supported: true, lines: [], fallbacks: [fallbackFor("top_bar")] }, []),
    });
    await settle(300);
    const withRow = lastFrame(withTerm).find((r) => r.includes("✦"));
    expect(withRow).toContain(FALLBACK.top_bar);

    for (const app of mounted.splice(0)) app.unmount();
    const without = fakeTerminal(30, 120);
    mount(without, { initialTask: "go", sponsorServe: servingNone([]), sponsorDirect: asking({ supported: true, lines: [] }, []) });
    await settle(300);
    const row = lastFrame(without).find((r) => r.includes("✦"));
    expect(row).toContain("✦ clixad ·");
    expect(row).not.toContain(`${AD_LABEL} ·`);
  });

  it("drops the address, never the offer, when the terminal is too narrow for both", async () => {
    const term = fakeTerminal(30, 60);
    mount(term, {
      initialTask: "go",
      sponsorServe: servingNone([]),
      sponsorDirect: asking({ supported: true, lines: [], fallbacks: [fallbackFor("top_bar")] }, []),
    });
    await settle(300);
    const row = lastFrame(term).find((r) => r.includes(FALLBACK.top_bar));
    expect(row).toBeTruthy();
    expect(row).not.toContain("app.clixad.io");
    expect(clearCount(term)).toBe(0);
  });

  it("is a link to the short address where the terminal understands one, and still one row", async () => {
    process.env.FORCE_HYPERLINK = "1";
    const term = fakeTerminal(30, 120);
    mount(term, {
      initialTask: "go",
      sponsorServe: servingNone([]),
      sponsorDirect: asking({ supported: true, lines: [], fallbacks: [fallbackFor("top_bar")] }, []),
    });
    await settle(300);
    expect(term.output()).toContain("\u001b]8;;https://app.clixad.io/r/railway/t\u0007");
    expect(clearCount(term)).toBe(0);
    expect(lastFrame(term).filter((r) => r.includes(FALLBACK.top_bar))).toHaveLength(1);
  });
});

describe("reading the fallbacks", () => {
  it("reads them by the line rules, one per place, and never a hold", () => {
    const lines = parseFallbackLines({
      fallbacks: [
        { format: "top_bar", text: "ok", serve_token: "t", click_url: "https://app.clixad.io/r/a/t" },
        { format: "top_bar", text: "second", serve_token: "t", click_url: "https://app.clixad.io/r/b/t" },
        { format: "status_bar", hold: true },
        { format: "sidebar_card", text: "x", serve_token: "t", click_url: "ftp://x.test" },
      ],
    });
    expect(lines).toEqual([{ format: "top_bar", text: "ok", serveToken: "t", clickUrl: "https://app.clixad.io/r/a/t" }]);
    expect(parseFallbackLines({ lines: [] })).toEqual([]);
    expect(parseFallbackLines(null)).toEqual([]);
  });

  it("prints an address only when it is exactly where a click goes, and short", () => {
    expect(shortLinkText("https://app.clixad.io/r/railway/t")).toBe("app.clixad.io/r/railway/t");
    // A signed click address is long and carries a query: never printed.
    expect(shortLinkText("https://app.clixad.io/go?c=abc.def")).toBeUndefined();
    expect(shortLinkText("http://app.clixad.io/r/railway/t")).toBeUndefined();
    expect(shortLinkText(`https://app.clixad.io/r/${"x".repeat(40)}/t`)).toBeUndefined();
    expect(shortLinkText("not a url")).toBeUndefined();
  });
});
