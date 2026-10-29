/**
 * Premium models in the REPL (2026-10-04), driven through the real key handling.
 *
 * Bonus credits pay for budget models only; a premium model takes credits
 * earned on the offer walls or bought (since 2026-10-19 also after a purchase,
 * and with no login-streak allowance). The REPL has to say that at two
 * moments, and both are pinned here:
 *
 *  1. **Before anybody picks.** `/model` marks a premium row `locked` when the
 *     gateway says the account has no earned or bought credits, with what
 *     unlocks it, and says so again if somebody picks it anyway.
 *  2. **When a turn is refused.** Not the paywall's "out of credits", which
 *     would be false next to a balance of bonus credits, but what unlocks the
 *     model; and enter opens a chooser whose rows are the survey, the pack,
 *     and the free budget models, the last of which re-runs the request
 *     without it being typed again.
 *
 * Every figure on screen came off the wire, `grantLabel`'s rule.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

// The wall opens a browser; a test must not spawn one.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { PremiumLockedError } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const PREMIUM = "claude-opus-5.5";
const FREE = "deepseek-v4-flash";
const TASK = "rename the upload handler";

const config = (model = PREMIUM): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
});

const wallet = (premium?: WalletInfo["premium"]): WalletInfo => ({
  balance: 25_000,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 41_000,
  ledger: [],
  ...(premium ? { premium } : {}),
});

interface Script {
  calls: { model: string; prompt: string }[];
  premium?: WalletInfo["premium"];
  unlockUsd?: number | null;
  /** What the wallet answers while the wall is open, when a test moves it. */
  live?: { balance: number; premiumCredits: number };
}

