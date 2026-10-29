/** Context compaction — the thing that keeps a long session from eating credits. */
import { describe, expect, it } from "vitest";
import { compact, conversationTokens, cutPoint, estimateTokens, shouldCompact } from "../src/compact.ts";
import type { AgentClient } from "../src/agent.ts";
import type { ChatMessage, ChatTurn } from "../src/client.ts";

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

/** Turns are deliberately chunky: compaction only pays off on real history. */
function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i} ${"detail ".repeat(40)}` });
    messages.push({ role: "assistant", content: `answer ${i} ${"explanation ".repeat(40)}` });
  }
  return messages;
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
    const res = await compact(summariser, "m", messages);

    expect(res).toBeDefined();
    expect(res!.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(res!.messages[1]!.content).toContain("renamed foo()");
    expect(res!.messages).toHaveLength(3 + 4); // system + summary + ack + the last two turns
    expect(res!.after).toBeLessThan(res!.before);
    expect(res!.creditsCharged).toBe(12);

    // The most recent exchange survives verbatim.
    expect(res!.messages.at(-1)!.content).toContain("answer 3");
  });

  it("does nothing when there is not enough history to summarise", async () => {
    expect(await compact(summariser, "m", conversation(1))).toBeUndefined();
  });
});
