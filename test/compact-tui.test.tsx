/**
 * A conversation too long for its model, through the real REPL.
 *
 * The first report: one task (a prompt, then large file reads) was refused
 * part way because the conversation had grown past what the model is sold
 * for, and /compact answered "nothing to compact yet". The second, the same
 * day: a fresh session with Claude Haiku 5.5 was refused after four tool
 * calls, because one read returned 2,000 lines. A task now keeps going:
 * reads are sized to the window, and the conversation is compacted part way
 * through when the gateway refuses it, and before a turn starts when it
 * would.
 *
 * The gateway here enforces the line the way the real one does when it knows
 * nothing about a conversation, one byte a token over everything a request
 * carries, so a request that slips through below would be refused there too.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App, KEPT_AFTER_ERROR } from "../src/tui/app.tsx";
import { compactBudget, requestTokens } from "../src/compact.ts";
import { roundRoom } from "../src/room.ts";
import type { CliConfig } from "../src/config.ts";
import {
  PromptTooLongError,
  type ChatMessage,
  type ChatOptions,
  type ChatTurn,
  type GatewayClient,
} from "../src/client.ts";
import { frameIn, frameWith } from "./helpers/wait.ts";

const MODEL = "claude-haiku-5.5";
/** What the gateway serves as this model's window. */
const WINDOW = 24_000;
/** Where the model's providers start charging more, and what a provider renders around a request. */
const BREAK = 100_000;
const TEMPLATE = 4_096;

const config = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: MODEL,
});

const PRICE = "From 100,000 tokens its providers charge more than Clixad sells it for, so the request was not sent.";
const CONVERSATION =
  `This conversation is too long for Claude Haiku 5.5. ${PRICE}\n` +
  "Run /clear to start over, or /model to switch to a model that takes longer conversations.\n" +
  "Nothing was charged for this request.";
const MESSAGE =
  `This message is too long for Claude Haiku 5.5 on its own. ${PRICE}\n` +
  "Send a shorter message, or attach part of the file instead of all of it. /model switches to a model that takes longer conversations.\n" +
  "Nothing was charged for this request.";

/** The gateway's cold bound: one byte a token over every message and tool, and the template. */
function bound(messages: ChatMessage[], tools: unknown): number {
  let bytes = TEMPLATE;
  for (const m of messages) bytes += Buffer.byteLength(JSON.stringify(m));
  for (const t of (tools as unknown[] | undefined) ?? []) bytes += Buffer.byteLength(JSON.stringify(t));
  return bytes;
}

const FILES = ["lexer.ts", "parser.ts", "printer.ts", "checker.ts", "emitter.ts"];

/**
 * A model that reads one file after another until it has read `reads` of
 * them, then answers; writes a summary when asked for one, and answers
 * "continue" and any other message plainly. In front of it a gateway that
 * refuses any request over the line, with the sentence `refusal` gives.
 */
function gateway(refusal: (messages: ChatMessage[]) => string = () => CONVERSATION, reads = 10) {
  const sent: { messages: ChatMessage[]; bound: number; refused: boolean }[] = [];
  let done = 0;
  const client = {
    models: async () => [],
    wallet: async () => ({ balance: 1_000_000, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const b = bound(messages, opts.tools);
      const refused = b >= BREAK;
      sent.push({ messages: structuredClone(messages), bound: b, refused });
      if (refused) throw new PromptTooLongError(refusal(messages));
      const last = messages.at(-1)!;
      const reply = (message: ChatMessage): ChatTurn => ({ message, finishReason: "stop", creditsCharged: 3, balance: 1_000_000 });
      if (typeof last.content === "string" && last.content.startsWith("Summarise the conversation above")) {
        return reply({ role: "assistant", content: `SUMMARY: read ${done} files of the parser so far; nothing changed yet.` });
      }
      if (last.role === "user") {
        if (last.content === "continue") return reply({ role: "assistant", content: "ANSWERED" });
        if (typeof last.content === "string" && !last.content.startsWith("read every file")) {
          return reply({ role: "assistant", content: `GOT ${last.content.length} characters` });
        }
      }
      if (done >= reads) return reply({ role: "assistant", content: "EXPLAINED: the parser reads tokens." });
      const file = FILES[done++ % FILES.length]!;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call${done}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }],
        },
        finishReason: "tool_calls",
        creditsCharged: 3,
        balance: 1_000_000,
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

/** A notice in one line, the way `frameIn` folds a wrapped one. */
const fold = (text: string) => text.replace(/\s+/g, " ").trim();

let cwd: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "clixad-compact-")));
  cwd = process.cwd();
  // About 30 kB each, which read_file numbers line by line: three of them
  // and the request after the third is over the line.
  for (const [i, name] of FILES.entries()) {
    writeFileSync(join(cwd, name), `export function step${i}(input: string): string { return input.trim(); }\n`.repeat(420));
  }
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("one long task on a model the gateway refuses past a line", () => {
  it("keeps going past the line, compacting part way through, and finishes", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);

    await submit(stdin, "read every file of the parser and explain it");
    const frame = await frameWith(lastFrame, "EXPLAINED: the parser reads tokens.");
    expect(fold(frame)).not.toContain("error:");
    expect(fold(frame)).not.toContain("too long for Claude Haiku 5.5");
    unmount();

    // Refused once, compacted, sent again and taken; never refused twice in a row.
    expect(sent.some((s) => s.refused)).toBe(true);
    for (const [i, s] of sent.entries()) if (s.refused) expect(sent[i + 1]?.refused).toBe(false);
    // Every read sized to the window: no tool result larger than a round may take.
    for (const s of sent) {
      for (const m of s.messages) {
        if (m.role === "tool") expect(Buffer.byteLength(JSON.stringify(m.content))).toBeLessThanOrEqual(roundRoom(WINDOW) + 2);
      }
    }
    // The last request is a summary, then the turn's latest rounds, still one task.
    const last = sent.at(-1)!.messages;
    expect(last[1]!.content).toMatch(/^Summary of the earlier conversation:\n\nSUMMARY: /);
    expect(last.filter((m) => m.role === "tool").length).toBeGreaterThan(0);
  });

  it("says it compacted, and the turn's credits are every call it made, the summaries included", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "read every file of the parser and explain it");
    const frame = fold(await frameWith(lastFrame, "EXPLAINED: the parser reads tokens."));
    unmount();
    expect(frame).toContain("compacted context part way through the task, to fit the model:");
    const charged = sent.filter((s) => !s.refused).length * 3;
    expect(frame).toContain(`[${charged} credits · balance 1,000,000]`);
  });

  it("leaves a conversation the next message can be sent on", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "read every file of the parser and explain it");
    await frameWith(lastFrame, "EXPLAINED: the parser reads tokens.");

    await submit(stdin, "continue");
    await frameWith(lastFrame, "ANSWERED");
    const next = sent.at(-1)!;
    expect(next.refused).toBe(false);
    expect(requestTokens(next.messages)).toBeLessThanOrEqual(compactBudget(WINDOW) + 100);
    expect(next.messages.at(-1)).toEqual({ role: "user", content: "continue" });
    unmount();
  });
});

