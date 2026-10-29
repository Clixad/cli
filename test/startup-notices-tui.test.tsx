/**
 * Two things the REPL says when it opens, both learned from the catalog fetch.
 *
 * A retired model id is switched to its successor and said out loud, so the
 * status line stops showing an id that no longer exists. And a newer published
 * CLI is named once, because `npm install -g` pins the version of the day it
 * ran and an installed CLI otherwise never hears about a release.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { GatewayClient, WalletInfo } from "../src/client.ts";
import { VERSION } from "../src/version.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const wallet: WalletInfo = {
  balance: 25_000,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 51_000,
  ledger: [],
};

function client(opts: { latest?: string; retired?: Record<string, string> }): GatewayClient {
  return {
    models: async () => [
      { id: "claude-opus-5.5", label: "Claude Opus 5.5", tier: "premium", est_ads_per_task: 5, free: false },
      { id: "gpt-5-nano", label: "GPT-5 Nano", tier: "cheap", est_ads_per_task: 0.1, free: true },
    ],
    get latestCli() {
      return opts.latest;
    },
    get retiredModels() {
      return opts.retired ?? {};
    },
    wallet: async () => wallet,
    claimStreak: async () => null,
  } as unknown as GatewayClient;
}

const config = (model: string): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "ada",
  model,
});

describe("what the REPL says when it opens", () => {
  it("moves a retired model to its successor, and says so", async () => {
    const cfg = config("claude-opus-5");
    const { lastFrame } = render(
      <App client={client({ retired: { "claude-opus-5": "claude-opus-5.5" } })} config={cfg} wallet={wallet} />,
    );
    await tick();
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("claude-opus-5 was retired; now using its successor, claude-opus-5.5.");
    expect(out).toContain("claude-opus-5.5 ·");
    expect(cfg.model).toBe("claude-opus-5.5");
  });

  it("leaves a live model alone", async () => {
    const cfg = config("gpt-5-nano");
    const { lastFrame } = render(
      <App client={client({ retired: { "claude-opus-5": "claude-opus-5.5" } })} config={cfg} wallet={wallet} />,
    );
    await tick();
    expect(strip(lastFrame() ?? "")).not.toContain("was retired");
    expect(cfg.model).toBe("gpt-5-nano");
  });

  it("names a newer release once, and says nothing when there is none", async () => {
    const newer = render(<App client={client({ latest: "999.0.0" })} config={config("gpt-5-nano")} wallet={wallet} />);
    await tick();
    expect(strip(newer.lastFrame() ?? "")).toContain(`clixad 999.0.0 is out (you have ${VERSION})`);

    const same = render(<App client={client({ latest: VERSION })} config={config("gpt-5-nano")} wallet={wallet} />);
    await tick();
    expect(strip(same.lastFrame() ?? "")).not.toContain("is out");
  });
});
