/**
 * The way out of the paywall, driven through the real key handling.
 *
 * The 402 is the one moment this product stops somebody in the middle of their
 * own work, and it used to have exactly one exit: open a browser, find an offer,
 * finish it, come back. That is the right exit when it is the only one — it is
 * how the product is paid for — but on most days the account has a free
 * allowance sitting unspent on a cheaper model that would answer the same
 * request immediately, and sending somebody past it cost them a five-minute
 * detour to buy something they already had.
 *
 * Four properties, and the second is the one the whole change is for:
 *
 *  1. With nothing free left, **not one keystroke has moved** — enter opens the
 *     wall, exactly as it always did.
 *  2. With something free left, enter offers the switch, and taking it re-runs
 *     the interrupted request **without it being typed again**. A "switch model
 *     and retype your prompt" would be a worse version of the thing it replaces.
 *  3. The wall stays on the chooser as a row. The free tier is bounded and the
 *     wall is not, so a person who wants credits rather than a cheaper model must
 *     never have to find another way to say so.
 *  4. Esc changes nothing and loses nothing: the request stays queued and enter
 *     opens the chooser again, which is what the notice promised.
 *
 * Every figure on screen came off the wire. The CLI cannot import the pricing
 * engine, so the turn counts are the gateway's — `modelHint`'s rule
 * and `grantLabel`'s.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

// The wall opens a browser; a test must not spawn one.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { PaywallError } from "../src/client.ts";
import { loadConfig, type CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const PAID = "claude-opus-5.5";
const FREE = "gpt-5-nano";
const TASK = "rename the upload handler";

const config = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: PAID,
});

const wallet: WalletInfo = {
  balance: 12,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 51_000,
  ledger: [],
};

/** What the gateway sends with a 402 when the day still has free turns in it. */
const FREE_MODELS = [
  { id: FREE, turnsLeft: 31 },
  { id: "kimi-k2.5", turnsLeft: 3 },
];

interface Script {
  /** Models still free, as the refusal reports them. Empty is a spent day. */
  free?: { id: string; turnsLeft: number }[];
  /** The cheapest pack the refusal names, or null where the gateway sells none. */
  pack?: number | null;
  /** Every call the TUI made: the model it used and the prompt it sent. */
  calls: { model: string; prompt: string }[];
  /** One of our own surveys open to the account, as the refusal reports it. */
  own?: { credits: number; leftToday: number } | null;
}

/**
 * A gateway that refuses the paid model and answers on anything else.
 *
 * Which is the whole shape of the feature: the request that was refused is the
 * request that succeeds a keystroke later, on a different model, with nothing
 * retyped in between.
 */
