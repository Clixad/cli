/**
 * What a premium task costs, said before it runs (2026-11-01).
 *
 * The report: "1.3 ads per task" for Claude Sonnet 5.5 said nothing about how
 * many credits a task takes, so people could not plan and got stuck part way.
 * So `/model` quotes each row's task in credits at the conversation's size,
 * with a verdict against what the account may spend on that kind of model; the
 * status line names the premium figure when it is below the balance; a task
 * that would stop part way is held back once a session at Enter; and a turn
 * that leaves less than a typical next task says so.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatOptions, ChatTurn, GatewayClient, ModelInfo, WalletInfo } from "../src/client.ts";
import type { TaskShape } from "../src/estimate.ts";

const PREMIUM = "claude-opus-5.5";
const BUDGET = "kimi-k2.5";

const config = (model: string, effort?: Record<string, string>): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
  ...(effort ? { effort } : {}),
});

const SHAPE: TaskShape = { callsTypical: 2, callsLong: 15, growthTokens: 500, outputTokens: 600 };

const row = (id: string, access: "budget" | "premium", input: number, output: number): ModelInfo => ({
  id,
  label: id,
  provider: "x",
  tier: access === "premium" ? "premium" : "cheap",
  ad_fundable: true,
  credits_per_mtoken_input: input,
  credits_per_mtoken_output: output,
  est_credits_per_task: 0,
  est_ads_per_task: 1.3,
  free: false,
  access,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "high",
});

const CATALOG = [row(BUDGET, "budget", 90_000, 375_000), row(PREMIUM, "premium", 750_000, 3_750_000)];

/** Bonus credits in the balance, `premium` of them spendable on a premium model. */
const wallet = (balance: number, premium: number): WalletInfo => ({
  balance,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 40_800,
  ledger: [],
  premium: { unlocked: false, credits: premium },
});

function stubClient(w: WalletInfo, turns: Partial<ChatTurn>[] = [{}]) {
  const calls: string[] = [];
  let turn = 0;
  const client = {
    models: async () => CATALOG,
    wallet: async () => w,
    claimStreak: async () => null,
    retiredModels: {},
    premiumUnlockUsd: 3,
    get taskShape() {
      return SHAPE;
    },
    get capabilities() {
      return { web_search: false };
    },
    async chatStream(_messages: unknown, model: string, opts: ChatOptions): Promise<ChatTurn> {
      calls.push(model);
      const next = turns[Math.min(turn++, turns.length - 1)]!;
      opts.onDelta?.("done");
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 0,
        balance: w.balance,
        ...next,
      };
    },
  } as unknown as GatewayClient;
  return { client, calls };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function enter(view: ReturnType<typeof render>) {
  view.stdin.write("\r");
  await tick(200);
}

describe("the status line on a premium model", () => {
  it("names the premium figure when it is below the balance", async () => {
    const w = wallet(33_396, 5_000);
    const { client } = stubClient(w);
    const view = render(<App client={client} config={config(PREMIUM)} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    expect(strip(view.lastFrame()!)).toMatch(/task ≈ [\d.]+k–\d+k · 5k premium · not enough/);
    view.unmount();
  });

  it("shows the floor on a raised /effort, and the whole range at the default or below", async () => {
    // The shape was measured at the defaults: what a task costs at least holds
    // on a raised setting, what a long one costs does not.
    const w = wallet(5_000_000, 5_000_000);
    for (const [effort, mark] of [["max", "task ≥"], ["xhigh", "task ≥"], ["high", "task ≈"], ["low", "task ≈"]] as const) {
      const { client } = stubClient(w);
      const view = render(<App client={client} config={config(PREMIUM, { [PREMIUM]: effort })} wallet={w} />);
      await tick();
      view.stdin.write("fix the failing upload test");
      await tick();
      expect(strip(view.lastFrame()!), effort).toContain(mark);
      view.unmount();
    }
  });
});

describe("Enter on a premium task that would stop part way", () => {
  it("holds it back once with what it costs, keeps the text, and sends it on the next Enter", async () => {
    const w = wallet(33_396, 5_000);
    const { client, calls } = stubClient(w);
    const view = render(<App client={client} config={config(PREMIUM)} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    await enter(view);
    // The notice wraps at the terminal's width; its words are what is checked.
    let frame = strip(view.lastFrame()!).replace(/\s+/g, " ");
    expect(calls).toEqual([]);
    expect(frame).toContain(`This task likely costs about`);
    expect(frame).toContain(`premium models can spend 5,000 of yours, so it would stop part way.`);
    expect(frame).toContain("Enter sends it anyway. /model picks a budget model, /earn opens the offer walls, /buy sells credits from $3.");
    expect(frame).toContain("fix the failing upload test");

    await enter(view);
    expect(calls).toEqual([PREMIUM]);

    // Once a session: the next one goes straight through.
    view.stdin.write("and the download test");
    await tick();
    await enter(view);
    expect(calls).toEqual([PREMIUM, PREMIUM]);
    frame = strip(view.lastFrame()!);
    expect(frame.split("This task likely costs").length - 1).toBe(1);
    view.unmount();
  });

  it("leaves a budget model alone, and a premium task that fits", async () => {
    for (const [model, w] of [
      [BUDGET, wallet(100, 0)],
      [PREMIUM, wallet(5_000_000, 5_000_000)],
    ] as const) {
      const { client, calls } = stubClient(w);
      const view = render(<App client={client} config={config(model)} wallet={w} />);
      await tick();
      view.stdin.write("fix the failing upload test");
      await tick();
      await enter(view);
      expect(calls, model).toEqual([model]);
      expect(strip(view.lastFrame()!), model).not.toContain("This task likely costs");
      view.unmount();
    }
  });
});

describe("the end of a premium turn", () => {
  it("says when what premium may still spend is under a typical next task, once until it covers one again", async () => {
    const w = wallet(500_000, 500_000);
    const left = { budget: 30_000, premium: 2_000, budgetAfterReset: 30_000 };
    const { client } = stubClient(w, [{ creditsCharged: 9_000, balance: 30_000, spendable: left }]);
    const view = render(<App client={client} config={config(PREMIUM)} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    await enter(view);
    let frame = strip(view.lastFrame()!);
    expect(frame).toMatch(/2,000 premium credits left, under what a typical next task on claude-opus-5\.5 costs \(about [\d.]+k\)/);
    expect(frame).toContain("/model picks a budget model, /earn or /buy adds credits.");

    view.stdin.write("and again");
    await tick();
    await enter(view);
    await enter(view);
    frame = strip(view.lastFrame()!);
    expect(frame.split("premium credits left, under").length - 1).toBe(1);
    view.unmount();
  });
});

describe("/model", () => {
  it("quotes each row's task in credits, with a verdict against what that kind of model may spend", async () => {
    const w = wallet(33_396, 5_000);
    const { client } = stubClient(w);
    const view = render(<App client={client} config={config(BUDGET)} wallet={w} />);
    await tick();
    view.stdin.write("/model");
    await tick();
    await enter(view);
    const frame = strip(view.lastFrame()!);
    expect(frame).toMatch(/claude-opus-5\.5\s+premium task ≈ [\d.]+k–\d+k · not enough \(5k premium credits\)/);
    expect(frame).toMatch(/kimi-k2\.5\s+budget\s+task ≈ [\d.]+k?–[\d.]+k · covered/);
    expect(frame).not.toContain("ads/task");
    view.unmount();
  });
});
