/**
 * A conversation refused as too long for its model, through the real REPL.
 *
 * The report: one task (a prompt, then large file reads) was refused part way
 * because the conversation had grown past what the model is sold for. The
 * refusal said to run /compact, and /compact answered "nothing to compact
 * yet": the only place it knew to cut was between turns, and the whole
 * conversation was one turn.
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
 * A model that reads one file after another until told to stop, writes a
 * summary when asked for one, and answers "continue" once it has read
 * everything it was going to; and a gateway in front of it that refuses any
 * request over the line, with the sentence `refusal` gives.
 */
function gateway(refusal: (messages: ChatMessage[]) => string = () => CONVERSATION) {
  const sent: { messages: ChatMessage[]; bound: number; refused: boolean }[] = [];
  let reads = 0;
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
        return reply({ role: "assistant", content: `SUMMARY: read ${reads} files of the parser so far; nothing changed yet.` });
      }
      if (last.role === "user" && last.content === "continue") return reply({ role: "assistant", content: "ANSWERED" });
      const file = FILES[reads++ % FILES.length]!;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call${reads}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }],
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

describe("one long task refused as too long for the model", () => {
  it("is told to /compact, and /compact brings it under the line", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);

    await submit(stdin, "read every file of the parser and explain it");
    const refused = await frameIn(lastFrame, { has: ["This conversation is too long for Claude Haiku 5.5.", "Run /compact"] });
    // The turn's work is kept, so the advice says so instead of the usual line.
    expect(fold(refused)).not.toContain(fold(KEPT_AFTER_ERROR));
    expect(fold(refused)).not.toContain("Run /clear to start over, or /model to switch");
    const turn = sent.filter((s) => !s.refused).length;
    expect(sent.at(-1)!.refused).toBe(true);
    // A single turn: one user message, nothing before it to cut at.
    expect(sent.at(-1)!.messages.filter((m) => m.role === "user")).toHaveLength(1);

    await submit(stdin, "/compact");
    const compacted = await frameWith(lastFrame, "compacted:");
    expect(compacted).not.toContain("nothing to compact yet");
    const summaries = sent.slice(turn + 1);
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      expect(s.refused).toBe(false);
      expect(requestTokens(s.messages)).toBeLessThanOrEqual(compactBudget(WINDOW));
    }

    await submit(stdin, "continue");
    await frameWith(lastFrame, "ANSWERED");
    unmount();

    const next = sent.at(-1)!;
    expect(next.refused).toBe(false);
    expect(next.messages[1]!.content).toMatch(/^Summary of the earlier conversation:\n\nSUMMARY: /);
    expect(next.messages.at(-1)).toEqual({ role: "user", content: "continue" });
  });

  it("is brought under the line by the next message too, which compacts first", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "read every file of the parser and explain it");
    await frameIn(lastFrame, { has: ["Run /compact"] });

    await submit(stdin, "continue");
    await frameWith(lastFrame, ["compacted context:", "ANSWERED"]);
    unmount();
    expect(sent.at(-1)!.refused).toBe(false);
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
