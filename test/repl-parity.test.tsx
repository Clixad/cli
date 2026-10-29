/**
 * The parts of the REPL that were simply missing next to Claude Code.
 *
 * Typing while the agent works is the big one — the keyboard used to be dead
 * for the length of every call, so a thought you had while watching it work was
 * a thought you had to hold. The rest are smaller and share a shape: something
 * the CLI could already do, but only by quitting first.
 */
import React from "react";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
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

/** Every turn hangs until released, so a frame can be read mid-call. */
function hangingClient() {
  const gates: Array<() => void> = [];
  const asked: string[] = [];
  const client = {
    models: async () => catalog,
    wallet: async () => wallet,
    async chatStream(m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      asked.push(String(m[m.length - 1]?.content ?? ""));
      // Honours the signal, like the real client, which passes it to fetch — a
      // stub that ignores it would hang past an esc and make the abort paths
      // look broken when they are not.
      await new Promise<void>((resolve, reject) => {
        gates.push(resolve);
        opts.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
      });
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop", creditsCharged: 7, balance: 4981 };
    },
  } as unknown as GatewayClient;
  return { client, asked, release: () => gates.shift()?.() };
}

describe("typing while the agent works", () => {
  it("takes the keystrokes instead of swallowing them", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("working…");

    stdin.write("second thought");
    await tick(80);
    // In the box, not lost: the turn is still running.
    expect(strip(lastFrame() ?? "")).toContain("second thought");

    release();
    await tick(120);
    release();
    await tick(120);
  });

  it("queues what is submitted mid-turn, shows it waiting, and runs it after", async () => {
    const { client, asked, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(asked).toEqual(["first"]);

    stdin.write("second");
    await tick();
    stdin.write("\r");
    await tick(80);

    // Waiting, visibly, and not sent yet.
    expect(strip(lastFrame() ?? "")).toContain("⏳ second");
    expect(asked).toEqual(["first"]);

    release(); // first turn finishes → the queue drains
    await tick(200);
    expect(asked).toEqual(["first", "second"]);
    expect(strip(lastFrame() ?? "")).not.toContain("⏳ second");

    release();
    await tick(120);
  });

  it("drops the queue on esc and says exactly what was not sent", async () => {
    const { client, asked, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick(120);
    stdin.write("second");
    await tick();
    stdin.write("\r");
    await tick(80);

    stdin.write(ESC);
    await tick(250);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("not sent:");
    expect(out).toContain("· second");
    expect(out).toContain("(stopped)");
    // A message queued to run *after* the stopped one must not run *instead* of it.
    expect(asked).toEqual(["first"]);

    release();
    await tick(80);
  });
});

describe("/clear", () => {
  it("empties the screen as well as the context", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("something memorable");
    await tick();
    stdin.write("\r");
    await tick(120);
    release();
    await tick(150);
    expect(strip(lastFrame() ?? "")).toContain("something memorable");

    stdin.write("/clear");
    await tick();
    stdin.write("\r");
    await tick(150);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("cleared");
    // The transcript of a conversation the agent can no longer remember used to
    // stay sitting there, so nothing visibly happened.
    expect(out).not.toContain("something memorable");
  });
});

describe("/resume", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-resume-"));
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("says so plainly when this directory has no sessions", async () => {
    const { client } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("/resume");
    await tick();
    stdin.write("\r");
    await tick(150);
    expect(strip(lastFrame() ?? "")).toContain("no saved sessions in this directory");
  });

  it("offers a picker once there is one to pick", async () => {
    const { client, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    // A turn writes a session file for this directory.
    stdin.write("remember this");
    await tick();
    stdin.write("\r");
    await tick(120);
    release();
    await tick(200);

    stdin.write("/resume");
    await tick();
    stdin.write("\r");
    await tick(200);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Resume a session");
    expect(out).toContain("remember this"); // the title is the first message
  });
});

describe("!command", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-bang-"));
    cwd = process.cwd();
    process.chdir(root);
    writeFileSync(join(root, "marker.txt"), "x");
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs without a model call and puts the output where the next turn sees it", async () => {
    const { client, asked, release } = hangingClient();
    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);

    stdin.write("!echo hello-from-shell");
    await tick();
    stdin.write("\r");
    await tick(600);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("hello-from-shell");
    expect(asked).toEqual([]); // no model call was made, and none was paid for

    // The next turn is not blind to what just happened in its own workspace.
    stdin.write("what did I just run?");
    await tick();
    stdin.write("\r");
    await tick(150);
    const sent = asked.join("\n");
    expect(sent).toContain("what did I just run?");

    release();
    await tick(120);
  });
});

/**
 * Compaction happens silently at 75% of the window and costs a model call, so
 * the first the user knew of it was a notice saying it had already happened.
 */
describe("the context indicator", () => {
  const withMessages = (chars: number) => {
    const filler = "x".repeat(chars);
    return {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return {
          message: { role: "assistant", content: filler },
          finishReason: "stop",
          creditsCharged: 7,
          balance: 4981,
        } as ChatTurn;
      },
    } as unknown as GatewayClient;
  };

  it("stays quiet while the context is nowhere near full", async () => {
    const { stdin, lastFrame } = render(<App client={withMessages(50)} config={config} wallet={wallet} />);
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick(200);
    // A number that reads 4% all day is a number nobody looks at, which is how
    // a status line stops being read at all.
    // Matched as a percentage, not as the bare word: the startup notice that
    // lists loaded CLIXAD.md files begins "context:" too.
    expect(strip(lastFrame() ?? "")).not.toMatch(/context \d+%/);
  });

  it("appears once the window is filling up", async () => {
    // gemini-2.5-flash-lite's window via the local catalog; ~4 chars a token,
    // so this clears the 60% mark comfortably.
    const { stdin, lastFrame } = render(<App client={withMessages(3_000_000)} config={config} wallet={wallet} />);
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick(300);
    expect(strip(lastFrame() ?? "")).toMatch(/context \d+%/);
  });
});
