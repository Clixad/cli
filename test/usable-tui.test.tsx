/**
 * What the status line says can be spent (2026-10-12).
 *
 * The report: a refusal at the daily limit of 40,000 bonus credits on every
 * model, under a status line reading "33,396 cr". The balance was right and
 * none of it could be spent, because all of it was bonus credits past the
 * day's limit. So the status line now shows what a call on the model in use
 * may spend, from figures the gateway works out (`Spendable`), and what is
 * held back and until when. The rule pinned here is the one that keeps that
 * figure from ever being wrong: it is shown only while it belongs to the
 * balance on screen and to today, and the moment it does not, the row falls
 * back to the bare balance and one wallet read fetches figures that do.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App, lockedPhrasings, statusLine, walletUsableLines } from "../src/tui/app.tsx";
import { LimitRefusalError } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatOptions, ChatTurn, GatewayClient, Spendable, WalletInfo } from "../src/client.ts";
import { visibleLength } from "../src/banner.ts";

const BUDGET = "kimi-k2.5";
const PREMIUM = "claude-opus-5.5";

const config = (model: string): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
});

const wire = (f: Spendable) => ({ budget: f.budget, premium: f.premium, budget_after_reset: f.budgetAfterReset });

const wallet = (balance: number, spendable?: Spendable): WalletInfo => ({
  balance,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 41_000,
  ledger: [],
  premium: { unlocked: false, credits: spendable?.premium ?? 0 },
  ...(spendable ? { spendable: wire(spendable) } : {}),
});

interface Script {
  wallet: WalletInfo;
  /** What each turn ends with, in order; the last one repeats. */
  turns: (Partial<ChatTurn> | Error)[];
  walletReads: { premium: boolean }[];
}

