/**
 * `/undo`: the last typed message back into the input box, the conversation
 * cut before it in memory and on disk, and the two things that are not taken
 * back said every time.
 *
 * The session file is the part that broke before (a turn that threw used to
 * take its conversation with it), so the REPL cases read it back after each
 * step and resume it in a second REPL, which is what `--continue` does.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { latestSession, listSessions, loadSession } from "../src/session.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient } from "../src/client.ts";
import { MENTIONS_HEADING } from "../src/mentions.ts";
import { SUMMARY_ACK, SUMMARY_LEAD } from "../src/compact.ts";
import { shellNote } from "../src/tui/replay.ts";
import { nothingToUndo, planUndo, undoLines, UNSENT_UNDO } from "../src/undo.ts";
import { frameWith, waitFor } from "./helpers/wait.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("planUndo", () => {
  const before: ChatMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
  ];

  it("cuts before the last typed message and lists what the turn did on disk", () => {
    const messages: ChatMessage[] = [
      ...before,
      { role: "user", content: `fix @a.ts${MENTIONS_HEADING}## a.ts\n...` },
      { role: "assistant", content: null, tool_calls: [call("1", "edit_file", { path: "a.ts" }), call("2", "write_file", { path: "b.ts" })] },
      { role: "tool", tool_call_id: "1", content: "edited a.ts" },
      { role: "tool", tool_call_id: "2", content: "wrote b.ts" },
      { role: "assistant", content: null, tool_calls: [call("3", "run_command", { command: "npm test" }), call("4", "edit_file", { path: "c.ts" })] },
      { role: "tool", tool_call_id: "3", content: "exit 0" },
      // Refused: it did not happen, so it is not listed.
      { role: "tool", tool_call_id: "4", content: "error: the user denied edit c.ts. It did not happen." },
      { role: "assistant", content: null, tool_calls: [call("5", "mcp__github__create_issue", {}), call("6", "edit_file", { path: "a.ts" })] },
      { role: "tool", tool_call_id: "5", content: "created" },
      { role: "tool", tool_call_id: "6", content: "edited a.ts" },
      { role: "user", content: shellNote("git status", "clean") },
      { role: "assistant", content: "done" },
    ];
    const result = planUndo(messages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.kept).toEqual(before);
    // What was typed, without the file the mention attached.
    expect(result.plan.text).toBe("fix @a.ts");
    expect(result.plan.files).toEqual(["a.ts", "b.ts"]);
    // The agent's command and the `!command` typed after the message.
    expect(result.plan.commands).toBe(2);
    expect(result.plan.toolCalls).toBe(1);
    const lines = undoLines(result.plan);
    expect(lines.kept).toBe(
      "Not undone: the credits it used, and the changes on disk. The agent edited a.ts, b.ts, ran 2 commands, made 1 MCP tool call; those stay as they are.",
    );
  });

  it("passes over the messages the REPL writes in the person's name", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "look at the screenshot" },
      { role: "assistant", content: null, tool_calls: [call("1", "read_file", { path: "s.png" })] },
      { role: "tool", tool_call_id: "1", content: "the image follows" },
      { role: "user", content: [{ type: "text", text: "Here is the image you read (s.png). Continue the task." }] },
      { role: "assistant", content: "a button" },
    ];
    const result = planUndo(messages);
    expect(result.ok && result.plan.text).toBe("look at the screenshot");
    expect(result.ok && result.plan.kept).toEqual([]);
    expect(result.ok && undoLines(result.plan).kept).toBe("Not undone: the credits it used. The agent changed no files for it.");
  });

  it("finds nothing in an empty conversation, or behind a summary", () => {
    expect(planUndo([])).toEqual({ ok: false, reason: "empty" });
    const summarised: ChatMessage[] = [
      { role: "user", content: `${SUMMARY_LEAD}what happened` },
      { role: "assistant", content: SUMMARY_ACK },
    ];
    expect(planUndo(summarised)).toEqual({ ok: false, reason: "summarised" });
    expect(nothingToUndo("summarised")).toContain("summarised");
    // A message typed after the summary is taken back, and the summary stays.
    const after = [...summarised, { role: "user" as const, content: "next" }, { role: "assistant" as const, content: "ok" }];
    const result = planUndo(after);
    expect(result.ok && result.plan.kept).toEqual(summarised);
  });
});

// ---------------------------------------------------------------------------

const config = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "deepseek-v4.1-flash",
});

/** A gateway that answers each turn with a read of a.txt and then `ANSWER <n>`, and records what it was sent. */
function gateway(fail?: (n: number) => Error | undefined) {
  const sent: ChatMessage[][] = [];
  let calls = 0;
  let turn = 0;
  const client = {
    models: async () => [],
    wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(messages: ChatMessage[], _model: string, _opts: ChatOptions): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      calls++;
      const last = messages.at(-1)!;
      if (last.role === "user") {
        turn++;
        const error = fail?.(turn);
        if (error) throw error;
        return {
          message: { role: "assistant", content: null, tool_calls: [call(`c${calls}`, "read_file", { path: "a.txt" })] },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 1,
        };
      }
      return { message: { role: "assistant", content: `ANSWER ${turn}` }, finishReason: "stop", creditsCharged: 1, balance: 1 };
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
const flat = (s: string) => s.replace(/\s+/g, " ");
const texts = (messages: ChatMessage[] | undefined) =>
  (messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : ""));

let cwd: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "clixad-undo-")));
  cwd = process.cwd();
  writeFileSync(join(cwd, "a.txt"), "alpha\n");
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("/undo in the REPL", () => {
  it("puts the message back in the box, cuts the session file before it, and the next turn and a resume agree", async () => {
    const { client, sent } = gateway();
    const first = render(<App client={client} config={config()} />);
    await submit(first.stdin, "first task");
    await frameWith(first.lastFrame, "ANSWER 1");
    await submit(first.stdin, "second task");
    await frameWith(first.lastFrame, "ANSWER 2");
    expect(texts(latestSession(cwd)?.messages)).toEqual(["first task", "second task"]);

    await submit(first.stdin, "/undo");
    const frame = flat(await frameWith(first.lastFrame, "Not undone"));
    expect(frame).toContain("Took back your last message.");
    expect(frame).toContain("Not undone: the credits it used. The agent changed no files for it.");
    // On disk at once: what `--continue` would pick up.
    await waitFor(() => texts(latestSession(cwd)?.messages).length === 1);
    expect(texts(latestSession(cwd)?.messages)).toEqual(["first task"]);
    expect(latestSession(cwd)?.title).toBe("first task");

    // The message is in the input box: what is typed next is added to it,
    // and Enter sends the edited text.
    first.stdin.write(" again");
    await tick();
    first.stdin.write("\r");
    await frameWith(first.lastFrame, "ANSWER 3");
    expect(texts(sent.at(-1)!.slice(1))).toEqual(["first task", "second task again"]);
    expect(texts(latestSession(cwd)?.messages)).toEqual(["first task", "second task again"]);
    first.unmount();

    // A resume in a fresh REPL draws and sends what the file holds.
    const saved = latestSession(cwd)!;
    const again = gateway();
    const second = render(<App client={again.client} config={config()} session={saved} />);
    await submit(second.stdin, "/undo");
    await frameWith(second.lastFrame, "Not undone");
    await waitFor(() => texts(loadSession(saved.id)?.messages).length === 1);
    expect(texts(loadSession(saved.id)?.messages)).toEqual(["first task"]);
    second.unmount();
  });

  it("removes the session file when nothing is left, and says when there is nothing to take back", async () => {
    const { client } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "/undo");
    expect(flat(await frameWith(lastFrame, "Nothing to undo"))).toContain(nothingToUndo("empty"));
    await submit(stdin, "only task");
    await frameWith(lastFrame, "ANSWER 1");
    expect(listSessions(cwd, 5)).toHaveLength(1);
    await submit(stdin, "/undo");
    await frameWith(lastFrame, "Not undone");
    await waitFor(() => listSessions(cwd, 5).length === 0);
    unmount();
  });

  it("gives back a message that was refused before any work, and leaves the one before it alone", async () => {
    const { client, sent } = gateway((n) => (n === 2 ? new Error("chat failed: 500") : undefined));
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "first task");
    await frameWith(lastFrame, "ANSWER 1");
    await submit(stdin, "refused task");
    await frameWith(lastFrame, "chat failed: 500");
    await submit(stdin, "/undo");
    expect(flat(await frameWith(lastFrame, "nothing to take back"))).toContain(flat(UNSENT_UNDO));
    stdin.write("\r");
    await frameWith(lastFrame, "ANSWER 3");
    unmount();
    // The first exchange is still there, and the refused message went once.
    expect(texts(sent.at(-1)!.slice(1))).toEqual(["first task", "refused task"]);
  });
});
