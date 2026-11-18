import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutOffArguments, runAgent, type AgentClient, type AgentEvent } from "../src/agent.ts";
import { DEFAULT_MAX_STEPS, REPEAT_LIMIT } from "../src/steps.ts";
import { messageText } from "../src/client.ts";
import type { ChatMessage, ChatOptions, ChatTurn } from "../src/client.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adg-agent-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A scripted gateway: returns queued assistant turns and records what it was sent. */
class ScriptedClient implements AgentClient {
  sent: ChatMessage[][] = [];
  private i = 0;
  constructor(private turns: Pick<ChatTurn, "message" | "finishReason">[]) {}
  async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
    this.sent.push(structuredClone(messages));
    const t = this.turns[this.i++];
    if (!t) throw new Error("ScriptedClient ran out of scripted turns");
    // Behave like the real stream: hand the text over in chunks first.
    for (const chunk of messageText(t.message).match(/.{1,8}/gs) ?? []) opts.onDelta?.(chunk);
    return { ...t, creditsCharged: 10, balance: 500 - this.i * 10 };
  }
}

function toolTurn(id: string, name: string, args: unknown): Pick<ChatTurn, "message" | "finishReason"> {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
  };
}

describe("agent loop", () => {
  it("runs multi-round tool calls and feeds results back", async () => {
    const client = new ScriptedClient([
      toolTurn("c1", "write_file", { path: "out.txt", content: "hello" }),
      toolTurn("c2", "read_file", { path: "out.txt" }),
      { message: { role: "assistant", content: "Done — the file says hello." }, finishReason: "stop" },
    ]);

    const res = await runAgent(client, "create out.txt", { model: "m", root });

    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hello");
    expect(res.content).toContain("Done");
    expect(res.steps).toBe(3);
    expect(res.creditsCharged).toBe(30); // 3 metered round-trips × 10

    // The read_file result must have been sent back on the final call — line
    // numbered, which is how the model gets to cite a place in a file.
    const lastSent = client.sent.at(-1)!;
    expect(lastSent.some((m) => m.role === "tool" && m.content === "    1\thello")).toBe(true);
  });

  it("streams text deltas and reports tool calls as events", async () => {
    const client = new ScriptedClient([
      toolTurn("c1", "list_dir", {}),
      { message: { role: "assistant", content: "All done here." }, finishReason: "stop" },
    ]);

    const events: AgentEvent[] = [];
    await runAgent(client, "look around", { model: "m", root, onEvent: (e) => events.push(e) });

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("final");
    const streamed = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(streamed).toBe("All done here.");
  });

  it("honors the permission gate and reports the denial to the model", async () => {
    const client = new ScriptedClient([
      toolTurn("c1", "write_file", { path: "no.txt", content: "x" }),
      { message: { role: "assistant", content: "I could not write the file." }, finishReason: "stop" },
    ]);

    const res = await runAgent(client, "write a file", {
      model: "m",
      root,
      permit: async () => ({ allowed: false, reason: "the user denied it", notice: "denied by you" }),
    });

    expect(existsSync(join(root, "no.txt"))).toBe(false);
    const toolMsg = client.sent.at(-1)!.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("denied");
    expect(res.content).toContain("could not write");
  });

  it("turns malformed tool arguments into an error instead of throwing", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{not json" } }],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "handled" }, finishReason: "stop" },
    ]);

    const res = await runAgent(client, "read", { model: "m", root });
    const toolMsg = client.sent.at(-1)!.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("invalid JSON");
    expect(res.steps).toBe(2);
  });

  it("stops when aborted and still answers every announced tool call", async () => {
    const ac = new AbortController();
    const client: AgentClient = {
      async chatStream(): Promise<ChatTurn> {
        ac.abort(); // the user hits Esc while the tools would run
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "list_dir", arguments: "{}" } },
              { id: "b", type: "function", function: { name: "list_dir", arguments: "{}" } },
            ],
          },
          finishReason: "tool_calls",
          creditsCharged: 5,
          balance: 100,
        };
      },
    };

    const res = await runAgent(client, "go", { model: "m", root, signal: ac.signal });
    expect(res.stopped).toBe("aborted");
    const toolMessages = res.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]!.content).toContain("cancelled");
  });

  it("stops at the step budget when the model never finishes", async () => {
    const loopClient: AgentClient = {
      async chatStream(): Promise<ChatTurn> {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "list_dir", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 0,
        };
      },
    };
    const res = await runAgent(loopClient, "loop forever", { model: "m", root, maxSteps: 3 });
    expect(res.steps).toBe(3);
    expect(res.stopped).toBe("max_steps");
  });

  it("goes past the old ceiling of 16 calls on its own", async () => {
    // Twenty-four rounds, each looking at something different, then an answer:
    // the shape of a medium task, which used to stop at 16 and ask to be
    // continued.
    const client = new ScriptedClient([
      ...Array.from({ length: 24 }, (_, i) => toolTurn(`g${i}`, "glob", { pattern: `part-${i}-*` })),
      { message: { role: "assistant", content: "All done." }, finishReason: "stop" },
    ]);
    const res = await runAgent(client, "a long task", { model: "m", root });
    expect(res.stopped).toBeUndefined();
    expect(res.content).toBe("All done.");
    expect(res.steps).toBe(25);
  });

  it("runs up to DEFAULT_MAX_STEPS calls when no ceiling is given, and says so", async () => {
    let n = 0;
    const events: AgentEvent[] = [];
    const client: AgentClient = {
      async chatStream(): Promise<ChatTurn> {
        n++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `c${n}`, type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: `x${n}*` }) } }],
          },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 0,
        };
      },
    };
    const res = await runAgent(client, "never ends", { model: "m", root, onEvent: (e) => events.push(e) });
    expect(n).toBe(DEFAULT_MAX_STEPS);
    expect(res.stopped).toBe("max_steps");
    expect(res.steps).toBe(DEFAULT_MAX_STEPS);
    expect(events.at(-1)).toEqual({ type: "max_steps", steps: DEFAULT_MAX_STEPS, limit: DEFAULT_MAX_STEPS });
    // Every call answered: the conversation can be continued as it stands.
    const asked = res.messages.flatMap((m) => m.tool_calls ?? []).length;
    expect(res.messages.filter((m) => m.role === "tool")).toHaveLength(asked);
  });

  it("stops an agent that repeats the same calls with the same results", async () => {
    const events: AgentEvent[] = [];
    const client = new ScriptedClient(
      Array.from({ length: 30 }, (_, i) => toolTurn(`r${i}`, "list_dir", { path: "." })),
    );
    const res = await runAgent(client, "loop", { model: "m", root, onEvent: (e) => events.push(e) });
    expect(res.stopped).toBe("repeating");
    expect(client.sent).toHaveLength(REPEAT_LIMIT);
    expect(res.steps).toBe(REPEAT_LIMIT);
    expect(events.at(-1)).toEqual({ type: "repeating", steps: REPEAT_LIMIT });
    expect(res.creditsCharged).toBe(10 * REPEAT_LIMIT);
  });

  it("does not count a repeated call whose result changed as going in circles", async () => {
    // The same command three times with the file changing in between is work,
    // not a loop: the results differ.
    const writes = Array.from({ length: 6 }, (_, i) => [
      toolTurn(`w${i}`, "write_file", { path: "n.txt", content: `v${i}` }),
      toolTurn(`r${i}`, "read_file", { path: "n.txt" }),
    ]).flat();
    const client = new ScriptedClient([
      ...writes,
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    ]);
    const res = await runAgent(client, "edit and check", { model: "m", root });
    expect(res.stopped).toBeUndefined();
    expect(res.content).toBe("done");
  });

  it("tells the model why a tool call cut off at the output limit did not run", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "w", type: "function", function: { name: "write_file", arguments: '{"path":"big.ts","content":"const a = ' } },
          ],
        },
        finishReason: "length",
      },
      { message: { role: "assistant", content: "ok" }, finishReason: "stop" },
    ]);
    await runAgent(client, "write a big file", { model: "m", root });
    const result = client.sent[1]!.find((m) => m.role === "tool");
    expect(messageText(result!)).toBe(cutOffArguments("write_file"));
    expect(messageText(result!)).toContain("reached the output limit");
  });

  it("still calls arguments that do not parse invalid when the reply was not cut off", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: "{oops" } }],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "ok" }, finishReason: "stop" },
    ]);
    await runAgent(client, "read", { model: "m", root });
    const result = client.sent[1]!.find((m) => m.role === "tool");
    expect(messageText(result!)).toBe("error: invalid JSON arguments for read_file");
  });

  it("marks a final answer that reached the output limit", async () => {
    const cut = new ScriptedClient([{ message: { role: "assistant", content: "The first half of" }, finishReason: "length" }]);
    expect((await runAgent(cut, "explain", { model: "m", root })).cutOff).toBe(true);
    const whole = new ScriptedClient([{ message: { role: "assistant", content: "All of it." }, finishReason: "stop" }]);
    expect((await runAgent(whole, "explain", { model: "m", root })).cutOff).toBeUndefined();
  });

  it("continues an existing conversation", async () => {
    const client = new ScriptedClient([{ message: { role: "assistant", content: "ok" }, finishReason: "stop" }]);
    const history: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ];

    const res = await runAgent(client, "second question", { model: "m", root, history });

    const sent = client.sent[0]!;
    expect(sent[0]!.role).toBe("system");
    expect(sent.map((m) => m.content)).toEqual([
      expect.stringContaining("Clixad"),
      "first question",
      "first answer",
      "second question",
    ]);
    expect(res.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
});
