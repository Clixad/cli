/**
 * The free models and the cost preview, as the REPL actually draws them.
 *
 * `free-notice.test.ts` and `estimate.test.ts` hold the wording and the
 * arithmetic; this holds the wiring: that the startup notice is on screen, that
 * `/help` leads with the free line, and that the preview appears under the input
 * while a task is typed and at no other time.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { GatewayClient, ModelInfo, WalletInfo } from "../src/client.ts";
import type { TaskShape } from "../src/estimate.ts";

const PAID = "claude-opus-5.5";

const config = (model = PAID): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
});

const FREE_TIER: NonNullable<WalletInfo["free_tier"]> = {
  models: ["gpt-5-nano", "gemini-2.5-flash-lite", "deepseek-v4-flash", "gemini-3.5-flash-lite", "kimi-k2.5"],
  daily_credits: 12_000,
  credits_left: 12_000,
  turns_left: {
    "gpt-5-nano": 50,
    "gemini-2.5-flash-lite": 30,
    "deepseek-v4-flash": 24,
    "gemini-3.5-flash-lite": 11,
    "kimi-k2.5": 5,
  },
  recommended: "deepseek-v4-flash",
};

const wallet = (balance: number, free = FREE_TIER): WalletInfo => ({
  balance,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 51_000,
  free_tier: free,
  ledger: [],
});

const row = (id: string, input: number, output: number, free: boolean): ModelInfo => ({
  id,
  label: id,
  provider: "x",
  tier: free ? "cheap" : "premium",
  ad_fundable: true,
  credits_per_mtoken_input: input,
  credits_per_mtoken_output: output,
  est_credits_per_task: 0,
  est_ads_per_task: 1,
  free,
});

/** The engine's credit prices for the two models these tests switch between. */
const CATALOG = [row("deepseek-v4-flash", 21_000, 42_000, true), row(PAID, 750_000, 3_750_000, false)];

const SHAPE: TaskShape = { callsTypical: 2, callsLong: 10, growthTokens: 300, outputTokens: 600 };

/** `shape: null` is a gateway that sends none, which is not the same as the default. */
function stubClient(w: WalletInfo, shape: TaskShape | null = SHAPE): GatewayClient {
  return {
    models: async () => CATALOG,
    wallet: async () => w,
    claimStreak: async () => null,
    get taskShape() {
      return shape ?? undefined;
    },
    get capabilities() {
      return { web_search: false };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("when the REPL opens", () => {
  it("says which models are free and how to get to one", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    const frame = strip(view.lastFrame()!);
    expect(frame).toContain("5 models are free today");
    expect(frame).toContain("/model switches");
    view.unmount();
  });

  it("leads with the empty balance when there is one", async () => {
    const w = wallet(0);
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    expect(strip(view.lastFrame()!)).toContain("Your balance is empty, but deepseek-v4-flash is still free today");
    view.unmount();
  });

  it("says nothing about free models on a gateway with no free tier", async () => {
    const w = { ...wallet(4_988), free_tier: undefined };
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    expect(strip(view.lastFrame()!)).not.toContain("free today");
    view.unmount();
  });
});

describe("/help", () => {
  it("leads with the free models", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    view.stdin.write("/help");
    await tick();
    view.stdin.write("\r");
    await tick(120);
    expect(strip(view.lastFrame()!)).toContain("12,000 free credits left");
    view.unmount();
  });
});

describe("the cost preview", () => {
  it("appears while a task is typed, and says when the wallet will not cover it", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    const frame = strip(view.lastFrame()!);
    expect(frame).toMatch(/task ≈ [\d.]+k–[\d.]+k · not enough, \/model/);
    view.unmount();
  });

  // Since 2026-10-04 a premium model takes credits earned or bought, so a
  // balance of bonus credits is not what covers a premium task, and the
  // preview may not say it is: that would be a preview for a refused turn.
  it("counts only the credits premium takes on a premium model", async () => {
    const premiumCatalog = CATALOG.map((m) => ({ ...m, access: m.free ? ("budget" as const) : ("premium" as const) }));
    const client = (w: WalletInfo) =>
      ({ ...stubClient(w), models: async () => premiumCatalog }) as unknown as GatewayClient;
    const typedOn = async (w: WalletInfo) => {
      const view = render(<App client={client(w)} config={config()} wallet={w} />);
      await tick();
      view.stdin.write("fix the failing upload test");
      await tick();
      const frame = strip(view.lastFrame()!);
      view.unmount();
      return frame;
    };
    // Plenty of credits, none of them premium ones.
    expect(await typedOn({ ...wallet(5_000_000), premium: { unlocked: false, credits: 0 } })).toMatch(
      /task ≈ [\d.]+k–[\d.]+k · not enough/,
    );
    // The same balance after a purchase covers it.
    expect(await typedOn({ ...wallet(5_000_000), premium: { unlocked: true, credits: 5_000_000 } })).not.toContain(
      "not enough",
    );
    // A gateway that did not say counts the balance, as before the rule.
    expect(await typedOn(wallet(5_000_000))).not.toContain("not enough");
  });

  it("says free on a free model the allowance covers", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w)} config={config("deepseek-v4-flash")} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    expect(strip(view.lastFrame()!)).toMatch(/task ≈ \d+–[\d.]+k? · free/);
    view.unmount();
  });

  it("is not there on a raised /effort setting, and stays on a lowered one", async () => {
    // `task_shape` was measured at the models' defaults, so it would understate
    // a task that thinks longer, and a preview shown too low is the one that
    // meets the paywall halfway. A lowered setting errs the other way.
    const w = wallet(5_000_000);
    const opus = { ...row(PAID, 750_000, 3_750_000, false), efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" };
    const client = { ...stubClient(w), models: async () => [opus] } as unknown as GatewayClient;
    Object.defineProperty(client, "taskShape", { get: () => SHAPE });
    for (const [effort, shown] of [["max", false], ["xhigh", false], ["high", true], ["low", true]] as const) {
      const view = render(<App client={client} config={{ ...config(), effort: { [PAID]: effort } }} wallet={w} />);
      await tick();
      view.stdin.write("fix the failing upload test");
      await tick();
      const frame = strip(view.lastFrame()!);
      if (shown) expect(frame, effort).toContain("task ≈");
      else expect(frame, effort).not.toContain("task ≈");
      view.unmount();
    }
  });

  it("is not there for a slash command, a shell command, or an empty box", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w)} config={config()} wallet={w} />);
    await tick();
    expect(strip(view.lastFrame()!)).not.toContain("task ≈");
    view.stdin.write("!ls");
    await tick();
    expect(strip(view.lastFrame()!)).not.toContain("task ≈");
    view.unmount();
  });

  it("is not there when the gateway sent no task shape", async () => {
    const w = wallet(4_988);
    const view = render(<App client={stubClient(w, null)} config={config()} wallet={w} />);
    await tick();
    view.stdin.write("fix the failing upload test");
    await tick();
    expect(strip(view.lastFrame()!)).not.toContain("task ≈");
    view.unmount();
  });
});