function stubClient(script: Script): GatewayClient {
  return {
    models: async () => [
      { id: PAID, tier: "premium", est_ads_per_task: 18, free: false },
      { id: FREE, tier: "cheap", est_ads_per_task: 0.04, free: true },
    ],
    wallet: async () => wallet,
    claimStreak: async () => null,
    handoffCode: async () => "hoff_1",
    async chatStream(messages: ChatMessage[], model: string, opts: ChatOptions): Promise<ChatTurn> {
      const last = messages[messages.length - 1];
      const prompt = typeof last?.content === "string" ? last.content : "";
      script.calls.push({ model, prompt });
      if (model === PAID) {
        throw new PaywallError(12, 1190, 51_000, script.free ?? [], script.pack ?? null, script.own ?? null);
      }
      opts.onDelta?.("done");
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 0,
        balance: 12,
      };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";
const ARROW_DOWN = "\x1b[B";

/** Type the task and run it, which the stub refuses. */
async function runIntoThePaywall(script: Script) {
  const view = render(<App client={stubClient(script)} config={config()} wallet={wallet} />);
  view.stdin.write(TASK);
  await tick();
  view.stdin.write("\r");
  await tick(150);
  return view;
}

describe("the paywall offers a free model", () => {
  it("names one in the notice, with the gateway's own turn count", async () => {
    const script: Script = { free: FREE_MODELS, calls: [] };
    const { lastFrame } = await runIntoThePaywall(script);
    const out = strip(lastFrame() ?? "");

    // The stub refuses with 12 credits left: short, not empty, and said so.
    expect(out).toContain("Not enough credits for this turn");
    expect(out).toContain(FREE);
    expect(out).toContain("~31 turns left");
    // And it promises the thing the next keystroke has to deliver.
    expect(out).toContain("you will not have to type it again");
  });

  it("switches model and re-runs the request, without it being typed again", async () => {
    const script: Script = { free: FREE_MODELS, calls: [] };
    const { stdin, lastFrame } = await runIntoThePaywall(script);

    expect(script.calls).toEqual([{ model: PAID, prompt: TASK }]);

    stdin.write("\r"); // enter at the paywall opens the chooser
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("Pick a free model");

    stdin.write("\r"); // and its first row is the model with the most turns left
    await tick(200);

    // The same prompt, on the free model, with nothing retyped in between.
    expect(script.calls).toEqual([
      { model: PAID, prompt: TASK },
      { model: FREE, prompt: TASK },
    ]);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain(`model → ${FREE}`);
    // Saved as the default, like /model saves it: switching for one turn only
    // would 402 again on the very next message, which is the loop this breaks.
    expect(loadConfig().model).toBe(FREE);
  });

  it("keeps the wall on the chooser, because the free tier runs out and the wall does not", async () => {
    const script: Script = { free: FREE_MODELS, calls: [] };
    const { stdin, lastFrame } = await runIntoThePaywall(script);
    stdin.write("\r");
    await tick(120);

    const chooser = strip(lastFrame() ?? "");
    expect(chooser).toContain("earn credits instead");
    expect(chooser).toContain("offers pay ~51,000 credits on completion (median)");

    // Taking it goes to the wall, and the interrupted task is still waiting
    // behind it — the wall path was not changed, only reached differently.
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(150);
    expect(strip(lastFrame() ?? "")).toContain("waiting for the offer…");
  });

  it("changes nothing on esc, and the request is still there", async () => {
    const script: Script = { free: FREE_MODELS, calls: [] };
    const { stdin, lastFrame } = await runIntoThePaywall(script);

    stdin.write("\r");
    await tick(120);
    stdin.write(ESC);
    await tick(120);

    expect(strip(lastFrame() ?? "")).not.toContain("Pick a free model");
    expect(script.calls).toHaveLength(1); // nothing was run

    // Enter opens it again, which is what the notice said would happen.
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("Pick a free model");
  });
});

describe("the paywall names the cheapest pack after /buy", () => {
  it("quotes the gateway's figure on both notices", async () => {
    for (const free of [FREE_MODELS, []]) {
      const { lastFrame } = await runIntoThePaywall({ free, pack: 3, calls: [] });
      expect(strip(lastFrame() ?? "")).toContain("/buy is there too, from $3, if you would rather pay than do an offer.");
    }
  });

  it("says what it always said when the gateway names no pack", async () => {
    const { lastFrame } = await runIntoThePaywall({ free: [], pack: null, calls: [] });
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("/buy is there too, if you would rather pay than do an offer.");
    expect(out).not.toContain("from $");
  });
});

describe("the paywall names our own survey first when one is open (2026-10-19)", () => {
  it("says what it pays, that nobody is screened out and how many are left, on both notices", async () => {
    for (const free of [FREE_MODELS, []]) {
      const { lastFrame } = await runIntoThePaywall({ free, own: { credits: 10_000, leftToday: 4 }, calls: [] });
      expect(strip(lastFrame() ?? "").replace(/\s+/g, " ")).toContain(
        "Our own surveys pay 10,000 credits each and nobody is screened out (4 left today). They are first on the wall.",
      );
    }
  });

  it("says nothing about them when the gateway offers none", async () => {
    const { lastFrame } = await runIntoThePaywall({ free: [], calls: [] });
    expect(strip(lastFrame() ?? "")).not.toContain("Our own surveys");
  });
});

describe("with nothing free left, the old path is untouched", () => {
  it("goes straight to the wall on enter, with no chooser in between", async () => {
    // The gateway has already applied the pause switch, the global budget and
    // this account's own day, so an empty list means there is genuinely nothing
    // to offer — and a chooser with one row is a dialog asking somebody to
    // confirm the only thing they can do.
    const script: Script = { free: [], calls: [] };
    const { stdin, lastFrame } = await runIntoThePaywall(script);

    const notice = strip(lastFrame() ?? "");
    expect(notice).toContain("Press enter to open the ad wall");
    expect(notice).toContain("offers pay ~51,000 credits on completion (median)");
    expect(notice).not.toContain("still free today");

    stdin.write("\r");
    await tick(150);
    const out = strip(lastFrame() ?? "");
    expect(out).not.toContain("Pick a free model");
    expect(out).toContain("waiting for the offer…");
  });
});
