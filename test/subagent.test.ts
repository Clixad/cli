/**
 * Sub-agents, and images, which are the two things that change the *shape* of a
 * conversation rather than adding another tool to it.
 *
 * A sub-agent is the only tool here that makes a task cheaper: the forty files
 * it opened to find the three that mattered stay in its own context and never
 * enter this one. So the test that matters is not "it returns a string" — it is
 * that the parent's conversation is clean afterwards and the credits are still
 * counted. Both halves, because either one alone is a bug: leaking the reads
 * removes the benefit, and losing the credits means a turn that quietly billed
 * for work it never mentioned.
 *
 * An image is the mirror image of that problem. A `tool` message in an
 * OpenAI-compatible API is a string, so the bytes cannot ride in the result —
 * they travel as their own user message, and it has to land *after* every
 * tool_call has been answered or the request is malformed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent, SUBAGENT_PROMPT, type AgentClient, type AgentEvent } from "../src/agent.ts";
import { messageText, type ChatMessage, type ChatOptions, type ChatTurn } from "../src/client.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-sub-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 5)]);

interface Recorded {
  messages: ChatMessage[];
  tools: string[];
}

/**
 * A scripted gateway that answers by *system prompt*.
 *
 * Which is what makes it possible to script a parent and its sub-agent in one
 * test: the two runs are distinguishable only by the prompt they open with, and
 * that is exactly the thing under test.
 */
class TwoLevelClient implements AgentClient {
  calls: Recorded[] = [];
  private counts = new Map<string, number>();

  constructor(private script: Record<"parent" | "sub", Pick<ChatTurn, "message" | "finishReason">[]>) {}

  async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
    const system = messageText(messages[0]!);
    const which: "parent" | "sub" = system.startsWith("You are a research sub-agent") ? "sub" : "parent";
    this.calls.push({
      messages: structuredClone(messages),
      tools: ((opts.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name),
    });
    const n = this.counts.get(which) ?? 0;
    this.counts.set(which, n + 1);
    const turn = this.script[which][n];
    if (!turn) throw new Error(`no scripted ${which} turn ${n}`);
    for (const chunk of messageText(turn.message).match(/.{1,8}/gs) ?? []) opts.onDelta?.(chunk);
    // Distinct amounts so the two can be told apart in the totals.
    return { ...turn, creditsCharged: which === "parent" ? 100 : 7, balance: 5000 };
  }

  /** Every call whose system prompt marks it as belonging to `which`. */
  of(which: "parent" | "sub"): Recorded[] {
    return this.calls.filter((c) =>
      which === "sub"
        ? messageText(c.messages[0]!).startsWith("You are a research sub-agent")
        : !messageText(c.messages[0]!).startsWith("You are a research sub-agent"),
    );
  }
}

const toolTurn = (id: string, name: string, args: unknown): Pick<ChatTurn, "message" | "finishReason"> => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  },
  finishReason: "tool_calls",
});

const say = (text: string): Pick<ChatTurn, "message" | "finishReason"> => ({
  message: { role: "assistant", content: text },
  finishReason: "stop",
});

