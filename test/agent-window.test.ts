/**
 * The agent loop keeping a long task inside the model's window.
 *
 * 2026-11-08: a fresh session on Claude Haiku 5.5 was refused after four tool
 * calls, because one read returned 2,000 lines and the conversation was past
 * what the gateway takes. The loop now sizes tool results to the window and
 * compacts the conversation when it has to: before the turn's first call,
 * part way through it, and when the gateway refuses a request as too long.
 * These hold what that must not break: what is metered, what the reviewer
 * reads, esc, the session file, and what an error hands back.
 *
 * The gateway here counts every byte of a request as a token, the way the
 * real one does for a conversation it knows nothing about.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fairRoom, interruptedConversation, runAgent, type AgentEvent } from "../src/agent.ts";
import { jsonBytes, roundRoom } from "../src/room.ts";
import { compactBudget, requestTokens, SUMMARY_LEAD } from "../src/compact.ts";
import {
  messageText,
  PaywallError,
  PromptTooLongError,
  type ChatMessage,
  type ChatOptions,
  type ChatTurn,
} from "../src/client.ts";
import type { PermissionRequest, Reviewer } from "../src/permissions.ts";

const HAIKU = "claude-haiku-5.5";
const WINDOW = 24_000;
const BREAK = 100_000;
const REFUSAL =
  "This conversation is too long for Claude Haiku 5.5. From 100,000 tokens its providers charge more than Clixad sells it for, so the request was not sent.\n" +
  "Run /clear to start over, or /model to switch to a model that takes longer conversations.\n" +
  "Nothing was charged for this request.";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-window-"));
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(root, `f${i}.ts`), `export const value${i} = "${"v".repeat(60)}";\n`.repeat(400));
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Options {
  /** Files to read, one a round, before answering. */
  reads?: number;
  /** Credits each call charges; 0 with `free` set is a free call. */
  free?: boolean;
  /** Called with each request before it is answered, to fail or stall one. */
  before?: (messages: ChatMessage[], n: number) => void | Promise<void>;
}

