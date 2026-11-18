/**
 * How long a turn may run on its own (`steps.ts`), and what the REPL says when
 * it stops one.
 *
 * The report behind it: medium tasks stopped part way with "ask me to
 * continue", because a turn was capped at 16 model calls. The cap is now high
 * enough for real work and set with `/steps`, a stuck agent is stopped by the
 * repeat guard long before it, and either stop says why, what the turn cost and
 * how to carry on.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";
import {
  DEFAULT_MAX_STEPS,
  earlyStopLines,
  MAX_MAX_STEPS,
  maxStepsOf,
  MIN_MAX_STEPS,
  parseStepsArg,
  REPEAT_LIMIT,
  stepsSummary,
} from "../src/steps.ts";

describe("the step limit setting", () => {
  it("is the default unless a valid number was saved", () => {
    expect(maxStepsOf({})).toBe(DEFAULT_MAX_STEPS);
    expect(maxStepsOf({ maxSteps: 250 })).toBe(250);
    for (const bad of [0, 3, MIN_MAX_STEPS - 1, MAX_MAX_STEPS + 1, 12.5, Number.NaN]) {
      expect(maxStepsOf({ maxSteps: bad })).toBe(DEFAULT_MAX_STEPS);
    }
  });

  it("is high enough for the task that used to stop at 16", () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(5 * 16);
    expect(MAX_MAX_STEPS).toBeLessThanOrEqual(1000);
  });

  it("reads /steps arguments, and refuses what would remove the bound", () => {
    expect(parseStepsArg("150")).toEqual({ steps: 150 });
    expect(parseStepsArg(" default ")).toEqual({ reset: true });
    expect(parseStepsArg(String(MIN_MAX_STEPS))).toEqual({ steps: MIN_MAX_STEPS });
    expect(parseStepsArg(String(MAX_MAX_STEPS))).toEqual({ steps: MAX_MAX_STEPS });
    expect(parseStepsArg("9")).toHaveProperty("error");
    expect(parseStepsArg("100000")).toHaveProperty("error");
    expect(parseStepsArg("unlimited")).toHaveProperty("error");
    expect(parseStepsArg("-5")).toHaveProperty("error");
  });

  it("says why it stopped and how to go on, in the REPL and after -p", () => {
    const limit = earlyStopLines("max_steps", { steps: 100, limit: 100, repl: true }).join("\n");
    expect(limit).toContain("Stopped after 100 model calls");
    expect(limit).toContain('Type "continue"');
    expect(limit).toContain("/steps (now 100)");
    const circles = earlyStopLines("repeating", { steps: 4, limit: 100, repl: true }).join("\n");
    expect(circles).toContain(`${REPEAT_LIMIT} times in a row`);
    expect(circles).toContain("going in circles");
    // A -p run keeps no session, so it is never told to type "continue".
    const headless = earlyStopLines("max_steps", { steps: 100, limit: 100, repl: false }).join("\n");
    expect(headless).not.toContain("continue");
    expect(headless).toContain("/steps in the REPL");
  });

  it("summarises the setting", () => {
    expect(stepsSummary({})).toContain(`up to ${DEFAULT_MAX_STEPS} model calls (the default)`);
    expect(stepsSummary({ maxSteps: 200 })).toContain("up to 200 model calls before");
  });
});

const wallet: WalletInfo = {
  balance: 25_000,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 41_000,
  ledger: [],
};

/** A model that never finishes: a different search every round, or the same one when `same`. */
function endlessClient(same = false): GatewayClient & { calls: number } {
  const client = {
    calls: 0,
    models: async () => [{ id: "kimi-k2.5", tier: "cheap", access: "budget", est_ads_per_task: 0.4, free: false }],
    wallet: async () => wallet,
    claimStreak: async () => null,
    handoffCode: async () => "hoff_1",
    async chatStream(_messages: unknown, _model: string, _opts: ChatOptions): Promise<ChatTurn> {
      const n = ++client.calls;
      const pattern = same ? "nothing-*" : `nothing-${n}-*`;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `c${n}`, type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern }) } }],
        },
        finishReason: "tool_calls",
        creditsCharged: 7,
        balance: wallet.balance - 7 * n,
      };
    },
  };
  return client as unknown as GatewayClient & { calls: number };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const everything = (view: ReturnType<typeof render>) => strip(view.frames.join("\n"));

async function send(view: ReturnType<typeof render>, text: string, wait = 200) {
  view.stdin.write(text);
  await tick();
  view.stdin.write("\r");
  await tick(wait);
}

const baseConfig = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "kimi-k2.5",
});

describe("/steps and the stop notice in the REPL", () => {
  it("shows the limit, changes it, and a turn stops at the new one with the reason and the cost", async () => {
    const config = baseConfig();
    const client = endlessClient();
    const view = render(<App client={client} config={config} wallet={wallet} />);
    await tick(100);

    await send(view, "/steps");
    expect(everything(view)).toContain(`up to ${DEFAULT_MAX_STEPS} model calls (the default)`);

    await send(view, "/steps 5");
    expect(everything(view)).toContain(`5 is below the lowest limit, ${MIN_MAX_STEPS}`);
    expect(config.maxSteps).toBeUndefined();

    await send(view, "/steps 12");
    expect(config.maxSteps).toBe(12);
    expect(everything(view)).toContain("A task may now make up to 12 model calls before it stops.");

    await send(view, "keep looking", 800);
    expect(client.calls).toBe(12);
    const out = everything(view);
    expect(out).toContain("Stopped after 12 model calls, this turn's limit");
    expect(out).toContain('Type "continue" to carry on, or raise the limit with /steps (now 12).');
    // What the turn cost, said with the stop.
    expect(out).toContain("[84 credits · balance 24,916]");
    expect(out).not.toContain("ask me to continue");

    await send(view, "/steps default");
    expect(config.maxSteps).toBeUndefined();
    view.unmount();
  });

  it("stops a turn that goes in circles and says so", async () => {
    const client = endlessClient(true);
    const view = render(<App client={client} config={baseConfig()} wallet={wallet} />);
    await tick(100);
    await send(view, "keep looking", 500);
    expect(client.calls).toBe(REPEAT_LIMIT);
    expect(everything(view)).toContain("going in circles");
    view.unmount();
  });
});
