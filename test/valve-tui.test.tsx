/**
 * The limit valve in the REPL: at the limit, two keystrokes carry the
 * interrupted task on to the user's own OpenRouter key, without it being typed
 * again, without a call to the gateway for it, and with the meta line saying
 * that no Clixad credits were used.
 */
import React from "react"; // classic JSX transform needs React in scope
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import { PaywallError } from "../src/client.ts";
import { loadConfig, saveConfig, type CliConfig } from "../src/config.ts";
import type { ChatMessage, GatewayClient, WalletInfo } from "../src/client.ts";
import { frameIn } from "./helpers/wait.ts";

// A switch is saved to config.json, which every test in this worker shares:
// take it back after each, so no later test starts on somebody's own key.
afterEach(() => {
  vi.unstubAllGlobals();
  const c = loadConfig();
  c.direct = undefined;
  c.ownKey = undefined;
  saveConfig(c);
});

/** A signed-in config on the paid model, with nothing of the valve set unless a test sets it. */
const fresh = (extra: Partial<CliConfig> = {}): CliConfig => ({ ...loadConfig(), model: PAID, token: "adg_test", direct: undefined, ownKey: undefined, ...extra });

const PAID = "claude-opus-5.5";
const TASK = "rename the upload handler";
const KEY = "sk-or-test-key-for-the-suite-only";

const wallet = {
  balance: 12,
  ads_today: 0,
  grant_per_ad: 51_000,
  est_ads_per_task: {},
  daily_cap_usd: 5,
  earned_today_usd: 0,
} as unknown as WalletInfo;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function gateway(calls: string[], reports: unknown[]): GatewayClient {
  return {
    models: async () => [{ id: PAID, tier: "premium", est_ads_per_task: 18, free: false, openrouter_slug: "anthropic/claude-opus-5.5", context_window: 200_000 }],
    wallet: async () => wallet,
    claimStreak: async () => null,
    reportExternal: async (...args: unknown[]) => void reports.push(args),
    async chatStream(messages: ChatMessage[]) {
      const last = messages[messages.length - 1];
      calls.push(typeof last?.content === "string" ? last.content : "");
      throw new PaywallError(12, 1190, 51_000, [], null, null, null);
    },
  } as unknown as GatewayClient;
}

function openRouter(asked: { url: string; auth?: string; body: Record<string, unknown> }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      asked.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).Authorization,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const frames = [
        { choices: [{ delta: { content: "Renamed it on your key." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1_200, completion_tokens: 34 } },
      ];
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
    }),
  );
}

describe("the limit valve", () => {
  it("carries the interrupted task on to the user's own key in two keystrokes", async () => {
    const calls: string[] = [];
    const reports: unknown[] = [];
    const asked: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
    openRouter(asked);
    const config = fresh({ ownKey: KEY });
    const view = render(<App client={gateway(calls, reports)} config={config} wallet={wallet} localProbe={async () => []} />);
    await tick();
    view.stdin.write(TASK);
    await tick();
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["No credits needed either: carry on with your own OpenRouter key"] });

    view.stdin.write("\r"); // 1: the chooser
    await frameIn(view.lastFrame, { has: ["your OpenRouter key", "earn credits instead"] });
    view.stdin.write("\r"); // 2: its first row
    await frameIn(view.lastFrame, { has: ["Renamed it on your key.", "no Clixad credits"] });

    const out = strip(view.lastFrame() ?? "");
    expect(out).toContain("now on your OpenRouter key: anthropic/claude-opus-5.5");
    expect(out).toContain("[your OpenRouter key · 1,234 tokens · no Clixad credits]");
    // The same task, not retyped, sent once to the gateway (refused) and then to OpenRouter.
    expect(calls).toEqual([TASK]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(asked[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(asked[0]!.body.model).toBe("anthropic/claude-opus-5.5");
    const sent = asked[0]!.body.messages as ChatMessage[];
    expect(sent[sent.length - 1]!.content).toBe(TASK);
    // No web search on a turn the gateway is not part of.
    expect(JSON.stringify(asked[0]!.body.tools ?? [])).not.toContain("web_search");
    await vi.waitFor(() => expect(reports).toEqual([["own_key", "anthropic/claude-opus-5.5", { calls: 1, inputTokens: 1_200, outputTokens: 34 }]]));
    // And it is kept for the next start, without the key in it twice.
    expect(config.direct).toMatchObject({ kind: "own_key", model: "anthropic/claude-opus-5.5" });
    expect(JSON.stringify(config.direct)).not.toContain(KEY);
  });

  it("says how to carry on without credits when there is no key and no local server", async () => {
    const calls: string[] = [];
    const config = fresh();
    const view = render(<App client={gateway(calls, [])} config={config} wallet={wallet} localProbe={async () => []} />);
    await tick();
    view.stdin.write(TASK);
    await tick();
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["/key <your OpenRouter key>"] });
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["own key or local"] });
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["/local picks one of its models"] });
    expect(strip(view.lastFrame() ?? "")).toContain("/key sk-or-… saves it");
  });

  it("offers the local models that answered, and runs the task there", async () => {
    const calls: string[] = [];
    const asked: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
    openRouter(asked);
    const config = fresh();
    const probe = async () => [{ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen2.5-coder:7b"] }];
    const view = render(<App client={gateway(calls, [])} config={config} wallet={wallet} localProbe={probe} />);
    await tick();
    view.stdin.write(TASK);
    await tick();
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["Press enter to choose"] });
    await tick(50);
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["local: qwen2.5-cod", "earn credits instead"] });
    view.stdin.write("\r");
    await frameIn(view.lastFrame, { has: ["Renamed it on your key.", "[local model"] });
    expect(asked[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(asked[0]!.auth).toBeUndefined();
    expect(calls).toEqual([TASK]);
  });
});
