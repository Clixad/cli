/**
 * The account's name and instructions reach the model from the
 * REPL: `main.ts` hands them to `App` as `preferences`, and every turn's system
 * prompt carries them after the permission mode.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};
const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};
const catalog = [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function client() {
  const systemPrompts: string[] = [];
  const c = {
    models: async () => catalog,
    wallet: async () => wallet,
    async chatStream(m: ChatMessage[]): Promise<ChatTurn> {
      systemPrompts.push(String(m[0]?.content ?? ""));
      return { message: { role: "assistant", content: "Hallo." }, finishReason: "stop", creditsCharged: 3, balance: 4985 };
    },
  } as unknown as GatewayClient;
  return { c, systemPrompts };
}

describe("the account's preferences in a turn", () => {
  it("carries the name and the instructions into the system prompt", async () => {
    const { c, systemPrompts } = client();
    const preferences = { name: "Flo", instructions: "Answer in German.", sponsorLine: null };
    const { stdin } = render(<App client={c} config={config} wallet={wallet} preferences={preferences} />);
    await tick();
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick(250);
    expect(systemPrompts[0]).toContain("The person's name is Flo.");
    expect(systemPrompts[0]).toContain("What the person wants you to keep in mind in every answer:\nAnswer in German.");
  });

  it("says nothing of them when the account has none", async () => {
    const { c, systemPrompts } = client();
    const { stdin } = render(<App client={c} config={config} wallet={wallet} />);
    await tick();
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick(250);
    expect(systemPrompts[0]).not.toContain("The person's name is");
  });
});
