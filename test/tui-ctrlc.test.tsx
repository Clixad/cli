/**
 * Ctrl+C while a modal owns the keyboard.
 *
 * Every one of these dialogs is a promise a turn is awaiting — the permission
 * gate, an `exit_plan_mode` approval, an `ask_user` question — and aborting the
 * signal resolves none of them. Ctrl+C used to only abort, so with a dialog up
 * it did nothing at all: the dialog stayed, the loop stayed inside `await`, and
 * the one key everybody reaches for was inert at the one moment `busy` is most
 * likely to be true. It now answers the gate first and stops second, which is
 * what esc has always done.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787", dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test", model: "gemini-2.5-flash-lite",
};
function stub(calls: { seen: number }): GatewayClient {
  return {
    models: async () => [],
    wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(_m: ChatMessage[], _mo: string, _o: ChatOptions): Promise<ChatTurn> {
      calls.seen++;
      if (calls.seen === 1)
        return {
          message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "nope.txt", content: "x" }) } }] },
          finishReason: "tool_calls", creditsCharged: 1, balance: 1,
        };
      return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
    },
  } as unknown as GatewayClient;
}
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const CTRL_C = "\x03";

describe("ctrl+c while a permission dialog is open", () => {
  it("answers the gate, stops the turn, and writes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "audit-ctrlc-"));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const calls = { seen: 0 };
      const { stdin, lastFrame, unmount } = render(<App client={stub(calls)} config={{ ...config }} />);
      await tick(300);
      stdin.write("write a file"); await tick(150); stdin.write("\r"); await tick(700);
      expect(/nope\.txt/.test(strip(lastFrame() ?? ""))).toBe(true); // dialog is up
      stdin.write(CTRL_C); await tick(800);
      const after = strip(lastFrame() ?? "");
      console.log("dialog gone:", !/\[n\] no/.test(after), "| said (stopped):", /\(stopped\)/.test(after), "| model calls:", calls.seen, "| file written:", existsSync(join(root, "nope.txt")));
      unmount();
      expect(/\[n\] no/.test(after)).toBe(false);   // the dialog is settled
      expect(/\(stopped\)/.test(after)).toBe(true); // the turn actually stopped
      expect(calls.seen).toBe(1);                    // no further paid round-trip
      expect(existsSync(join(root, "nope.txt"))).toBe(false);
    } finally { process.chdir(cwd); }
  });

  it("settles a plan awaiting approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "audit-ctrlc-plan-"));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const calls = { seen: 0 };
      const client = {
        models: async () => [],
        wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
        async chatStream(): Promise<ChatTurn> {
          calls.seen++;
          if (calls.seen === 1)
            return {
              message: { role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "exit_plan_mode", arguments: JSON.stringify({ plan: "step one, then step two" }) } }] },
              finishReason: "tool_calls", creditsCharged: 1, balance: 1,
            };
          return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
        },
      } as unknown as GatewayClient;
      const { stdin, lastFrame, unmount } = render(<App client={client} config={{ ...config }} />);
      await tick(300);
      stdin.write("\x1b[Z"); await tick(120); // shift+tab → acceptEdits
      stdin.write("\x1b[Z"); await tick(120); // shift+tab → plan
      stdin.write("plan something"); await tick(150); stdin.write("\r"); await tick(700);
      expect(/step one, then step two/.test(strip(lastFrame() ?? ""))).toBe(true);
      stdin.write(CTRL_C); await tick(800);
      const after = strip(lastFrame() ?? "");
      console.log("plan gone:", !/step one, then step two/.test(after), "| stopped:", /\(stopped\)/.test(after));
      unmount();
      expect(/step one, then step two/.test(after)).toBe(false);
      expect(/\(stopped\)/.test(after)).toBe(true);
    } finally { process.chdir(cwd); }
  });

  it("settles an ask_user question", async () => {
    const root = mkdtempSync(join(tmpdir(), "audit-ctrlc-ask-"));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const calls = { seen: 0 };
      const client = {
        models: async () => [],
        wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
        async chatStream(): Promise<ChatTurn> {
          calls.seen++;
          if (calls.seen === 1)
            return {
              message: { role: "assistant", content: null, tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "postgres or sqlite?", options: ["postgres", "sqlite"] }) } }] },
              finishReason: "tool_calls", creditsCharged: 1, balance: 1,
            };
          return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
        },
      } as unknown as GatewayClient;
      const { stdin, lastFrame, unmount } = render(<App client={client} config={{ ...config }} />);
      await tick(300);
      stdin.write("which database"); await tick(150); stdin.write("\r"); await tick(700);
      expect(/postgres or sqlite/.test(strip(lastFrame() ?? ""))).toBe(true);
      stdin.write(CTRL_C); await tick(800);
      const after = strip(lastFrame() ?? "");
      console.log(
        "picker gone:", !/waiting for your answer/.test(after),
        "| model told:", /dismissed the question/.test(after),
        "| stopped:", /\(stopped\)/.test(after),
        "| calls:", calls.seen,
      );
      unmount();
      // The picker itself is gone — the question still appears above it, as the
      // committed `ask_user` tool entry, which is the transcript doing its job.
      expect(/waiting for your answer/.test(after)).toBe(false);
      // And the tool was answered rather than left hanging.
      expect(/dismissed the question/.test(after)).toBe(true);
      expect(/\(stopped\)/.test(after)).toBe(true);
      expect(calls.seen).toBe(1);
    } finally { process.chdir(cwd); }
  });
});
