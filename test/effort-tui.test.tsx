/**
 * `/effort` in the REPL: the picker offers what the current model takes, a
 * typed level the model lacks moves to the nearest one below and says so, the
 * status line shows the setting, and a turn sends the setting saved for the
 * model it runs on and for no other.
 */
import React from "react"; // classic JSX transform needs React in scope (see src/tui/app.tsx)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import { messageText, type ChatMessage, type ChatOptions, type ChatTurn, type GatewayClient, type WalletInfo } from "../src/client.ts";

const wallet: WalletInfo = {
  balance: 50_000,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 51_000,
  ledger: [],
};

const catalog = [
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", tier: "mid", est_ads_per_task: 2, efforts: [], default_effort: "on" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", tier: "mid", est_ads_per_task: 4, efforts: ["off", "low", "medium", "high", "xhigh", "max"], default_effort: "medium" },
  { id: "kimi-k3", label: "Kimi K3", tier: "premium", est_ads_per_task: 6, efforts: ["off", "low", "high", "max"], default_effort: "max" },
];

function stubClient(models: unknown[] = catalog) {
  const sent: { model: string; effort?: string }[] = [];
  const client = {
    models: async () => models,
    wallet: async () => wallet,
    claimStreak: async () => null,
    async chatStream(m: ChatMessage[], model: string, opts: ChatOptions): Promise<ChatTurn> {
      sent.push({ model, ...(opts.effort ? { effort: opts.effort } : {}) });
      const message: ChatMessage = { role: "assistant", content: "done" };
      opts.onDelta?.(messageText(message));
      void m;
      return { message, finishReason: "stop", creditsCharged: 7, balance: 49_993 };
    },
  } as unknown as GatewayClient;
  return { client, sent };
}

const config = (model: string): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model,
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ARROW_DOWN = "\x1b[B";

// `saveEffort` merges what is on disk, which is how two sessions keep each
// other's settings, so a setting one test saved would reach the next. The
// suite's HOME is a temp directory (`test/setup-home.ts`); only the map is cleared.
beforeEach(() => {
  const file = join(homedir(), ".clixad", "config.json");
  if (!existsSync(file)) return;
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete stored.effort;
  writeFileSync(file, JSON.stringify(stored), "utf8");
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

async function open(model: string, models?: unknown[]) {
  const { client, sent } = stubClient(models);
  const cfg = config(model);
  const r = render(<App client={client} config={cfg} wallet={wallet} />);
  unmount = r.unmount;
  await tick(80);
  const type = async (text: string, wait = 120) => {
    r.stdin.write(text);
    await tick();
    r.stdin.write("\r");
    await tick(wait);
  };
  return { ...r, cfg, sent, type, frame: () => strip(r.lastFrame() ?? "") };
}

describe("/effort", () => {
  it("offers the current model's levels, marks auto, and saves the pick for that model", async () => {
    const { stdin, frame, cfg, type } = await open("kimi-k3");
    await type("/effort");
    const picker = frame();
    expect(picker).toContain("Effort for Kimi K3");
    expect(picker).toContain("auto");
    expect(picker).toContain("the model's default (max effort)");
    expect(picker).toContain("less thinking, fewer credits");
    expect(picker).not.toContain("xhigh"); // Kimi K3 has no xhigh
    expect(picker).toContain("← current");

    stdin.write(ARROW_DOWN); // off
    stdin.write(ARROW_DOWN); // low
    await tick();
    stdin.write("\r");
    await tick(80);
    const after = frame();
    expect(after).toContain("Kimi K3: low effort");
    expect(after).toContain("kimi-k3 · low effort"); // the status line, beside the model
    expect(cfg.effort).toEqual(expect.objectContaining({ "kimi-k3": "low" }));
  });

  it("moves a typed level the model lacks to the nearest one below, and says so", async () => {
    const { frame, cfg, type } = await open("kimi-k3");
    await type("/effort xhigh");
    expect(frame()).toContain("Kimi K3: high effort. It has no xhigh, so this is the nearest below");
    expect(cfg.effort?.["kimi-k3"]).toBe("high");
  });

  it("goes back to the model's default with auto", async () => {
    const { frame, cfg, type } = await open("gpt-6-sol");
    await type("/effort max");
    expect(cfg.effort?.["gpt-6-sol"]).toBe("max");
    await type("/effort auto");
    expect(frame()).toContain("GPT-6 Sol: auto (medium effort)");
    expect(cfg.effort?.["gpt-6-sol"]).toBeUndefined();
    expect(frame()).not.toContain("gpt-6-sol · max effort");
  });

  it("says so for a model with nothing to set, and opens no picker", async () => {
    const { frame, type } = await open("kimi-k2.7-code");
    await type("/effort");
    expect(frame()).toContain("Kimi K2.7 Code always thinks before it answers, and has no setting for how long");
    expect(frame()).not.toContain("Effort for");
  });

  it("says so on a gateway too old to send settings", async () => {
    const old = catalog.map(({ efforts: _e, default_effort: _d, ...rest }) => rest);
    const { frame, type } = await open("kimi-k3", old);
    await type("/effort");
    expect(frame()).toContain("this gateway does not offer effort settings");
  });

  it("refuses a word that is not a level, listing what the model takes", async () => {
    const { frame, type } = await open("kimi-k3");
    await type("/effort turbo");
    expect(frame()).toContain("unknown effort: turbo. Kimi K3 takes auto, off, low, high, max");
  });

  it("sends the setting with a turn, and only for the model it was saved for", async () => {
    const { stdin, sent, type, frame } = await open("gpt-6-sol");
    await type("/effort low");
    await type("hello", 200);
    expect(sent.at(-1)).toEqual({ model: "gpt-6-sol", effort: "low" });

    // Another model has its own setting, and here that is none: a `low` chosen
    // to save credits on one model is not carried to the next.
    await type("/model");
    stdin.write(ARROW_DOWN); // the picker opens on gpt-6-sol; one down is kimi-k3
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(frame()).toContain("model → kimi-k3");
    expect(frame()).not.toContain("kimi-k3 · low effort"); // the status line, not the earlier notice
    await type("hello again", 200);
    expect(sent.at(-1)).toEqual({ model: "kimi-k3" });
  });
});
