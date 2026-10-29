/**
 * Plan mode, as a closed loop.
 *
 * It used to be a dead end. The refusal told the model to "describe the plan
 * instead and let the user approve it"; the model dutifully asked for approval;
 * and there was nothing to approve with. The only exit was shift+tab followed
 * by retyping the request — which landed on a conversation where the model's
 * own announced plan was already sitting, so it followed through on that rather
 * than re-reading the new message. That is how "write back test successful if
 * you can read this" turned into a file, twice.
 *
 * Three things fix it and all three are pinned here: the model is *told* the
 * mode instead of paying a round-trip to discover it, the write tools are
 * removed rather than merely refused, and `exit_plan_mode` approves in the same
 * turn so nothing has to be retyped.
 */
import React from "react";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import { runAgent } from "../src/agent.ts";
import { modeInstruction } from "../src/permissions.ts";
import { TOOL_SCHEMA, toolSchemaFor } from "../src/tools.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};

const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 2,
  earned_usd_today: 0.04,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};

const catalog = [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }];
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";

const names = (schema: readonly unknown[]) =>
  schema.map((t) => (t as { function: { name: string } }).function.name);

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("the tools plan mode advertises", () => {
  it("removes the write tools rather than only refusing them", () => {
    const planning = names(toolSchemaFor("plan"));
    for (const write of ["write_file", "edit_file", "run_command", "kill_shell"]) {
      expect(planning).not.toContain(write);
    }
    // Reading is the whole point of the mode, so it keeps all of it.
    for (const read of ["read_file", "list_dir", "glob", "grep"]) {
      expect(planning).toContain(read);
    }
    expect(planning).toContain("exit_plan_mode");
  });

  it("keeps research available, because planning is when you look things up", () => {
    // A read-only mode that could not read the documentation would be the mode
    // in which the agent guesses, which is the opposite of what it is for.
    const planning = names(toolSchemaFor("plan", [], { webSearch: true }));
    for (const tool of ["web_search", "web_fetch", "task", "todo_write", "ask_user"]) {
      expect(planning).toContain(tool);
    }
  });

  it("leaves the other modes exactly as they were, with no way out to offer", () => {
    for (const mode of ["normal", "acceptEdits"] as const) {
      // With search configured; without it `web_search` is dropped, which is
      // its own test in tools-research.test.ts.
      expect(toolSchemaFor(mode, [], { webSearch: true })).toStrictEqual([...TOOL_SCHEMA]);
      expect(names(toolSchemaFor(mode))).not.toContain("exit_plan_mode");
    }
  });

  it("appends MCP tools outside plan mode and withholds them inside it", () => {
    // What a server's tool does is its own business — `search_issues` may sit
    // next to `create_issue` — so a mode that promises to change nothing cannot
    // make that promise about somebody else's program.
    const mcp = [{ type: "function", function: { name: "mcp__demo__search", parameters: {} } }];
    expect(names(toolSchemaFor("normal", mcp))).toContain("mcp__demo__search");
    expect(names(toolSchemaFor("plan", mcp))).not.toContain("mcp__demo__search");
  });
});

describe("what the model is told about the mode", () => {
  it("names the mode it is actually in", () => {
    expect(modeInstruction("plan")).toContain("plan (read-only)");
    expect(modeInstruction("acceptEdits")).toContain("auto-accept edits");
    expect(modeInstruction("normal")).toContain("ask before edits");
  });

  it("points plan mode at the tool rather than at prose the user cannot answer", () => {
    const text = modeInstruction("plan");
    expect(text).toContain("exit_plan_mode");
    expect(text).toContain("Do not ask for approval in prose");
  });
});

