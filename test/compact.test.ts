/** Context compaction — the thing that keeps a long session from eating credits. */
import { describe, expect, it } from "vitest";
import {
  COMPACT_ADVICE,
  compact,
  compactBudget,
  compactionHelps,
  conversationTokens,
  cutPoint,
  estimateTokens,
  planCompaction,
  requestTokens,
  safeCuts,
  shouldCompact,
  SUMMARY_ACK,
  SUMMARY_LEAD,
  withCompactAdvice,
} from "../src/compact.ts";
import type { AgentClient } from "../src/agent.ts";
import type { ChatMessage, ChatTurn } from "../src/client.ts";

/** The window the gateway serves for a model whose prompt price break is at 100,000 tokens. */
const WINDOW = 24_000;
const BUDGET = compactBudget(WINDOW);

const summariser: AgentClient = {
  async chatStream(): Promise<ChatTurn> {
    return {
      message: { role: "assistant", content: "The user renamed foo() to bar() in src/a.ts." },
      finishReason: "stop",
      creditsCharged: 12,
      balance: 400,
    };
  },
};

/** A summariser that keeps every request it was sent and answers with a numbered summary. */
function recording(reply: (n: number) => string = (n) => `summary ${n}: the parser was read, nothing changed yet.`) {
  const sent: ChatMessage[][] = [];
  const client: AgentClient = {
    async chatStream(messages): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      return {
        message: { role: "assistant", content: reply(sent.length) },
        finishReason: "stop",
        creditsCharged: 10,
        balance: 1_000 - 10 * sent.length,
      };
    },
  };
  return { client, sent };
}

/** Turns are deliberately chunky: compaction only pays off on real history. */
function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i} ${"detail ".repeat(40)}` });
    messages.push({ role: "assistant", content: `answer ${i} ${"explanation ".repeat(40)}` });
  }
  return messages;
}

/** Source text of about `bytes` bytes: quotes and newlines, which JSON escapes. */
function source(bytes: number, seed: number): string {
  const line = `export const value${seed} = "a string with \\"quotes\\" in it"; // ${seed}\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

function readRound(i: number, bytes: number): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }],
    },
    { role: "tool", tool_call_id: `c${i}`, content: source(bytes, i) },
  ];
}

/** One prompt, then `reads` file reads of `bytes` each: a single long turn. */
function longTask(reads: number, bytes: number, system = "system prompt ".repeat(100)): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: "refactor the parser" }];
  for (let i = 0; i < reads; i++) messages.push(...readRound(i, bytes));
  return messages;
}

/** Every tool call answered before anything else, and no result without its call. */
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

