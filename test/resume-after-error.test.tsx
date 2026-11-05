/**
 * Work done before a server error can be resumed, through the real REPL.
 *
 * The report: a task ran for a while, the gateway started refusing every call,
 * the user quit, came back to the same directory, and `/resume` answered "no
 * saved sessions in this directory yet". The session was written only when a
 * turn returned, and a turn that threw took its conversation with it, so a
 * first task cut off by an error left nothing on disk while its edits were.
 *
 * Each case runs in a directory of its own with no CLIXAD.md in it, which is
 * the other half of the report: whether a project has one plays no part in
 * whether its sessions are saved.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App, KEPT_AFTER_ERROR } from "../src/tui/app.tsx";
import { latestSession, listSessions, loadSession } from "../src/session.ts";
import type { CliConfig } from "../src/config.ts";
import {
  MaintenanceError,
  PaywallError,
  type ChatMessage,
  type ChatOptions,
  type ChatTurn,
  type GatewayClient,
} from "../src/client.ts";
import { frameIn, frameWith, waitFor } from "./helpers/wait.ts";

const config = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
});

const DOWN = "Clixad is currently down due to high demand. Please check again later.";
const TASK = "rename the helper and update its callers";
/** The notice in one line, the way `frameIn` folds a wrapped one. */
const KEPT = KEPT_AFTER_ERROR.replace(/\s+/g, " ").trim();

type Step = "read" | "list" | "answer" | "hang" | Error;

/** A gateway that works through `steps`, one per model call, and records what it was sent. */
function gateway(steps: Step[]) {
  const sent: ChatMessage[][] = [];
  let i = 0;
  const client = {
    models: async () => [],
    wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      const step = steps[i++] ?? "answer";
      if (step instanceof Error) throw step;
      if (step === "hang") {
        return new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }
      if (step === "answer") {
        return { message: { role: "assistant", content: "ANSWERED" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
      }
      const [name, args] = step === "read" ? ["read_file", { path: "a.txt" }] : ["list_dir", {}];
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finishReason: "tool_calls",
        creditsCharged: 1,
        balance: 1,
      };
    },
  } as unknown as GatewayClient;
  return { client, sent };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function submit(stdin: { write(s: string): void }, line: string) {
  stdin.write(line);
  await tick();
  stdin.write("\r");
}

let cwd: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "clixad-resume-error-")));
  // Read back: on macOS the temp directory resolves through /private, and the
  // REPL files a session under what `process.cwd()` says.
  cwd = process.cwd();
  writeFileSync(join(cwd, "a.txt"), "alpha\n");
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("a task cut off by a server error", () => {
  for (const [name, error] of [
    ["the maintenance refusal", () => new MaintenanceError(DOWN)],
    ["any other gateway error", () => new Error("chat failed: 500")],
  ] as const) {
    it(`is saved and can be resumed after a restart (${name})`, async () => {
      expect(existsSync(join(cwd, "CLIXAD.md"))).toBe(false);
      const { client } = gateway(["read", "list", error()]);
      const first = render(<App client={client} config={config()} />);
      await submit(first.stdin, TASK);
      await frameIn(first.lastFrame, { has: [KEPT] });
      first.unmount();

      // What `clixad --continue` reads, and what `/resume` lists.
      const saved = latestSession(cwd);
      expect(saved?.title).toBe(TASK);
      expect(saved?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
      expect(saved?.messages[2]?.content).toContain("alpha");

      const second = render(<App client={gateway([]).client} config={config()} />);
      await submit(second.stdin, "/resume");
      const frame = await frameWith(second.lastFrame, "Resume a session");
      second.unmount();
      expect(frame).not.toContain("no saved sessions in this directory yet");
      expect(frame).toContain(TASK.slice(0, 40));
    });
  }

  it("keeps the work in the conversation, so the next message carries on from it", async () => {
    const { client, sent } = gateway(["read", new MaintenanceError(DOWN), "answer"]);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, TASK);
    await frameIn(lastFrame, { has: [KEPT] });
    await submit(stdin, "continue");
    await frameWith(lastFrame, "ANSWERED");
    unmount();

    const next = sent.at(-1)!;
    expect(next.slice(1).map((m) => [m.role, typeof m.content === "string" ? m.content.slice(0, 40) : m.content])).toEqual([
      ["user", TASK],
      ["assistant", null],
      ["tool", expect.stringContaining("alpha")],
      ["user", "continue"],
    ]);
    // And the finished turn saved over it, with the work still in it.
    const [meta] = listSessions(cwd, 5);
    expect(loadSession(meta!.id)?.messages).toHaveLength(5);
  });

  it("is saved while it is still running, round by round", async () => {
    const { client } = gateway(["read", "list", "hang"]);
    const { stdin, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, TASK);
    // The turn is waiting on the third call: a terminal closed now would
    // still leave the first two rounds to resume.
    await waitFor(() => (latestSession(cwd)?.messages.length ?? 0) === 5);
    expect(latestSession(cwd)?.title).toBe(TASK);
    stdin.write("\x1b");
    await tick(100);
    unmount();
  });
});

describe("what did not change", () => {
  it("a request refused before it did anything is not saved and not kept", async () => {
    const { client, sent } = gateway([new Error("chat failed: 500"), "answer"]);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, TASK);
    const frame = await frameWith(lastFrame, "chat failed: 500");
    expect(frame.replace(/\s+/g, " ")).not.toContain(KEPT);
    expect(listSessions(cwd, 5)).toHaveLength(0);

    await submit(stdin, "try again");
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    // The refused message did not stay in the conversation.
    expect(sent.at(-1)!.slice(1).map((m) => m.content)).toEqual(["try again"]);
  });

  it("a paywall after some work keeps the work and says only what the paywall says", async () => {
    const { client } = gateway(["read", new PaywallError(5, 1190, 51_000)]);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, TASK);
    const frame = await frameWith(lastFrame, "Press enter");
    unmount();
    expect(frame.replace(/\s+/g, " ")).not.toContain(KEPT);
    expect(latestSession(cwd)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("a turn that finishes is saved once it ends, as before", async () => {
    const { client } = gateway(["read", "answer"]);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, TASK);
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    const saved = latestSession(cwd);
    expect(saved?.title).toBe(TASK);
    expect(saved?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});
