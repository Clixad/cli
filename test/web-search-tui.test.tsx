/**
 * What a web search costs, as the REPL says it (2026-11-01).
 *
 * The report: web search costs credits on free models too, and the CLI never
 * said so; the user found out on the website. A search is paid from the
 * balance on every model, so the REPL now says it before the first one (when
 * it opens on a free model, or else at the first search) and at each one: the
 * row names the charge, the balance on the status line moves with it, and the
 * meta line under the turn counts it apart from the model calls.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatOptions, ChatTurn, GatewayClient, ModelInfo, WalletInfo, WebSearchOutcome } from "../src/client.ts";

const FREE = "deepseek-v4-flash";
const PAID = "kimi-k2.5";

const config = (model: string): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
});

const wallet = (balance: number): WalletInfo => ({
  balance,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 40_800,
  free_tier: {
    models: [FREE],
    daily_credits: 60_000,
    credits_left: 60_000,
    turns_left: { [FREE]: 124 },
    recommended: FREE,
  },
  ledger: [],
});

const row = (id: string, free: boolean): ModelInfo => ({
  id,
  label: id,
  provider: "x",
  tier: "cheap",
  ad_fundable: true,
  credits_per_mtoken_input: 21_000,
  credits_per_mtoken_output: 42_000,
  est_credits_per_task: 0,
  est_ads_per_task: 0.1,
  free,
  access: "budget",
});

const searchCall = (id: string, query: string): Partial<ChatTurn> => ({
  message: {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } }],
  },
  finishReason: "tool_calls",
});

function stubClient(o: {
  wallet: WalletInfo;
  turns: Partial<ChatTurn>[];
  searches: WebSearchOutcome[];
}): GatewayClient {
  let turn = 0;
  let search = 0;
  // The wallet a read finds follows the charges, as the gateway's does.
  let balance = o.wallet.balance;
  return {
    models: async () => [row(FREE, true), row(PAID, false)],
    wallet: async () => ({ ...o.wallet, balance }),
    claimStreak: async () => null,
    get capabilities() {
      return { web_search: true };
    },
    get webSearchCredits() {
      return 1_050;
    },
    retiredModels: {},
    webSearch: async () => {
      const out = o.searches[Math.min(search++, o.searches.length - 1)]!;
      if (out.balance !== undefined) balance = out.balance;
      return out;
    },
    async chatStream(_messages: unknown, _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const next = o.turns[Math.min(turn++, o.turns.length - 1)]!;
      if (!next.message?.tool_calls) opts.onDelta?.("done");
      if (next.balance !== undefined) balance = next.balance;
      return {
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        creditsCharged: 0,
        balance,
        ...next,
      };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const statusRow = (frame: string) => frame.split("\n").findLast((l) => l.includes("ask before edits")) ?? "";

async function send(view: ReturnType<typeof render>, text: string) {
  view.stdin.write(text);
  await tick();
  view.stdin.write("\r");
  await tick(250);
}

describe("a web search on a free model", () => {
  it("is said to be paid when the REPL opens, and its charge is on the row, the status line and the meta line", async () => {
    const w = wallet(4_988);
    const client = stubClient({
      wallet: w,
      turns: [
        searchCall("t1", "vitest fake timers"),
        { free: true, creditsWaived: 410, freeCreditsLeft: 59_590, balance: 3_919 },
      ],
      searches: [{ results: [], creditsCharged: 1_069, balance: 3_919, cached: false }],
    });
    const view = render(<App client={client} config={config(FREE)} wallet={w} />);
    await tick(100);
    expect(strip(view.lastFrame()!)).toContain(
      "Web searches are not free: about 1,050 credits each, from your balance, also on a free model.",
    );

    await send(view, "how do fake timers work in vitest");
    const frame = strip(view.lastFrame()!);
    expect(frame).toContain('Web Search("vitest fake timers")');
    expect(frame).toContain("⎿  No results · 1,069 credits");
    expect(frame).toContain("[free · 410 credits waived · 59,590 free credits left · web search 1,069 credits · balance 3,919]");
    // The balance and the session's spend moved for a turn whose model calls were free.
    expect(statusRow(frame)).toContain("3,919 cr");
    expect(statusRow(frame)).toContain("−1,069");
    // Said once: the first search does not say it again after the REPL did.
    expect(frame.split("Web searches are not free").length - 1).toBe(1);
    view.unmount();
  });
});

describe("a web search on a paid model", () => {
  it("is said to cost credits at the first search of the session, once, and a cached answer is free", async () => {
    const w = { ...wallet(9_000), free_tier: undefined };
    const client = stubClient({
      wallet: w,
      turns: [searchCall("t1", "first"), { creditsCharged: 300, balance: 7_631 }, searchCall("t2", "first"), { creditsCharged: 300, balance: 7_331 }],
      searches: [
        { results: [], creditsCharged: 1_069, balance: 7_931, cached: false },
        { results: [], cached: true },
      ],
    });
    const view = render(<App client={client} config={config(PAID)} wallet={w} />);
    await tick(100);
    expect(strip(view.lastFrame()!)).not.toContain("Web searches");

    await send(view, "look something up");
    let frame = strip(view.lastFrame()!);
    expect(frame).toContain("Web searches cost about 1,050 credits each from your balance, on top of the model's tokens.");
    expect(frame).toContain('Web Search("first")');
    expect(frame).toContain("⎿  No results · 1,069 credits");
    expect(frame).toContain("[300 credits · web search 1,069 credits · balance 7,631]");

    await send(view, "and again");
    frame = strip(view.lastFrame()!);
    expect(frame).toContain("⎿  No results · cached, no charge");
    expect(frame).toContain("[300 credits · balance 7,331]");
    expect(frame.split("Web searches cost").length - 1).toBe(1);
    view.unmount();
  });
});