describe("a large new message on a long session", () => {
  it("compacts what came before it and sends the message whole", async () => {
    const { client, sent } = gateway(() => MESSAGE);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    // Two messages that each fit, and a session that ends just under the line.
    await submit(stdin, `first part:\n${"a".repeat(30_000)}`);
    await frameWith(lastFrame, "GOT 30012 characters");
    await submit(stdin, `second part:\n${"b".repeat(30_000)}`);
    await frameWith(lastFrame, "GOT 30013 characters");
    // Under the budget: nothing was compacted before this point.
    expect(sent.every((s) => !s.refused)).toBe(true);

    const big = `third part:\n${"c".repeat(40_000)}`;
    await submit(stdin, big);
    const frame = fold(await frameWith(lastFrame, "GOT 40012 characters"));
    unmount();
    expect(frame).toContain("compacted context:");
    expect(frame).not.toContain("error:");
    const answered = sent.at(-1)!;
    expect(answered.refused).toBe(false);
    expect(answered.messages.at(-1)).toEqual({ role: "user", content: big });
    expect(answered.messages[1]!.content).toMatch(/^Summary of the earlier conversation:/);
  });
});

/** What a turn that grew past the line inside itself leaves on disk. */
function longSession() {
    const messages: ChatMessage[] = [{ role: "user", content: "read every file of the parser and explain it" }];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `r${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: FILES[i % 5] }) } }],
      });
      messages.push({ role: "tool", tool_call_id: `r${i}`, name: "read_file", content: "x".repeat(17_000) });
    }
    messages.push({ role: "assistant", content: "EXPLAINED: the parser reads tokens." });
    return {
      id: "20261108T120000-long",
      started: "2026-11-08T12:00:00.000Z",
      updated: "2026-11-08T12:10:00.000Z",
      cwd,
      model: MODEL,
      title: "read every file of the parser and explain it",
      messages,
    };
}

describe("a session resumed over the line (--continue)", () => {
  it("is compacted before its first request, and that request is taken", async () => {
    const session = longSession();
    expect(requestTokens(session.messages)).toBeGreaterThan(compactBudget(WINDOW));
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} session={session} />);
    await submit(stdin, "continue");
    const frame = fold(await frameWith(lastFrame, "ANSWERED"));
    unmount();
    expect(frame).toContain("compacted context:");
    expect(sent.every((s) => !s.refused)).toBe(true);
    expect(sent.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "continue" });
  });

  it("is brought under the line by /compact by hand, in requests the gateway takes", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} session={longSession()} />);
    await submit(stdin, "/compact");
    const frame = await frameWith(lastFrame, "compacted:");
    expect(frame).not.toContain("nothing to compact yet");
    await submit(stdin, "continue");
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    expect(sent.every((s) => !s.refused)).toBe(true);
    for (const s of sent) expect(requestTokens(s.messages)).toBeLessThanOrEqual(compactBudget(WINDOW) + 100);
  });
});

describe("a refusal /compact cannot help with", () => {
  it("a message too long on its own is not told to compact", async () => {
    const { client, sent } = gateway(() => MESSAGE);
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, `explain this:\n${"y".repeat(120_000)}`);
    const frame = await frameIn(lastFrame, { has: ["This message is too long for Claude Haiku 5.5 on its own."] });
    unmount();
    expect(sent).toHaveLength(1);
    // "Run /compact": the banner's rotating tip may name the command too.
    expect(fold(frame)).not.toContain("Run /compact");
    // Nothing was done, so nothing is kept and nothing is said to be.
    expect(fold(frame)).not.toContain(fold(KEPT_AFTER_ERROR));
  });
});
