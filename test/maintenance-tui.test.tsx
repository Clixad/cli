/**
 * The maintenance refusal in the REPL: the gateway's one sentence, alone.
 *
 * Every other failure of a turn is printed as `error: …`. This one is not an
 * error on this side (the agent is switched off on the gateway, and nothing
 * was charged), so it is printed as the sentence and nothing else, and the
 * REPL stays usable for the next message.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { MaintenanceError } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const MESSAGE = "Clixad is currently down due to high demand. Please check again later.";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "kimi-k2.5",
};

const wallet: WalletInfo = {
  balance: 25_000,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 41_000,
  ledger: [],
};

/** A gateway whose turns end with each of `turns` in order, the last one repeating. */
function stubClient(turns: (Error | "ok")[]): GatewayClient {
  let n = 0;
  return {
    models: async () => [{ id: "kimi-k2.5", tier: "cheap", access: "budget", est_ads_per_task: 0.4, free: false }],
    wallet: async () => wallet,
    claimStreak: async () => null,
    handoffCode: async () => "hoff_1",
    async chatStream(_messages: unknown, _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const next = turns[Math.min(n++, turns.length - 1)]!;
      if (next instanceof Error) throw next;
      opts.onDelta?.("all good");
      return {
        message: { role: "assistant", content: "all good" },
        finishReason: "stop",
        creditsCharged: 12,
        balance: wallet.balance - 12,
      };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function send(view: ReturnType<typeof render>, text: string) {
  view.stdin.write(text);
  await tick();
  view.stdin.write("\r");
  await tick(200);
}

describe("a turn the gateway refuses for maintenance", () => {
  it("prints the sentence alone, and the next turn runs once the gateway is back", async () => {
    const view = render(
      <App client={stubClient([new MaintenanceError(MESSAGE), "ok"])} config={config} wallet={wallet} />,
    );
    await tick(100);
    await send(view, "rename the upload handler");
    const out = strip(view.lastFrame() ?? "");
    expect(out).toContain(MESSAGE);
    expect(out).not.toContain(`error: ${MESSAGE}`);

    await send(view, "rename the upload handler");
    expect(strip(view.lastFrame() ?? "")).toContain("all good");
  });
});
