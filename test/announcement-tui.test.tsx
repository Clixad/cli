/**
 * The one-time announcement of 14 November 2026: shown once per install, when
 * the gateway says the streak now adds free usage, never on an older gateway,
 * and never to an account that never had the old arrangement.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { GatewayClient, StreakInfo, WalletInfo } from "../src/client.ts";
import { CREDIT_MODEL_NOTICE_ID, creditModelNotice } from "../src/announcements.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};

const streak = (over: Partial<StreakInfo> = {}): StreakInfo => ({
  day: 2,
  credits: 300,
  claimed: true,
  balance: 4988,
  schedule: [200, 300, 400],
  length: 3,
  freeAllowance: true,
  ...over,
});

const api = {
  models: async () => [],
  wallet: async () => wallet,
  claimStreak: async () => null,
} as unknown as GatewayClient;

const config = (over: Partial<CliConfig> = {}): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gpt-5-nano",
  ...over,
});

async function open(cfg: CliConfig, s: StreakInfo | null, newAccount = false) {
  const view = render(<App client={api} config={cfg} wallet={wallet} streak={s} {...(newAccount ? { newAccount } : {})} />);
  await tick();
  const frame = strip(view.lastFrame() ?? "").replace(/\s+/g, " ");
  view.unmount();
  return frame;
}

describe("the announcement of the free-usage change", () => {
  it("is shown once, then remembered for this install", async () => {
    const cfg = config();
    const first = await open(cfg, streak());
    expect(first).toContain("Since 14 November the budget models are free every day up to a daily limit");
    expect(first).toContain("Credits you already have stay in your balance and work as before.");
    expect(cfg.seenNotices).toEqual([CREDIT_MODEL_NOTICE_ID]);
    const second = await open(cfg, streak({ claimed: false, credits: 0 }));
    expect(second).not.toContain("Since 14 November");
  });

  it("waits for a gateway that has made the change", async () => {
    const cfg = config();
    const { freeAllowance: _, ...older } = streak();
    expect(await open(cfg, older)).not.toContain("Since 14 November");
    expect(await open(cfg, null)).not.toContain("Since 14 November");
    expect(cfg.seenNotices).toBeUndefined();
  });

  it("is not told to a new account, and not later either", () => {
    const cfg = config();
    expect(creditModelNotice(cfg, streak(), true)).toEqual({ text: null, markSeen: true });
    expect(creditModelNotice({ seenNotices: [CREDIT_MODEL_NOTICE_ID] }, streak(), false)).toEqual({
      text: null,
      markSeen: false,
    });
  });
});