describe("task", () => {
  it("keeps the sub-agent's reads out of the parent's conversation", async () => {
    writeFileSync(join(root, "secret-detail.txt"), "the retry count is 5");
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "find it", prompt: "Where is the retry count?" }), say("It is 5.")],
      sub: [toolTurn("s1", "read_file", { path: "secret-detail.txt" }), say("It is set to 5 in secret-detail.txt:1.")],
    });

    const res = await runAgent(client, "what is the retry count?", { model: "m", root });

    // The parent's last request carries the sub-agent's *answer*…
    const parentLast = client.of("parent").at(-1)!.messages;
    const toolResult = parentLast.find((m) => m.role === "tool");
    expect(messageText(toolResult!)).toContain("secret-detail.txt:1");
    // …and none of the file contents it opened to get there.
    expect(JSON.stringify(parentLast)).not.toContain("the retry count is 5");
    expect(res.content).toBe("It is 5.");
  });

  it("counts the sub-agent's credits into the turn", async () => {
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look", prompt: "look at something" }), say("done")],
      sub: [say("found nothing interesting")],
    });
    const res = await runAgent(client, "go", { model: "m", root });
    // Two parent round-trips at 100, one sub-agent round-trip at 7. A turn that
    // billed for a sub-agent it never mentioned would be the worst kind of
    // surprise on a metered product.
    expect(res.creditsCharged).toBe(207);
  });

  it("reports the sub-agent's usage so the balance on screen keeps up", async () => {
    const events: AgentEvent[] = [];
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look", prompt: "look" }), say("done")],
      sub: [say("nothing")],
    });
    await runAgent(client, "go", { model: "m", root, onEvent: (e) => events.push(e) });
    const usage = events.filter((e) => e.type === "usage") as { creditsCharged: number }[];
    expect(usage.map((u) => u.creditsCharged)).toContain(7);
  });

  it("shows the sub-agent's progress under the tool call that started it", async () => {
    const events: AgentEvent[] = [];
    writeFileSync(join(root, "a.txt"), "x");
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "read a.txt", prompt: "read it" }), say("done")],
      sub: [toolTurn("s1", "read_file", { path: "a.txt" }), say("it says x")],
    });
    await runAgent(client, "go", { model: "m", root, onEvent: (e) => events.push(e) });
    const output = events.filter((e) => e.type === "tool_output") as { id: string; chunk: string }[];
    expect(output.every((e) => e.id === "t1")).toBe(true);
    expect(output.map((e) => e.chunk).join()).toContain("read_file a.txt");
  });

  it("gives the sub-agent read-only tools and no way to spawn another", async () => {
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look", prompt: "look" }), say("done")],
      sub: [say("nothing")],
    });
    await runAgent(client, "go", { model: "m", root, webSearchAvailable: true });
    const advertised = client.of("sub")[0]!.tools;
    for (const forbidden of ["write_file", "edit_file", "run_command", "task", "ask_user", "exit_plan_mode"]) {
      expect(advertised, forbidden).not.toContain(forbidden);
    }
    for (const allowed of ["read_file", "glob", "grep", "web_search", "web_fetch"]) {
      expect(advertised, allowed).toContain(allowed);
    }
  });

  it("opens the sub-agent on its own prompt, not the parent's", async () => {
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look", prompt: "the sub task" }), say("done")],
      sub: [say("nothing")],
    });
    await runAgent(client, "go", { model: "m", root, systemPrompt: "PARENT PROMPT", webSearchAvailable: true });
    const sub = client.of("sub")[0]!.messages;
    expect(messageText(sub[0]!)).toBe(SUBAGENT_PROMPT);
    // Its whole conversation is the one task, with none of the parent's history.
    expect(sub).toHaveLength(2);
    expect(messageText(sub[1]!)).toBe("the sub task");
  });

  it("says the answer may be incomplete when the sub-agent runs out of steps", async () => {
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "loop", prompt: "loop" }), say("done")],
      // More tool turns than SUBAGENT_MAX_STEPS, so it never gets to answer.
      sub: Array.from({ length: 20 }, (_, i) => toolTurn(`s${i}`, "list_dir", { path: "." })),
    });
    await runAgent(client, "go", { model: "m", root });
    const result = client.of("parent").at(-1)!.messages.find((m) => m.role === "tool");
    expect(messageText(result!)).toContain("step limit");
  });

  it("inherits the gateway's search key, rather than being told to use a tool that is gone", async () => {
    // Its own prompt says it can "search and fetch the web". On a gateway with
    // no key that sentence would cost it its whole step budget to disprove.
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look", prompt: "look" }), say("done")],
      sub: [say("nothing")],
    });
    await runAgent(client, "go", { model: "m", root });
    const sub = client.of("sub")[0]!;
    expect(sub.tools).not.toContain("web_search");
    expect(sub.tools).toContain("web_fetch");
    expect(messageText(sub.messages[0]!)).toContain("Web search is not available");
    expect(messageText(sub.messages[0]!)).toContain("https://registry.npmjs.org/");
  });

  it("passes web search down, so a sub-agent can research", async () => {
    let searched = "";
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "task", { description: "look up", prompt: "look it up" }), say("done")],
      sub: [toolTurn("s1", "web_search", { query: "vitest fake timers" }), say("found it")],
    });
    await runAgent(client, "go", {
      model: "m",
      root,
      webSearchAvailable: true,
      webSearch: async (query) => {
        searched = query;
        return [{ title: "Vitest", url: "https://vitest.dev/", snippet: "docs" }];
      },
    });
    expect(searched).toBe("vitest fake timers");
  });
});

describe("images from a tool", () => {
  it("arrive as their own user message, after every tool_call is answered", async () => {
    writeFileSync(join(root, "shot.png"), PNG);
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "read_file", { path: "shot.png" }), say("I can see it.")],
      sub: [],
    });
    await runAgent(client, "look at shot.png", { model: "m", root });

    const last = client.of("parent").at(-1)!.messages;
    const image = last.at(-1)!;
    expect(image.role).toBe("user");
    expect(Array.isArray(image.content)).toBe(true);
    const parts = image.content as { type: string; image_url?: { url: string } }[];
    expect(parts[0]!.type).toBe("text");
    expect(parts[1]!.image_url!.url).toContain("data:image/png;base64,");

    // Malformed otherwise: a user message may not sit between an assistant's
    // tool_calls and their results.
    const toolIndex = last.findIndex((m) => m.role === "tool");
    expect(last.indexOf(image)).toBeGreaterThan(toolIndex);
  });

  it("are announced, because the user cannot see them in the transcript", async () => {
    writeFileSync(join(root, "shot.png"), PNG);
    const events: AgentEvent[] = [];
    const client = new TwoLevelClient({
      parent: [toolTurn("t1", "read_file", { path: "shot.png" }), say("ok")],
      sub: [],
    });
    await runAgent(client, "look", { model: "m", root, onEvent: (e) => events.push(e) });
    const attachment = events.find((e) => e.type === "attachment") as { labels: string[] } | undefined;
    expect(attachment?.labels).toEqual(["shot.png"]);
  });

  it("ride on the first user message when the user attached them", async () => {
    const client = new TwoLevelClient({ parent: [say("seen")], sub: [] });
    await runAgent(client, "why does this look wrong?", {
      model: "m",
      root,
      attachments: [{ mimeType: "image/png", data: PNG.toString("base64"), label: "bug.png" }],
    });
    const first = client.of("parent")[0]!.messages.at(-1)!;
    const parts = first.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
  });
});