describe("compaction", () => {
  it("estimates tokens and triggers on the threshold", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    const messages = conversation(1);
    expect(shouldCompact(messages, 1_000_000)).toBe(false);
    expect(shouldCompact(messages, 10)).toBe(true);
  });

  it("counts tool call arguments, not just text", () => {
    const withTool: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "write_file", arguments: "x".repeat(400) } }],
      },
    ];
    expect(conversationTokens(withTool)).toBeGreaterThan(100);
  });

  it("cuts at a user-message boundary so tool results keep their call", () => {
    const messages = conversation(4);
    const cut = cutPoint(messages, 2);
    expect(messages[cut]!.role).toBe("user");
    expect(messages.slice(cut).filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("replaces the old turns with a summary and keeps the system prompt", async () => {
    const messages = conversation(4);
    const res = await compact(summariser, "m", messages, WINDOW);

    expect(res).toBeDefined();
    expect(res!.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(res!.messages[1]!.content).toContain("renamed foo()");
    expect(res!.messages).toHaveLength(3 + 4); // system + summary + ack + the last two turns
    expect(res!.after).toBeLessThan(res!.before);
    expect(res!.creditsCharged).toBe(12);
    expect(res!.calls).toBe(1);

    // The most recent exchange survives verbatim.
    expect(res!.messages.at(-1)!.content).toContain("answer 3");
  });

  it("does nothing when there is not enough history to summarise", async () => {
    expect(await compact(summariser, "m", conversation(1), WINDOW)).toBeUndefined();
  });
});

describe("what a request weighs", () => {
  const samples: ChatMessage[] = [
    { role: "user", content: "plain ascii" },
    { role: "user", content: "日本語のテキストと絵文字 ✅ ❌" },
    { role: "tool", tool_call_id: "c", content: source(5_000, 1) },
    { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: '{"a":"\\n\\"b\\""}' } }] },
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(40_000)}` } },
      ],
    },
  ];

  // Compaction lands under the budget by this measure, and the REPL decides
  // to compact by `conversationTokens`: if the first could come out lower, a
  // compacted conversation could be compacted again on the very next turn.
  it("is never less than the estimate the REPL compacts by", () => {
    for (const m of samples) expect(requestTokens([m]), JSON.stringify(m).slice(0, 40)).toBeGreaterThanOrEqual(conversationTokens([m]));
  });

  it("counts the bytes on the wire, not the characters", () => {
    const text = "日本語".repeat(1_000);
    expect(requestTokens([{ role: "user", content: text }])).toBeGreaterThan(Buffer.byteLength(text) / 4);
    expect(conversationTokens([{ role: "user", content: text }])).toBeLessThan(Buffer.byteLength(text) / 4);
  });

  it("counts an image by its estimate, not by its base64", () => {
    const weight = requestTokens([samples[4]!]);
    expect(weight).toBeGreaterThan(1_400);
    expect(weight).toBeLessThan(1_500);
  });
});

describe("where a long turn can be cut", () => {
  it("never between a tool call and its result", () => {
    const messages = longTask(3, 100);
    const cuts = safeCuts(messages);
    for (const c of cuts) expect(c === messages.length || messages[c]!.role !== "tool").toBe(true);
    // The prompt, each read's call, and the end.
    expect(cuts).toEqual([1, 2, 4, 6, 8]);
  });
});

/**
 * The report: one long task, a prompt and a run of large file reads, was
 * refused for its length; the refusal said to run /compact; /compact answered
 * "nothing to compact yet", because the only cut it knew was between turns and
 * the whole conversation was one turn.
 */
describe("a single long turn over the budget", () => {
  const messages = longTask(4, 30_000);

  it("is over the budget, and had nothing to compact under the old rule", () => {
    expect(requestTokens(messages)).toBeGreaterThan(BUDGET);
    expect(cutPoint(messages, 2)).toBe(0);
  });

  it("is compacted inside the turn, and comes out under the budget", async () => {
    const { client, sent } = recording();
    const res = await compact(client, "m", messages, WINDOW);

    expect(res).toBeDefined();
    expect(requestTokens(res!.messages)).toBeLessThanOrEqual(BUDGET);
    expect(shouldCompact(res!.messages, WINDOW)).toBe(false);
    expect(wellFormed(res!.messages)).toBe(true);
    expect(compactionHelps(messages, WINDOW)).toBe(true);

    // The last read kept as it was, straight after the summary: a cut inside
    // a turn carries on with the model's own step, without an acknowledgement.
    expect(res!.messages[0]).toEqual(messages[0]);
    expect(res!.messages[1]!.content).toBe(`${SUMMARY_LEAD}summary 2: the parser was read, nothing changed yet.`);
    expect(res!.messages.slice(2)).toEqual(messages.slice(-2));
  });

  it("sends what it summarises in requests that each fit the budget, the summary carried from one to the next", async () => {
    const { client, sent } = recording();
    const res = await compact(client, "m", messages, WINDOW);

    expect(sent.length).toBeGreaterThan(1);
    expect(res!.calls).toBe(sent.length);
    expect(res!.creditsCharged).toBe(10 * sent.length);
    expect(res!.balance).toBe(1_000 - 10 * sent.length);
    for (const request of sent) {
      expect(requestTokens(request)).toBeLessThanOrEqual(BUDGET);
      expect(wellFormed(request.slice(0, -1))).toBe(true);
      expect(request.at(-1)!.content).toMatch(/^Summarise the conversation above/);
    }
    expect(sent[0]![1]).toEqual(messages[1]); // the task
    expect(sent[1]![1]!.content).toBe(`${SUMMARY_LEAD}summary 1: the parser was read, nothing changed yet.`);
    // Every read but the kept one was summarised exactly once.
    const reads = sent.flatMap((r) => r.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    expect(reads).toEqual(["c0", "c1", "c2"]);
  });

  it("is said to be helped by /compact only while it is over the budget", () => {
    expect(compactionHelps(longTask(1, 2_000), WINDOW)).toBe(false);
    expect(planCompaction(longTask(1, 2_000), WINDOW)).toBeUndefined();
  });
});

describe("a file read too large for any one request", () => {
  const messages = longTask(1, 200_000);

  it("is summarised from the part that fits, and says what was left out", async () => {
    const { client, sent } = recording();
    const res = await compact(client, "m", messages, WINDOW);

    expect(sent).toHaveLength(1);
    expect(requestTokens(sent[0]!)).toBeLessThanOrEqual(BUDGET);
    const read = sent[0]!.find((m) => m.role === "tool")!;
    expect(read.content).toMatch(/more characters left out here\]$/);
    expect(read.content!.length).toBeGreaterThan(40_000);

    // Nothing small enough to keep: the summary alone, with its answer.
    expect(res!.messages).toHaveLength(3);
    expect(res!.messages[2]).toEqual({ role: "assistant", content: SUMMARY_ACK });
    expect(requestTokens(res!.messages)).toBeLessThanOrEqual(BUDGET);
  });
});

describe("a session whose last two turns are too large to keep", () => {
  const messages: ChatMessage[] = [
    ...conversation(2),
    { role: "user", content: "now refactor the parser" },
    ...readRound(0, 30_000),
    ...readRound(1, 30_000),
    ...readRound(2, 30_000),
  ];

  it("cuts past the turns the old rule kept, inside the last one", async () => {
    const preferred = cutPoint(messages, 2);
    const plan = planCompaction(messages, WINDOW)!;
    expect(plan.cut).toBeGreaterThan(preferred);
    expect(messages[plan.cut]!.role).toBe("assistant");

    const { client } = recording();
    const res = await compact(client, "m", messages, WINDOW);
    expect(requestTokens(res!.messages)).toBeLessThanOrEqual(BUDGET);
    expect(wellFormed(res!.messages)).toBe(true);
  });
});

describe("when compaction cannot help", () => {
  it("a system prompt that fills the budget on its own", () => {
    const messages = longTask(3, 30_000, "x".repeat(4 * BUDGET));
    expect(planCompaction(messages, WINDOW)?.fits).toBe(false);
    expect(compactionHelps(messages, WINDOW)).toBe(false);
  });

  it("an empty summary leaves the conversation as it was", async () => {
    const { client, sent } = recording(() => "");
    await expect(compact(client, "m", longTask(4, 30_000), WINDOW)).rejects.toThrow(/empty summary/);
    expect(sent).toHaveLength(2); // asked once more, then given up
  });
});

describe("the advice to compact", () => {
  it("takes the place of the refusal's own advice", () => {
    const refusal = "This conversation is too long for X.\nRun /clear to start over.\nNothing was charged for this request.";
    expect(withCompactAdvice(refusal).split("\n")).toEqual([
      "This conversation is too long for X.",
      COMPACT_ADVICE,
      "Nothing was charged for this request.",
    ]);
  });

  it("follows a refusal of any other shape", () => {
    expect(withCompactAdvice("too long")).toBe(`too long\n${COMPACT_ADVICE}`);
  });
});
