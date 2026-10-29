/**
 * A thinking model's reasoning survives the tool loop, and does not outlive it;
 * and an empty answer is asked for again once.
 *
 * Both measured against OpenRouter on 2026-09-29 with our real prompt and tool
 * schema. With the reasoning cut away, Kimi K2.5 answered a tool result with an
 * empty message 6 times in 12 (once in 12 with it returned), and Gemini 3.5
 * Flash-Lite went silent after every tool round. Gemini 2.5 Flash-Lite emits
 * nothing at all on roughly one first call in twenty, reasoning or not — and an
 * empty reply used to end the turn in silence, since the TUI commits nothing
 * for it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentClient, type AgentEvent } from "../src/agent.ts";
import { GatewayClient, mergeReasoningDetails, type ChatMessage, type ChatOptions, type ChatTurn } from "../src/client.ts";
import type { CliConfig } from "../src/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adg-reasoning-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "kimi-k2.5",
};

class ScriptedClient implements AgentClient {
  sent: ChatMessage[][] = [];
  private i = 0;
  constructor(private turns: ChatMessage[]) {}
  async chatStream(messages: ChatMessage[], _model: string, _opts: ChatOptions): Promise<ChatTurn> {
    this.sent.push(structuredClone(messages));
    const message = this.turns[this.i++];
    if (!message) throw new Error("ran out of scripted turns");
    return { message, finishReason: message.tool_calls ? "tool_calls" : "stop", creditsCharged: 10, balance: 100 };
  }
}

const reasoning = [{ type: "reasoning.text", text: "List it first.", format: "unknown", index: 0 }];
const listCall: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }],
  reasoning_details: reasoning,
};

describe("the reasoning behind a tool call", () => {
  it("goes back with the tool result inside the turn, and is gone from the history after it", async () => {
    const client = new ScriptedClient([listCall, { role: "assistant", content: "Nothing here." }]);
    const res = await runAgent(client, "what is here?", { model: "kimi-k2.5", root });

    const second = client.sent[1]!;
    const assistant = second.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_details).toEqual(reasoning);
    // What the next turn starts from, and what a session file holds.
    expect(res.messages.some((m) => m.reasoning_details)).toBe(false);
    expect(res.messages.some((m) => m.tool_calls?.[0]?.id === "c1")).toBe(true);
  });

  it("is collected off the gateway's stream onto the assistant message", async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"list_dir","arguments":"{}"}}],"reasoning_details":[{"type":"reasoning.text","text":"List","index":0}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":" it.","index":0}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"clixad":{"credits_charged":2,"balance":98}}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200 })));
    const turn = await new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "kimi-k2.5");
    expect(turn.message.reasoning_details).toEqual([{ type: "reasoning.text", text: "List it.", index: 0 }]);
  });

  it("is not kept on an answer that called no tools", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi.","reasoning_details":[{"type":"reasoning.text","text":"greet","index":0}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"clixad":{"credits_charged":1,"balance":99}}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200 })));
    const turn = await new GatewayClient(config).chatStream([{ role: "user", content: "hi" }], "kimi-k2.5");
    expect(turn.message.reasoning_details).toBeUndefined();
  });

  it("merges fragments by index and keeps blocks without one apart", () => {
    const acc: Record<string, unknown>[] = [];
    mergeReasoningDetails(acc, [{ type: "reasoning.text", text: "a", index: 0 }]);
    mergeReasoningDetails(acc, [{ type: "reasoning.text", text: "b", index: 0, signature: "s" }]);
    mergeReasoningDetails(acc, [{ type: "reasoning.encrypted", data: "x" }, null, 3]);
    expect(acc).toEqual([
      { type: "reasoning.text", text: "ab", index: 0, signature: "s" },
      { type: "reasoning.encrypted", data: "x" },
    ]);
  });
});

describe("an empty answer", () => {
  const empty: ChatMessage = { role: "assistant", content: null };

  it("is asked for again once, and the empty reply is not kept", async () => {
    const client = new ScriptedClient([empty, { role: "assistant", content: "Here it is." }]);
    const events: AgentEvent[] = [];
    const res = await runAgent(client, "hello", { model: "gemini-2.5-flash-lite", root, onEvent: (e) => events.push(e) });

    expect(res.content).toBe("Here it is.");
    expect(client.sent).toHaveLength(2);
    // The retry is the same request: no empty assistant message in between.
    expect(client.sent[1]).toEqual(client.sent[0]);
    expect(res.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    // Both calls were billed by the provider, so both are metered and shown.
    expect(res.creditsCharged).toBe(20);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
  });

  it("is asked for again after a tool round too", async () => {
    const client = new ScriptedClient([listCall, empty, { role: "assistant", content: "Nothing here." }]);
    const res = await runAgent(client, "what is here?", { model: "kimi-k2.5", root });
    expect(res.content).toBe("Nothing here.");
    expect(client.sent).toHaveLength(3);
  });

  it("is not asked for a third time", async () => {
    const client = new ScriptedClient([empty, empty, { role: "assistant", content: "never reached" }]);
    const res = await runAgent(client, "hello", { model: "gemini-2.5-flash-lite", root });
    expect(client.sent).toHaveLength(2);
    expect(res.content).toBe("");
  });
});