/** A gateway whose premium gate refuses this account, and that answers on anything else. */
function stubClient(script: Script): GatewayClient {
  return {
    models: async () => [
      { id: FREE, tier: "cheap", access: "budget", est_ads_per_task: 0.04, free: true },
      { id: "claude-haiku-4.5", tier: "mid", access: "budget", est_ads_per_task: 0.4, free: false },
      { id: PREMIUM, tier: "premium", access: "premium", est_ads_per_task: 18, free: false },
    ],
    wallet: async (_signal?: AbortSignal, opts: { premium?: boolean } = {}) =>
      script.live
        ? {
            ...wallet(),
            balance: script.live.balance,
            ...(opts.premium ? { premium: { unlocked: false, credits: script.live.premiumCredits } } : {}),
          }
        : wallet(script.premium),
    get premiumUnlockUsd() {
      return script.unlockUsd === undefined ? 5 : script.unlockUsd;
    },
    claimStreak: async () => null,
    handoffCode: async () => "hoff_1",
    async chatStream(messages: ChatMessage[], model: string, opts: ChatOptions): Promise<ChatTurn> {
      const last = messages[messages.length - 1];
      const prompt = typeof last?.content === "string" ? last.content : "";
      script.calls.push({ model, prompt });
      if (model === PREMIUM) {
        throw new PremiumLockedError(
          "Premium: complete an offer-wall survey or buy credits from $5. (the gateway's whole sentence)",
          PREMIUM,
          16_500,
          0,
          script.unlockUsd === undefined ? 5 : script.unlockUsd,
          41_000,
          [{ id: FREE, turnsLeft: 82 }],
        );
      }
      opts.onDelta?.("done");
      return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 0, balance: 25_000 };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";
const ARROW_DOWN = "\x1b[B";

async function runIntoTheGate(script: Script) {
  const view = render(<App client={stubClient(script)} config={config()} wallet={wallet()} />);
  view.stdin.write(TASK);
  await tick();
  view.stdin.write("\r");
  await tick(150);
  return view;
}

describe("a premium turn on bonus credits", () => {
  it("says what unlocks the model, not that the wallet is empty", async () => {
    const { lastFrame } = await runIntoTheGate({ calls: [] });
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Premium: complete an offer-wall survey or buy credits from $5.");
    expect(out).toContain(`${PREMIUM} is a premium model`);
    expect(out.replace(/\s+/g, " ")).toContain("It runs on credits from offer-wall surveys or purchases.");
    expect(out).not.toMatch(/streak/i);
    expect(out).toContain("bonus credits");
    expect(out).toContain("Your request is kept.");
    expect(out).not.toContain("Out of credits");
    expect(out).not.toContain("Not enough credits");
  });

  it("opens a chooser on enter: the survey, the pack, then the free budget models", async () => {
    const { stdin, lastFrame } = await runIntoTheGate({ calls: [] });
    stdin.write("\r");
    await tick(100);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("complete an offer-wall survey");
    expect(out).toContain("~41,000 credits on completion (median)");
    expect(out).toContain("buy credits from $5");
    expect(out).toContain("bought credits work on every model");
    expect(out).toContain(FREE);
    expect(out).toContain("~82 turns left today");
    expect(out.indexOf("complete an offer-wall survey")).toBeLessThan(out.indexOf("buy credits from $5"));
    expect(out.indexOf("buy credits from $5")).toBeLessThan(out.lastIndexOf(FREE));
  });

  it("waits at the wall for credits that pay for premium, not for any credit (2026-10-19)", async () => {
    // Our own surveys are the first card on the wall and pay bonus credits.
    // Finishing one used to re-run the premium request straight into the
    // same refusal; now the wait goes on until the credits that pay for
    // premium are there.
    const script: Script = { calls: [] };
    const { stdin, lastFrame } = await runIntoTheGate(script);
    script.live = { balance: 25_000, premiumCredits: 0 };
    stdin.write("\r");
    await tick(100);
    stdin.write("\r"); // the first row: the offer walls
    await tick(200);
    script.live = { balance: 35_000, premiumCredits: 0 };
    await tick(3_300);
    expect(script.calls).toHaveLength(1);
    expect(strip(lastFrame() ?? "").replace(/\s+/g, " ")).toContain("bonus credits landed. They pay for budget models");
    script.live = { balance: 75_000, premiumCredits: 40_000 };
    await tick(3_300);
    expect(script.calls).toEqual([
      { model: PREMIUM, prompt: TASK },
      { model: PREMIUM, prompt: TASK },
    ]);
  }, 15_000);

  it("offers no pack where nothing can be bought", async () => {
    const { stdin, lastFrame } = await runIntoTheGate({ calls: [], unlockUsd: null });
    expect(strip(lastFrame() ?? "")).toContain("Premium: complete an offer-wall survey to unlock it.");
    stdin.write("\r");
    await tick(100);
    expect(strip(lastFrame() ?? "")).not.toContain("buy credits from");
  });

  it("re-runs the request on a budget model picked there, without it being typed again", async () => {
    const script: Script = { calls: [] };
    const { stdin, lastFrame } = await runIntoTheGate(script);
    stdin.write("\r");
    await tick(100);
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(200);
    expect(script.calls).toEqual([
      { model: PREMIUM, prompt: TASK },
      { model: FREE, prompt: TASK },
    ]);
    expect(strip(lastFrame() ?? "")).toContain(`model → ${FREE} (budget)`);
  });

  it("changes nothing on esc, and enter opens the chooser again", async () => {
    const script: Script = { calls: [] };
    const { stdin, lastFrame } = await runIntoTheGate(script);
    stdin.write("\r");
    await tick(100);
    stdin.write(ESC);
    await tick(100);
    expect(script.calls).toHaveLength(1);
    stdin.write("\r");
    await tick(100);
    expect(strip(lastFrame() ?? "")).toContain("complete an offer-wall survey");
  });
});

describe("/model before anybody picks", () => {
  async function openPicker(script: Script) {
    const view = render(<App client={stubClient(script)} config={config(FREE)} wallet={wallet()} />);
    view.stdin.write("/model");
    await tick();
    view.stdin.write("\r");
    await tick(200);
    return view;
  }

  it("marks a premium row locked, with what unlocks it, when the account has no earned credits", async () => {
    const { lastFrame } = await openPicker({ calls: [], premium: { unlocked: false, credits: 0 } });
    const out = strip(lastFrame() ?? "");
    const row = out.split("\n").find((l) => l.includes(PREMIUM)) ?? "";
    expect(row).toContain("locked");
    expect(row).toContain("premium: an offer-wall survey or $5 unlocks it");
    const budget = out.split("\n").find((l) => l.includes("claude-haiku-4.5")) ?? "";
    expect(budget).toContain("budget");
    expect(budget).not.toContain("locked");
  });

  it("does not mark it locked once there are earned credits, or after a purchase", async () => {
    for (const premium of [
      { unlocked: false, credits: 40_000 },
      { unlocked: true, credits: 25_000 },
    ]) {
      const { lastFrame, unmount } = await openPicker({ calls: [], premium });
      const row = strip(lastFrame() ?? "").split("\n").find((l) => l.includes(PREMIUM)) ?? "";
      expect(row).toContain("premium");
      expect(row).not.toContain("locked");
      unmount();
    }
  });

  it("marks nothing locked when the gateway did not say", async () => {
    const { lastFrame } = await openPicker({ calls: [] });
    expect(strip(lastFrame() ?? "")).not.toContain("locked");
  });

  it("says what unlocks it when a locked row is picked anyway", async () => {
    const { stdin, lastFrame } = await openPicker({ calls: [], premium: { unlocked: false, credits: 0 } });
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(150);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain(`model → ${PREMIUM}`);
    expect(out).toContain("Premium: complete an offer-wall survey or buy credits from $5.");
    expect(out).toContain("/buy sells credits from $5 that work on every model.");
  });
});
