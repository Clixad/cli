/**
 * A turn that ends on an error keeps the work it did.
 *
 * Reported from a real session: a task ran a few tool rounds, the gateway
 * started refusing every call (its provider balance had run out), the user
 * quit, and `/resume` in the same directory said there was no saved session.
 * `runAgent` threw away the turn's conversation with the error, and the REPL
 * saved a session only when a turn returned, so a first task that failed part
 * way left nothing on disk at all while its edits were on disk.
 *
 * The rules held here: the error is the same object (callers tell the refusals
 * apart with `instanceof`); the conversation it carries can be sent again,
 * every tool call answered; a run that did nothing hands over nothing; a
 * sub-agent's conversation never stands in for the parent's; and every
 * finished round is offered to `onCheckpoint`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_CALL,
  interruptedConversation,
  runAgent,
  SUBAGENT_PROMPT,
  type AgentClient,
} from "../src/agent.ts";
import { MaintenanceError, PaywallError, type ChatMessage, type ChatTurn } from "../src/client.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-interrupted-"));
  writeFileSync(join(root, "a.txt"), "alpha\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Step = Pick<ChatTurn, "message" | "finishReason"> | Error;

/** Answers each call with the next step, or throws it when it is an error. */
function scripted(steps: Step[]): AgentClient & { sent: ChatMessage[][] } {
  let i = 0;
  const sent: ChatMessage[][] = [];
  return {
    sent,
    async chatStream(messages: ChatMessage[]): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      const step = steps[i++];
      if (!step) throw new Error("ran out of scripted steps");
      if (step instanceof Error) throw step;
      return { ...step, creditsCharged: 1, balance: 100 };
    },
  };
}

function calls(...list: [id: string, name: string, args: unknown][]): Step {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: list.map(([id, name, args]) => ({
        id,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    finishReason: "tool_calls",
  };
}

/** Every tool call announced in `messages` has exactly one answer after it. */
function everyCallAnswered(messages: ChatMessage[]): boolean {
  const announced = messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id));
  const answered = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  return announced.length === answered.length && announced.every((id) => answered.includes(id));
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("the run did not fail");
}

describe("a run that ends on an error", () => {
  it("hands over the rounds it finished, with the same error object", async () => {
    const down = new MaintenanceError("Clixad is currently down due to high demand. Please check again later.");
    const client = scripted([
      calls(["c1", "read_file", { path: "a.txt" }]),
      calls(["c2", "list_dir", {}]),
      down,
    ]);

    const err = await failure(runAgent(client, "refactor the thing", { model: "m", root, systemPrompt: "SYS" }));

    expect(err).toBe(down);
    const kept = interruptedConversation(err)!;
    expect(kept.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
    expect(kept[0]!.content).toBe("SYS");
    expect(kept[1]!.content).toBe("refactor the thing");
    expect(kept[3]!.content).toContain("alpha");
    // Exactly the request that failed, so it can be sent again as it stands.
    expect(kept).toEqual(client.sent.at(-1));
    expect(everyCallAnswered(kept)).toBe(true);
  });

  it("hands over nothing when it failed before doing anything", async () => {
    const refused = new PaywallError(0, 100, 1);
    const err = await failure(runAgent(scripted([refused]), "do it", { model: "m", root }));
    expect(err).toBe(refused);
    expect(err).toBeInstanceOf(PaywallError);
    expect(interruptedConversation(err)).toBeUndefined();
  });

  it("answers the tool calls an error inside a tool left open", async () => {
    // The parent asks for a sub-agent and a read in one round; the sub-agent's
    // first model call fails, which is an error raised by a tool.
    const client = scripted([
      calls(["c1", "task", { description: "look around", prompt: "find the entry point" }], ["c2", "read_file", { path: "a.txt" }]),
      new Error("chat failed: 500"),
    ]);

    const err = await failure(runAgent(client, "explain the code", { model: "m", root, systemPrompt: "SYS" }));
    const kept = interruptedConversation(err)!;

    expect(kept[0]!.content).toBe("SYS");
    expect(kept.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(kept.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content])).toEqual([
      ["c1", INTERRUPTED_CALL],
      ["c2", INTERRUPTED_CALL],
    ]);
    expect(everyCallAnswered(kept)).toBe(true);
  });

  it("never hands over a sub-agent's conversation as the parent's", async () => {
    // The sub-agent finishes a round of its own before the failure, so it
    // records a conversation on the error first; the parent must replace it.
    const client = scripted([
      calls(["p1", "task", { description: "look around", prompt: "find the entry point" }]),
      calls(["s1", "list_dir", {}]),
      new Error("chat failed: 500"),
    ]);

    const err = await failure(runAgent(client, "explain the code", { model: "m", root, systemPrompt: "SYS" }));
    const kept = interruptedConversation(err)!;

    expect(kept[0]!.content).toBe("SYS");
    expect(kept.some((m) => m.content === SUBAGENT_PROMPT)).toBe(false);
    expect(kept.some((m) => m.tool_call_id === "s1")).toBe(false);
    expect(kept.at(-1)).toMatchObject({ role: "tool", tool_call_id: "p1", content: INTERRUPTED_CALL });
  });

  it("is not something any other error carries", () => {
    expect(interruptedConversation(new Error("x"))).toBeUndefined();
    expect(interruptedConversation("x")).toBeUndefined();
    expect(interruptedConversation(undefined)).toBeUndefined();
  });
});

describe("onCheckpoint", () => {
  it("is offered every finished round, in a shape that can be sent", async () => {
    const seen: ChatMessage[][] = [];
    const client = scripted([
      calls(["c1", "read_file", { path: "a.txt" }]),
      calls(["c2", "list_dir", {}]),
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    ]);

    const res = await runAgent(client, "look", {
      model: "m",
      root,
      onCheckpoint: (messages) => seen.push(messages),
    });

    expect(seen.map((m) => m.length)).toEqual([4, 6]);
    expect(seen.every(everyCallAnswered)).toBe(true);
    // Each one is what the next call was sent.
    expect(seen[0]).toEqual(client.sent[1]);
    expect(seen[1]).toEqual(client.sent[2]);
    // The finished turn is the caller's to save, as before.
    expect(res.messages).toHaveLength(7);
  });

  it("is not called for a turn answered without a tool", async () => {
    let called = 0;
    await runAgent(scripted([{ message: { role: "assistant", content: "hi" }, finishReason: "stop" }]), "hello", {
      model: "m",
      root,
      onCheckpoint: () => called++,
    });
    expect(called).toBe(0);
  });
});