/** A model that reads `reads` files and answers, in front of a gateway that refuses past the line. */
function fake({ reads = 8, free = false, before }: Options = {}) {
  const sent: { messages: ChatMessage[]; refused: boolean; summary: boolean; review: boolean }[] = [];
  let done = 0;
  const client = {
    async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const summary = messageText(messages.at(-1)!).startsWith("Summarise the conversation above");
      const review = messageText(messages[0]!).startsWith("You review one action");
      let bytes = 4_096;
      for (const m of messages) bytes += Buffer.byteLength(JSON.stringify(m));
      for (const t of (opts.tools as unknown[] | undefined) ?? []) bytes += Buffer.byteLength(JSON.stringify(t));
      const refused = bytes >= BREAK;
      sent.push({ messages: structuredClone(messages), refused, summary, review });
      await before?.(messages, sent.length);
      if (opts.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (refused) throw new PromptTooLongError(REFUSAL);
      const turn = (message: ChatMessage): ChatTurn => ({
        message,
        finishReason: "stop",
        creditsCharged: free ? 0 : 7,
        balance: 10_000,
        ...(free ? { free: true, creditsWaived: 7, freeCreditsLeft: 1_000 } : {}),
      });
      if (summary) return turn({ role: "assistant", content: `read ${done} files so far` });
      if (review) return turn({ role: "assistant", content: '{"decision":"allow","reason":"asked for"}' });
      if (done < reads) {
        const i = done++;
        return turn({
          role: "assistant",
          content: null,
          tool_calls: [{ id: `r${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `f${i}.ts` }) } }],
        });
      }
      if (done === reads) {
        done++;
        return turn({
          role: "assistant",
          content: null,
          tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "notes.md", content: "done" }) } }],
        });
      }
      return turn({ role: "assistant", content: "FINISHED" });
    },
  };
  return { client, sent };
}

function wellFormed(messages: ChatMessage[]): boolean {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      if (!open.delete(m.tool_call_id ?? "")) return false;
      continue;
    }
    if (open.size > 0) return false;
    for (const c of m.tool_calls ?? []) open.add(c.id);
  }
  return open.size === 0;
}

describe("a long task on a model the gateway refuses past a line", () => {
  it("is compacted when refused, sent again, and finishes", async () => {
    const { client, sent } = fake();
    const events: AgentEvent[] = [];
    const res = await runAgent(client, "read the files", { model: HAIKU, root, contextTokens: WINDOW, onEvent: (e) => events.push(e) });
    expect(res.content).toBe("FINISHED");
    const refused = sent.filter((s) => s.refused).length;
    expect(refused).toBeGreaterThan(0);
    for (const [i, s] of sent.entries()) if (s.refused) expect(sent[i + 1]!.refused).toBe(false);
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted).toHaveLength(refused);
    expect(compacted.every((e) => e.type === "compacted" && e.why === "refused")).toBe(true);
  });

  it("meters every call it made, the summaries included, and nothing for a refusal", async () => {
    const { client, sent } = fake();
    const events: AgentEvent[] = [];
    const res = await runAgent(client, "read the files", { model: HAIKU, root, contextTokens: WINDOW, onEvent: (e) => events.push(e) });
    const answered = sent.filter((s) => !s.refused).length;
    expect(res.creditsCharged).toBe(answered * 7);
    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(answered);
    // The notice's figure is the summaries' share of it.
    const summaries = sent.filter((s) => s.summary && !s.refused).length;
    const said = events.reduce((n, e) => n + (e.type === "compacted" ? e.creditsCharged : 0), 0);
    expect(said).toBe(summaries * 7);
  });

  it("counts a free summary as waived, like any free call", async () => {
    const { client, sent } = fake({ free: true });
    const res = await runAgent(client, "read the files", { model: HAIKU, root, contextTokens: WINDOW });
    expect(res.creditsCharged).toBe(0);
    expect(res.creditsWaived).toBe(sent.filter((s) => !s.refused).length * 7);
  });

  it("saves the compacted conversation, well formed and starting with the summary", async () => {
    const { client } = fake();
    const saved: ChatMessage[][] = [];
    await runAgent(client, "read the files", { model: HAIKU, root, contextTokens: WINDOW, onCheckpoint: (m) => saved.push(m) });
    const after = saved.find((m) => messageText(m[1]!).startsWith(SUMMARY_LEAD));
    expect(after).toBeDefined();
    for (const m of saved) expect(wellFormed(m)).toBe(true);
  });

  it("hands back the compacted conversation when a later call fails", async () => {
    let compactedYet = false;
    const { client } = fake({
      before: (messages) => {
        if (messageText(messages[1] ?? messages[0]!).startsWith(SUMMARY_LEAD)) compactedYet = true;
        if (compactedYet && messages.at(-1)!.role === "tool") throw new Error("the provider is down");
      },
    });
    const err = await runAgent(client, "read the files", { model: HAIKU, root, contextTokens: WINDOW }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the provider is down");
    const kept = interruptedConversation(err)!;
    expect(messageText(kept[1]!)).toMatch(new RegExp(`^${SUMMARY_LEAD}`));
    expect(wellFormed(kept)).toBe(true);
  });

  it("stops on esc during a summary, with every tool call answered", async () => {
    const ac = new AbortController();
    const { client } = fake({ before: (messages) => void (messageText(messages.at(-1)!).startsWith("Summarise") && ac.abort()) });
    const events: AgentEvent[] = [];
    const res = await runAgent(client, "read the files", {
      model: HAIKU,
      root,
      contextTokens: WINDOW,
      signal: ac.signal,
      onEvent: (e) => events.push(e),
    });
    expect(res.stopped).toBe("aborted");
    expect(events.at(-1)).toEqual({ type: "aborted" });
    expect(wellFormed(res.messages)).toBe(true);
  });

  it("lets auto mode's reviewer read what the user asked after the task was summarised", async () => {
    const { client, sent } = fake();
    const permit = async (req: PermissionRequest, review?: Reviewer) => {
      const verdict = await review!(req);
      return verdict.decision === "allow" ? ({ allowed: true } as const) : ({ allowed: false, reason: "no", notice: "no" } as const);
    };
    const res = await runAgent(client, "read the files and write notes.md", {
      model: HAIKU,
      root,
      contextTokens: WINDOW,
      permit,
      review: { model: HAIKU },
    });
    expect(res.content).toBe("FINISHED");
    const review = sent.find((s) => s.review)!;
    // Compacted before the write was reviewed, and the reviewer still read the request.
    expect(sent.findIndex((s) => s.summary)).toBeLessThan(sent.indexOf(review));
    expect(messageText(review.messages[1]!)).toContain("read the files and write notes.md");
  });
});

describe("instructions that take most of the window", () => {
  it("do not stop a long task: what grows after them is compacted when the gateway refuses", async () => {
    const { client, sent } = fake({ reads: 10 });
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: "user", content: `question ${i} ${"word ".repeat(400)}` });
      history.push({ role: "assistant", content: `answer ${i} ${"word ".repeat(400)}` });
    }
    const events: AgentEvent[] = [];
    // A project's instructions of about 60 kB and a message of 20 kB: the start
    // of the turn cannot get under the line, since neither may be summarised.
    const task = `read the files, with this in mind:\n${"context ".repeat(2_500)}`;
    const res = await runAgent(client, task, {
      model: HAIKU,
      root,
      history,
      systemPrompt: `instructions\n${"rule ".repeat(12_000)}`,
      contextTokens: WINDOW,
      onEvent: (e) => events.push(e),
    });
    expect(res.content).toBe("FINISHED");
    const whys = events.flatMap((e) => (e.type === "compacted" ? [e.why] : []));
    expect(whys[0]).toBe("start");
    expect(whys.slice(1)).toContain("refused");
    for (const [i, s] of sent.entries()) if (s.refused) expect(sent[i + 1]!.refused).toBe(false);
  });
});

describe("before the first call of a turn", () => {
  it("compacts a long history with the new message kept as it is, and reports the history to keep", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "user", content: `question ${i} ${"word ".repeat(200)}` });
      history.push({ role: "assistant", content: `answer ${i} ${"word ".repeat(200)}` });
    }
    expect(requestTokens(history)).toBeGreaterThan(compactBudget(WINDOW));
    const { client, sent } = fake({ reads: 0 });
    const events: AgentEvent[] = [];
    await runAgent(client, "and now?", { model: HAIKU, root, history, contextTokens: WINDOW, onEvent: (e) => events.push(e) });
    const start = events.find((e) => e.type === "compacted");
    expect(start).toMatchObject({ type: "compacted", why: "start" });
    const kept = (start as Extract<AgentEvent, { type: "compacted" }>).history!;
    expect(messageText(kept[0]!)).toMatch(new RegExp(`^${SUMMARY_LEAD}`));
    expect(kept.some((m) => m.content === "and now?")).toBe(false);
    const first = sent.find((s) => !s.summary)!;
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "and now?" });
    expect(requestTokens(first.messages)).toBeLessThanOrEqual(compactBudget(WINDOW));
  });

  it("hands nothing back when the summary itself is refused for want of credits", async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "user", content: `question ${i} ${"word ".repeat(200)}` });
      history.push({ role: "assistant", content: `answer ${i} ${"word ".repeat(200)}` });
    }
    const { client } = fake({
      before: () => {
        throw new PaywallError(0, 100, 1);
      },
    });
    const err = await runAgent(client, "and now?", { model: HAIKU, root, history, contextTokens: WINDOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaywallError);
    expect(interruptedConversation(err)).toBeUndefined();
  });
});

describe("without a window", () => {
  it("is the loop it was: nothing compacted, results as the tools return them", async () => {
    const { client, sent } = fake({ reads: 2 });
    const res = await runAgent(client, "read the files", { model: HAIKU, root });
    expect(res.content).toBe("FINISHED");
    expect(sent.some((s) => s.summary)).toBe(false);
    const read = sent.at(-1)!.messages.find((m) => m.role === "tool")!;
    expect(messageText(read)).not.toContain("as much as one read returns");
  });
});

describe("one round's room, shared between its calls", () => {
  it("gives every call what it wants when that fits, the first one what the others leave", () => {
    expect(fairRoom(18_000, [500, 2_000])).toBe(16_000);
    expect(fairRoom(18_000, [2_000])).toBe(18_000);
  });

  it("gives the small wants all they need and splits the rest evenly between the large", () => {
    const wants = [4_500, 20_000, 170_000, 1_700];
    expect(fairRoom(18_000, wants)).toBe(4_500);
    expect(fairRoom(18_000, [20_000, 170_000, 1_700])).toBe(Math.floor((18_000 - 1_700) / 2));
    expect(fairRoom(18_000 - 1_700 - 8_150, [170_000, 1_700])).toBe(18_000 - 1_700 - 8_150 - 1_700);
  });

  it("never gives a call nothing", () => {
    expect(fairRoom(0, [50_000, 50_000])).toBe(1_024);
    expect(fairRoom(-5_000, [10])).toBe(1_024);
  });

  /**
   * The first live run on Claude Haiku 5.5 read a README, a 430 kB markdown
   * file and package.json in one round, and the README, read first, took the
   * room: the long file came back as 36 lines.
   */
  it("reads two long files side by side to about the same length", async () => {
    writeFileSync(join(root, "long-a.md"), Array.from({ length: 3_000 }, (_, i) => `a ${i} ${"text ".repeat(10)}`).join("\n"));
    writeFileSync(join(root, "long-b.md"), Array.from({ length: 3_000 }, (_, i) => `b ${i} ${"text ".repeat(10)}`).join("\n"));
    writeFileSync(join(root, "short.json"), '{ "name": "x" }\n');
    let n = 0;
    const sent: ChatMessage[][] = [];
    const client = {
      async chatStream(messages: ChatMessage[]): Promise<ChatTurn> {
        sent.push(structuredClone(messages));
        const turn = (message: ChatMessage): ChatTurn => ({ message, finishReason: "stop", creditsCharged: 1, balance: 100 });
        if (n++ > 0) return turn({ role: "assistant", content: "ok" });
        return turn({
          role: "assistant",
          content: null,
          tool_calls: ["short.json", "long-a.md", "long-b.md"].map((path, i) => ({
            id: `p${i}`,
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ path }) },
          })),
        });
      },
    };
    await runAgent(client, "read them", { model: HAIKU, root, contextTokens: WINDOW });
    const results = sent[1]!.filter((m) => m.role === "tool").map((m) => messageText(m));
    const [short, a, b] = results.map(jsonBytes);
    expect(results[0]).toContain('"name": "x"');
    expect(short! + a! + b!).toBeLessThanOrEqual(roundRoom(WINDOW));
    expect(Math.abs(a! - b!)).toBeLessThan(200);
    expect(a!).toBeGreaterThan((roundRoom(WINDOW) - short!) / 2 - 400);
  });
});

describe("the step limit, on a model whose window cuts reads into parts", () => {
  /**
   * Live on 2026-11-08: reading 3,600 lines of a long markdown file on Claude Haiku 5.5
   * took 15 reads in parts and finished on the sixteenth step, the limit.
   */
  it("does not count the parts of a read the window cut, up to twice the limit", async () => {
    writeFileSync(join(root, "long.md"), Array.from({ length: 2_000 }, (_, i) => `${i + 1} ${"text ".repeat(16)}`).join("\n"));
    let id = 0;
    const client = {
      async chatStream(messages: ChatMessage[]): Promise<ChatTurn> {
        const turn = (message: ChatMessage): ChatTurn => ({ message, finishReason: "stop", creditsCharged: 1, balance: 100 });
        const last = messageText(messages.at(-1)!);
        if (last.startsWith("Summarise")) return turn({ role: "assistant", content: "summary" });
        const on = /Read on with offset: (\d+)\.$/.exec(last);
        if (messages.at(-1)!.role === "tool" && !on) return turn({ role: "assistant", content: "READ IT ALL" });
        const args = on ? { path: "long.md", offset: Number(on[1]) } : { path: "long.md" };
        return turn({
          role: "assistant",
          content: null,
          tool_calls: [{ id: `p${++id}`, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }],
        });
      },
    };
    const res = await runAgent(client, "read long.md", { model: HAIKU, root, contextTokens: WINDOW, maxSteps: 6 });
    expect(id).toBeGreaterThan(6);
    expect(res.stopped).toBeUndefined();
    expect(res.content).toBe("READ IT ALL");
  });

  it("still stops a run that keeps calling tools whose results fit", async () => {
    let id = 0;
    const client = {
      async chatStream(): Promise<ChatTurn> {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `l${++id}`, type: "function", function: { name: "list_dir", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 100,
        };
      },
    };
    const res = await runAgent(client, "loop", { model: HAIKU, root, contextTokens: WINDOW, maxSteps: 5 });
    expect(res.stopped).toBe("max_steps");
    expect(id).toBe(5);
  });
});
