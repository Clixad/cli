/**
 * `/effort` in the CLI: the vocabulary, the one rule it shares with the
 * gateway, saving per model, and what goes on the wire.
 *
 * That the CLI's copy of the rule matches the gateway's for every model and
 * level is checked where the gateway's is, `test/monorepo/effort-engine.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effortLabel, parseEffortArg, resolveEffort } from "../src/effort.ts";
import { GatewayClient } from "../src/client.ts";

// `homedir()` is mocked for config.test.ts's reason: libuv does not see a
// `process.env.HOME` written inside a vitest worker.
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

describe("the CLI's copy of the rule", () => {
  it("treats a gateway that sends no settings as a model with none", () => {
    expect(resolveEffort({}, "high")).toBeUndefined();
    expect(resolveEffort(undefined, "high")).toBeUndefined();
  });
});

describe("what /effort accepts", () => {
  it("reads the scale, auto and OpenAI's none", () => {
    expect(parseEffortArg("High")).toBe("high");
    expect(parseEffortArg("auto")).toBe("auto");
    expect(parseEffortArg("default")).toBe("auto");
    expect(parseEffortArg("none")).toBe("off");
    expect(parseEffortArg("turbo")).toBeUndefined();
  });

  it("words off and on as thinking, and the rest as effort", () => {
    expect(effortLabel("off")).toBe("thinking off");
    expect(effortLabel("on")).toBe("thinking on");
    expect(effortLabel("xhigh")).toBe("xhigh effort");
  });
});

describe("saving per model", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "adg-effort-"));
    hoisted.home = home;
    vi.resetModules();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const file = () => join(home, ".clixad", "config.json");
  const stored = () => JSON.parse(readFileSync(file(), "utf8")) as { effort?: Record<string, string> };

  it("keeps one setting per model and drops a model that goes back to auto", async () => {
    const { loadConfig, saveEffort } = await import("../src/config.ts");
    const config = loadConfig();
    saveEffort(config, "kimi-k3", "low");
    saveEffort(config, "claude-opus-5.5", "max");
    expect(stored().effort).toEqual({ "kimi-k3": "low", "claude-opus-5.5": "max" });
    saveEffort(config, "kimi-k3", undefined);
    expect(stored().effort).toEqual({ "claude-opus-5.5": "max" });
    saveEffort(config, "claude-opus-5.5", undefined);
    expect(stored()).not.toHaveProperty("effort");
  });

  it("does not undo a setting another session saved for a different model", async () => {
    const { loadConfig, saveEffort } = await import("../src/config.ts");
    mkdirSync(join(home, ".clixad"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ model: "kimi-k3" }), "utf8");
    const config = loadConfig(); // this session read no settings at all
    // Another session saves one in the meantime.
    writeFileSync(file(), JSON.stringify({ model: "kimi-k3", effort: { "gpt-6-sol": "high" } }), "utf8");
    saveEffort(config, "kimi-k3", "low");
    expect(stored().effort).toEqual({ "gpt-6-sol": "high", "kimi-k3": "low" });
  });
});

describe("what goes on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  function capture(): Record<string, unknown>[] {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        const sse =
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"clixad":{"credits_charged":1,"balance":9}}\n\ndata: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    return bodies;
  }

  const client = () =>
    new GatewayClient({ gatewayUrl: "http://127.0.0.1:8787", dashboardUrl: "http://127.0.0.1:8788", token: "adg_t", model: "kimi-k3" });

  it("sends reasoning_effort when a setting is chosen", async () => {
    const bodies = capture();
    await client().chatStream([{ role: "user", content: "hi" }], "kimi-k3", { effort: "low" });
    expect(bodies[0]!.reasoning_effort).toBe("low");
  });

  it("sends no such field without one, so the request is what it always was", async () => {
    const bodies = capture();
    await client().chatStream([{ role: "user", content: "hi" }], "kimi-k3", {});
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });
});
