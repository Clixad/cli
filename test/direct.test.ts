/**
 * The limit valve: carrying on with the user's own OpenRouter key or a local
 * model, without Clixad's credits. The client speaks the same OpenAI-compatible
 * stream the agent loop expects, goes nowhere near the gateway, and says what
 * went wrong in a sentence rather than with a provider's raw body.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DirectClient,
  LOCAL_CONTEXT_TOKENS,
  OPENROUTER_BASE,
  directMeta,
  localBackend,
  looksLikeOpenRouterKey,
  maskKey,
  ownKeyBackend,
  ownKeyOf,
  probeLocal,
  savedDirectBackend,
  type DirectBackend,
} from "../src/direct.ts";

function sse(frames: unknown[]): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const own: DirectBackend = {
  kind: "own_key",
  baseUrl: OPENROUTER_BASE,
  apiKey: "sk-or-test-key-for-the-suite-only",
  model: "deepseek/deepseek-v4.1-flash",
  label: "deepseek-v4.1-flash on your key",
  contextTokens: 24_000,
};

describe("the direct client", () => {
  it("streams text and tool calls from the user's own provider, charges nothing and keeps the balance", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sse([
        { choices: [{ delta: { content: "Looking " } }] },
        { choices: [{ delta: { content: "now." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 } },
      ]);
    }) as unknown as typeof fetch;
    const client = new DirectClient(own, () => 4_321, fetchImpl);
    const deltas: string[] = [];
    const turn = await client.chatStream([{ role: "user", content: "hi" }], "deepseek-v4.1-flash", {
      tools: [{ type: "function" }],
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas.join("")).toBe("Looking now.");
    expect(turn.message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }]);
    expect(turn).toMatchObject({ finishReason: "tool_calls", creditsCharged: 0, balance: 4_321 });
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${own.apiKey}`);
    const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", stream: true, stream_options: { include_usage: true } });
    expect(client.takeUsage()).toEqual({ calls: 1, inputTokens: 900, outputTokens: 40 });
    expect(client.takeUsage()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("sends a local server no key and nothing OpenRouter-only", async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      headers = init.headers as Record<string, string>;
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    }) as unknown as typeof fetch;
    const local = localBackend("http://127.0.0.1:11434/v1", "qwen2.5-coder:7b");
    const turn = await new DirectClient(local, () => 0, fetchImpl).chatStream([{ role: "user", content: "hi" }], "x");
    expect(turn.message.content).toBe("ok");
    expect(headers.Authorization).toBeUndefined();
    expect(body.usage).toBeUndefined();
    expect(body.model).toBe("qwen2.5-coder:7b");
    expect(local.contextTokens).toBe(LOCAL_CONTEXT_TOKENS);
  });

  it("says what a refusal means in a sentence, never the provider's page", async () => {
    const page = "<html><head><title>401 Unauthorized</title></head><body>" + "x".repeat(5_000) + "</body></html>";
    const answer = (status: number, text: string) => vi.fn(async () => new Response(text, { status })) as unknown as typeof fetch;
    const refused = await new DirectClient(own, () => 0, answer(401, page)).chatStream([], "m").catch((e: Error) => e.message);
    expect(refused).toMatch(/^OpenRouter refused your key \(401\)/);
    expect(refused).toContain("/key off");
    expect(String(refused).length).toBeLessThan(400);
    expect(refused).not.toContain("<html");
    const broke = await new DirectClient(own, () => 0, answer(402, JSON.stringify({ error: { message: "Insufficient credits" } })))
      .chatStream([], "m")
      .catch((e: Error) => e.message);
    expect(broke).toMatch(/out of credits \(402\): Insufficient credits/);
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const local = await new DirectClient(localBackend("http://127.0.0.1:11434/v1", "m"), () => 0, down).chatStream([], "m").catch((e: Error) => e.message);
    expect(local).toMatch(/local model server at http:\/\/127\.0\.0\.1:11434\/v1 is not answering/);
  });

  it("lets esc through as an abort, not as an error of its own", async () => {
    const ac = new AbortController();
    ac.abort();
    const aborting = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const err = await new DirectClient(own, () => 0, aborting).chatStream([], "m", { signal: ac.signal }).catch((e: Error) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("finding the key and the local servers", () => {
  it("uses only a key saved with /key, never one that happens to be in the environment", () => {
    expect(ownKeyOf({ ownKey: " sk-or-saved " })).toBe("sk-or-saved");
    expect(ownKeyOf({})).toBeUndefined();
    expect(looksLikeOpenRouterKey("sk-or-test-key-for-the-suite-only")).toBe(true);
    expect(looksLikeOpenRouterKey("not-a-key")).toBe(false);
    expect(maskKey("sk-or-test-key-for-the-suite-only")).toBe("sk-or-tes…only");
  });

  it("carries on with the same model on the user's key, at the window Clixad serves it under", () => {
    expect(ownKeyBackend("k", { id: "claude-haiku-5.5", openrouter_slug: "anthropic/claude-haiku-5.5", context_window: 24_000 })).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      contextTokens: 24_000,
      baseUrl: OPENROUTER_BASE,
    });
    expect(ownKeyBackend("k", { id: "x" })).toBeUndefined();
  });

  it("lists the local servers that answer, and skips the ones that do not", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("http://127.0.0.1:11434")) return new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3.2" }] }));
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeLocal(undefined, fetchImpl)).toEqual([
      { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen2.5-coder:7b", "llama3.2"] },
    ]);
  });

  it("rebuilds the saved backend at the next start, and drops an own-key one whose key is gone", () => {
    expect(savedDirectBackend({ direct: { kind: "local", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" } }, {})).toMatchObject({
      kind: "local",
      model: "llama3.2",
    });
    expect(savedDirectBackend({ direct: { kind: "own_key", model: "deepseek/deepseek-v4.1-flash" } }, {})).toBeNull();
    expect(
      savedDirectBackend({ ownKey: "sk-or-test-key-for-the-suite-only", direct: { kind: "own_key", model: "deepseek/deepseek-v4.1-flash", contextTokens: 24_000 } }, {}),
    ).toMatchObject({ kind: "own_key", apiKey: "sk-or-test-key-for-the-suite-only", contextTokens: 24_000 });
  });

  it("says on the meta line where the turn ran and that no credits were used", () => {
    expect(directMeta("own_key", { calls: 2, inputTokens: 1_000, outputTokens: 234 })).toBe("[your OpenRouter key · 1,234 tokens · no Clixad credits]");
    expect(directMeta("local", { calls: 1, inputTokens: 0, outputTokens: 0 })).toBe("[local model · no Clixad credits]");
  });
});