describe("exit_plan_mode inside a run", () => {
  it("asks per model call, so approval restores the write tools mid-turn", async () => {
    const advertised: string[][] = [];
    let mode: "plan" | "acceptEdits" = "plan";
    const turns: ChatTurn[] = [
      {
        message: { role: "assistant", content: null, tool_calls: [call("p1", "exit_plan_mode", { plan: "Edit a.ts" })] },
        finishReason: "tool_calls",
        creditsCharged: 1,
        balance: 1,
      },
      {
        message: { role: "assistant", content: "Done." },
        finishReason: "stop",
        creditsCharged: 1,
        balance: 1,
      },
    ];
    let i = 0;
    const client = {
      async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
        advertised.push(names(opts.tools as readonly unknown[]));
        return turns[i++]!;
      },
    };

    const result = await runAgent(client, "do it", {
      model: "m",
      root: process.cwd(),
      tools: () => toolSchemaFor(mode),
      approvePlan: async () => {
        mode = "acceptEdits";
        return "acceptEdits";
      },
    });

    expect(advertised[0]).toContain("exit_plan_mode");
    expect(advertised[0]).not.toContain("write_file");
    // The second call is in the same turn and already has the write tools back.
    expect(advertised[1]).toContain("write_file");
    expect(advertised[1]).not.toContain("exit_plan_mode");
    expect(result.content).toBe("Done.");
  });

  it("tells the model to stay read-only when the plan is not approved", async () => {
    const seen: ChatMessage[][] = [];
    const turns: ChatTurn[] = [
      {
        message: { role: "assistant", content: null, tool_calls: [call("p1", "exit_plan_mode", { plan: "Edit a.ts" })] },
        finishReason: "tool_calls",
        creditsCharged: 1,
        balance: 1,
      },
      { message: { role: "assistant", content: "What would you change?" }, finishReason: "stop", creditsCharged: 1, balance: 1 },
    ];
    let i = 0;
    const client = {
      async chatStream(m: ChatMessage[]): Promise<ChatTurn> {
        seen.push([...m]);
        return turns[i++]!;
      },
    };

    await runAgent(client, "do it", {
      model: "m",
      root: process.cwd(),
      tools: () => toolSchemaFor("plan"),
      approvePlan: async () => "keepPlanning",
    });

    const toolReply = seen[1]!.find((m) => m.role === "tool");
    expect(toolReply?.content).toContain("did not approve");
    expect(toolReply?.content).toContain("Stay read-only");
  });

  it("refuses to pretend a plan was approved when nothing can approve one", async () => {
    // `clixad -p` runs with no UI. Silently continuing would be the worst
    // possible answer: the model would act on an approval nobody gave.
    const seen: ChatMessage[][] = [];
    const turns: ChatTurn[] = [
      {
        message: { role: "assistant", content: null, tool_calls: [call("p1", "exit_plan_mode", { plan: "Edit a.ts" })] },
        finishReason: "tool_calls",
        creditsCharged: 1,
        balance: 1,
      },
      { message: { role: "assistant", content: "Here is the plan." }, finishReason: "stop", creditsCharged: 1, balance: 1 },
    ];
    let i = 0;
    const client = {
      async chatStream(m: ChatMessage[]): Promise<ChatTurn> {
        seen.push([...m]);
        return turns[i++]!;
      },
    };

    await runAgent(client, "do it", { model: "m", root: process.cwd(), tools: () => toolSchemaFor("plan") });

    const toolReply = seen[1]!.find((m) => m.role === "tool");
    expect(toolReply?.content).toContain("no one to approve");
  });
});

describe("the plan dialog in the REPL", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-plan-"));
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  /** Proposes a plan, then writes a file once it is allowed to. */
  const planningClient = () => {
    const systemPrompts: string[] = [];
    const turns: ChatTurn[] = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("p1", "exit_plan_mode", { plan: "- create out.txt\n- then stop" })],
        },
        finishReason: "tool_calls",
        creditsCharged: 7,
        balance: 4981,
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("w1", "write_file", { path: "out.txt", content: "done" })],
        },
        finishReason: "tool_calls",
        creditsCharged: 7,
        balance: 4981,
      },
      { message: { role: "assistant", content: "Created out.txt." }, finishReason: "stop", creditsCharged: 7, balance: 4981 },
    ];
    let i = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(m: ChatMessage[]): Promise<ChatTurn> {
        systemPrompts.push(String(m[0]?.content ?? ""));
        return turns[i++]!;
      },
    } as unknown as GatewayClient;
    return { client, systemPrompts };
  };

  const intoPlanMode = async (stdin: { write: (s: string) => void }) => {
    stdin.write("\x1b[Z"); // normal → auto-accept
    await tick();
    stdin.write("\x1b[Z"); // → plan
    await tick();
  };

  it("carries the mode into the system prompt instead of making the model discover it", async () => {
    const { client, systemPrompts } = planningClient();
    const { stdin } = render(<App client={client} config={config} wallet={wallet} />);
    await intoPlanMode(stdin);
    stdin.write("make out.txt");
    await tick();
    stdin.write("\r");
    await tick(250);

    expect(systemPrompts[0]).toContain("# Permission mode: plan (read-only)");
  });

  it("approves in the same turn, and the work then actually happens", async () => {
    const { client } = planningClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    await intoPlanMode(stdin);
    stdin.write("make out.txt");
    await tick();
    stdin.write("\r");
    await tick(250);

    const asking = strip(lastFrame() ?? "");
    expect(asking).toContain("Ready to act on this plan?");
    expect(asking).toContain("create out.txt");

    stdin.write("a"); // yes, auto-accept edits
    await tick(350);

    const done = strip(lastFrame() ?? "");
    expect(done).toContain("plan approved");
    expect(done).toContain("auto-accept edits"); // the status line moved with it
    expect(done).toContain("Created out.txt.");
    // The point of the whole exercise: no retyping, and the file exists.
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("done");
  });

  it("keeps planning on n, and writes nothing", async () => {
    const { client } = planningClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    await intoPlanMode(stdin);
    stdin.write("make out.txt");
    await tick();
    stdin.write("\r");
    await tick(250);
    stdin.write("n");
    await tick(300);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("keeping plan mode on");
    expect(out).toContain("plan mode (read-only)"); // still the mode
    expect(() => readFileSync(join(root, "out.txt"), "utf8")).toThrow();
  });

  it("stops the turn on esc, without leaving plan mode", async () => {
    const { client } = planningClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    await intoPlanMode(stdin);
    stdin.write("make out.txt");
    await tick();
    stdin.write("\r");
    await tick(250);
    stdin.write(ESC);
    await tick(300);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("(stopped)");
    expect(out).toContain("plan mode (read-only)");
    expect(() => readFileSync(join(root, "out.txt"), "utf8")).toThrow();

    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi"); // keyboard back
  });
});