function stubClient(script: Script): GatewayClient {
  let turn = 0;
  return {
    models: async () => [
      { id: BUDGET, tier: "cheap", access: "budget", est_ads_per_task: 0.4, free: false },
      { id: PREMIUM, tier: "premium", access: "premium", est_ads_per_task: 18, free: false },
    ],
    wallet: async (_signal?: AbortSignal, opts: { premium?: boolean } = {}) => {
      script.walletReads.push({ premium: opts.premium === true });
      return script.wallet;
    },
    claimStreak: async () => null,
    handoffCode: async () => "hoff_1",
    async chatStream(_messages: unknown, _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const next = script.turns[Math.min(turn++, script.turns.length - 1)]!;
      if (next instanceof Error) throw next;
      opts.onDelta?.("done");
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 0,
        balance: script.wallet.balance,
        ...next,
      };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** The status row of a frame: the line that carries the permission mode. */
const statusRow = (frame: string | undefined) =>
  strip(frame ?? "")
    .split("\n")
    .findLast((l) => l.includes("ask before edits")) ?? "";
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function open(model: string, script: Script) {
  return render(<App client={stubClient(script)} config={config(model)} wallet={script.wallet} />);
}

async function turn(view: ReturnType<typeof open>, text = "rename the upload handler") {
  view.stdin.write(text);
  await tick();
  view.stdin.write("\r");
  await tick(200);
}

describe("the usable figure on the status line", () => {
  it("shows what a budget call may spend, and that the rest waits for 00:00 UTC", async () => {
    // The report, as figures: 33,396 credits, every one of them bonus, the day's limit spent.
    const script: Script = {
      wallet: wallet(33_396, { budget: 0, premium: 0, budgetAfterReset: 33_396 }),
      turns: [{}],
      walletReads: [],
    };
    const { lastFrame } = open(BUDGET, script);
    await tick(100);
    const status = statusRow(lastFrame());
    expect(status).toContain("0 cr usable · 33,396 bonus locked until 00:00 UTC");
    expect(status).not.toContain("33,396 cr");
    // Figures that came with the startup wallet need no read of their own.
    expect(script.walletReads).toEqual([]);
  });

  it("shows premium's own figure on a premium model", async () => {
    const script: Script = {
      wallet: wallet(33_396, { budget: 12_000, premium: 500, budgetAfterReset: 33_396 }),
      turns: [{}],
      walletReads: [],
    };
    const { lastFrame } = open(PREMIUM, script);
    await tick(100);
    expect(strip(lastFrame() ?? "")).toContain("500 cr usable · 32,896 bonus locked on premium");
  });

  it("says when only a day's limit of the locked credits comes back at the reset", async () => {
    const script: Script = {
      wallet: wallet(55_358, { budget: 37, premium: 37, budgetAfterReset: 40_037 }),
      turns: [{}],
      walletReads: [],
    };
    const { lastFrame } = open(BUDGET, script);
    await tick(100);
    expect(strip(lastFrame() ?? "")).toContain("37 cr usable · 55,321 bonus locked, 40,000 usable from 00:00 UTC");
  });

  it("shows the balance as it always did when nothing is held back", async () => {
    const script: Script = {
      wallet: wallet(33_396, { budget: 33_396, premium: 33_396, budgetAfterReset: 33_396 }),
      turns: [{}],
      walletReads: [],
    };
    const { lastFrame } = open(BUDGET, script);
    await tick(100);
    const status = statusRow(lastFrame());
    expect(status).toContain("33,396 cr");
    expect(status).not.toContain("usable");
  });

  it("takes the figures a paid turn ends with", async () => {
    const script: Script = {
      wallet: wallet(33_396, { budget: 10_000, premium: 0, budgetAfterReset: 33_396 }),
      turns: [{ creditsCharged: 4_000, balance: 29_396, spendable: { budget: 6_000, premium: 0, budgetAfterReset: 29_396 } }],
      walletReads: [],
    };
    const view = open(BUDGET, script);
    await tick(100);
    expect(strip(view.lastFrame() ?? "")).toContain("10,000 cr usable");
    await turn(view);
    expect(strip(view.lastFrame() ?? "")).toContain("6,000 cr usable · 23,396 bonus locked until 00:00 UTC");
    expect(script.walletReads).toEqual([]);
  });

  it("drops figures the balance has moved away from, and reads the wallet for new ones", async () => {
    // A free call after a web search: the balance moved and no figures came with it.
    const script: Script = {
      wallet: wallet(33_396, { budget: 0, premium: 0, budgetAfterReset: 33_396 }),
      turns: [{ creditsCharged: 0, balance: 32_321 }],
      walletReads: [],
    };
    const view = open(BUDGET, script);
    await tick(100);
    // The read answers with the new balance and figures that belong to it.
    script.wallet = wallet(32_321, { budget: 0, premium: 0, budgetAfterReset: 32_321 });
    await turn(view);
    await tick(100);
    expect(script.walletReads).toEqual([{ premium: true }]);
    expect(strip(view.lastFrame() ?? "")).toContain("0 cr usable · 32,321 bonus locked until 00:00 UTC");
  });

  it("never shows figures for another balance, even when no new ones can be had", async () => {
    // An older gateway: the read brings no figures, so the row keeps the bare balance.
    const script: Script = {
      wallet: wallet(33_396, { budget: 0, premium: 0, budgetAfterReset: 33_396 }),
      turns: [{ creditsCharged: 0, balance: 32_321 }],
      walletReads: [],
    };
    const view = open(BUDGET, script);
    await tick(100);
    script.wallet = wallet(32_321);
    await turn(view);
    await tick(100);
    const status = statusRow(view.lastFrame());
    expect(status).toContain("32,321 cr");
    expect(status).not.toContain("usable");
    // Asked once for that balance, not on every render.
    expect(script.walletReads).toHaveLength(1);
  });

  it("prints a refusal at the daily limit whole, and shows what it says can be spent", async () => {
    const message = [
      "You have reached your personal daily limit of 40,000 bonus credits (credits we granted, like the signup bonus or our own surveys).",
      "Your 33,396 credits are all bonus credits.",
      "They can be spent again from 00:00 UTC (in about 9 h 30 min).",
      "Credits you earn on the offer walls or buy have no daily limit, so you can keep going today with /earn or a pack from $3 (/buy). There are no free turns left for you today.",
      "Nothing was charged for this request.",
    ].join("\n");
    const script: Script = {
      // The wallet the REPL opened with did not know the limit was reached yet.
      wallet: wallet(33_396, { budget: 2_000, premium: 0, budgetAfterReset: 33_396 }),
      turns: [
        new LimitRefusalError(message, "paid_user_limit_reached", {
          figures: { budget: 0, premium: 0, budgetAfterReset: 33_396 },
          balance: 33_396,
        }),
      ],
      walletReads: [],
    };
    const view = open(BUDGET, script);
    await tick(100);
    await turn(view);
    const out = strip(view.lastFrame() ?? "");
    for (const line of message.split("\n")) expect(out.replace(/\s+/g, " ")).toContain(line);
    expect(out).toContain("0 cr usable · 33,396 bonus locked until 00:00 UTC");
  });
});

describe("the row stays one row", () => {
  const usable = { kind: "budget" as const, credits: 1_200, locked: 32_196, afterReset: 33_396 };

  it("gives up the locked clause's words before the usable figure", () => {
    const row = (cols: number) =>
      statusLine({ model: BUDGET, balance: 33_396, usable, spent: 0, contextPct: 0, minutes: 0 }, cols);
    expect(row(120)).toContain("1,200 cr usable · 32,196 bonus locked until 00:00 UTC");
    expect(row(56)).toContain("1,200 cr usable · 32,196 bonus locked");
    expect(row(56)).not.toContain("00:00");
    expect(row(28)).toContain("1,200 cr usable");
    expect(row(28)).not.toContain("locked");
    for (const cols of [20, 28, 40, 48, 60, 80, 120]) expect(visibleLength(row(cols))).toBeLessThanOrEqual(cols);
  });

  it("keeps the cost preview over the locked clause while a task is typed", () => {
    const row = statusLine(
      {
        model: BUDGET,
        balance: 33_396,
        usable,
        spent: 0,
        contextPct: 0,
        minutes: 0,
        estimate: ["task ≈ 900–2,400 cr · covered", "≈ 900–2,400 · covered"],
      },
      80,
    );
    expect(row).toContain("task ≈ 900–2,400 cr · covered");
    expect(visibleLength(row)).toBeLessThanOrEqual(80);
  });

  it("says nothing is locked when nothing is", () => {
    expect(lockedPhrasings(undefined)).toEqual([]);
    expect(lockedPhrasings({ ...usable, locked: 0 })).toEqual([]);
    expect(lockedPhrasings({ kind: "budget", credits: 0, locked: 500, afterReset: 0 })).toEqual(["500 bonus locked"]);
  });
});

describe("/wallet", () => {
  it("says what can be spent on each kind of model, and when the rest comes back", () => {
    expect(walletUsableLines(33_396, { budget: 0, premium: 0, budgetAfterReset: 33_396 })).toEqual([
      "usable now: 0 credits on budget models, 0 on premium models",
      "33,396 bonus credits are over today's limit and become usable at 00:00 UTC",
    ]);
    expect(walletUsableLines(55_358, { budget: 37, premium: 37, budgetAfterReset: 40_037 })[1]).toBe(
      "55,321 bonus credits are over today's limit: 40,000 become usable at 00:00 UTC, the rest on later days",
    );
    // Only premium held back: one line, nothing about a reset that does not apply.
    expect(walletUsableLines(25_000, { budget: 25_000, premium: 0, budgetAfterReset: 25_000 })).toEqual([
      "usable now: 25,000 credits on budget models, 0 on premium models",
    ]);
    expect(walletUsableLines(25_000, { budget: 25_000, premium: 25_000, budgetAfterReset: 25_000 })).toEqual([]);
  });

  it("prints them, and the status line takes the same figures", async () => {
    const script: Script = {
      wallet: wallet(33_396, { budget: 0, premium: 0, budgetAfterReset: 33_396 }),
      turns: [{}],
      walletReads: [],
    };
    const view = open(BUDGET, script);
    await tick(100);
    view.stdin.write("/wallet");
    await tick();
    view.stdin.write("\r");
    await tick(200);
    const out = strip(view.lastFrame() ?? "");
    expect(out).toContain("usable now: 0 credits on budget models, 0 on premium models");
    expect(out).toContain("33,396 bonus credits are over today's limit and become usable at 00:00 UTC");
    expect(script.walletReads).toContainEqual({ premium: true });
  });
});
