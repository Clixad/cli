/**
 * Suggesting `/init`: the small half of remembering a codebase across sessions.
 *
 * Three pieces. Whether a directory qualifies (`shouldSuggestInit`), whether
 * somebody has worked in it before (`hasSessionIn`), and when the REPL says so:
 * as it opens for a returning project, after a few finished turns for a new one,
 * once per session, and never at all when `main.ts` did not ask for it.
 */
import React from "react"; // classic JSX transform needs React in scope
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { INIT_HINT, shouldSuggestInit } from "../src/context.ts";
import { hasSessionIn, saveSession } from "../src/session.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
};

function stub(): GatewayClient {
  return {
    models: async () => [],
    wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(_m: ChatMessage[], _mo: string, _o: ChatOptions): Promise<ChatTurn> {
      return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
    },
  } as unknown as GatewayClient;
}

/** Colour and line breaks out, since the notice wraps on a 100-column test frame. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const type = async (stdin: { write(s: string): void }, line: string) => {
  stdin.write(line);
  await tick(150);
  stdin.write("\r");
  await tick(500);
};
/** Every frame ink drew, because a committed notice scrolls into `<Static>`. */
const hints = (frames: string[]) => strip(frames.join("\n")).split(INIT_HINT).length - 1;

/** A directory of its own per case, read back for macOS's `/private` prefix. */
let dir: string;
let previous: string;
beforeEach(() => {
  previous = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "adg-init-hint-")));
  dir = process.cwd();
  mkdirSync(join(dir, ".git"));
});
afterEach(() => {
  process.chdir(previous);
  rmSync(dir, { recursive: true, force: true });
});

describe("whether a directory qualifies", () => {
  it("is a project with no instruction file", () => {
    expect(shouldSuggestInit(dir)).toBe(true);
  });

  it("is not once a CLIXAD.md or an AGENTS.md exists", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# agents");
    expect(shouldSuggestInit(dir)).toBe(false);
    rmSync(join(dir, "AGENTS.md"));
    writeFileSync(join(dir, "CLIXAD.md"), "# clixad");
    expect(shouldSuggestInit(dir)).toBe(false);
  });

  it("is not a directory that looks like no project at all", () => {
    rmSync(join(dir, ".git"), { recursive: true });
    expect(shouldSuggestInit(dir)).toBe(false);
    writeFileSync(join(dir, "package.json"), "{}");
    expect(shouldSuggestInit(dir)).toBe(true);
  });

  it("is never the home directory", () => {
    expect(shouldSuggestInit(homedir())).toBe(false);
  });
});

describe("whether somebody worked here before", () => {
  it("finds a session saved in this directory and no other", () => {
    expect(hasSessionIn(dir)).toBe(false);
    saveSession({
      id: `20260924T000000-${Math.random().toString(16).slice(2, 6)}`,
      started: "2026-09-24T00:00:00.000Z",
      updated: "2026-09-24T00:00:00.000Z",
      cwd: dir,
      model: config.model,
      title: "x".repeat(6_000),
      messages: [{ role: "user", content: "x" }],
    });
    expect(hasSessionIn(dir)).toBe(true);
    expect(hasSessionIn(join(dir, "elsewhere"))).toBe(false);
  });
});

describe("when the REPL says it", () => {
  it("says it as the REPL opens, for a project somebody is coming back to", async () => {
    const view = render(<App client={stub()} config={{ ...config }} initHint={{ returning: true }} />);
    await tick(200);
    expect(hints(view.frames)).toBeGreaterThan(0);
    view.unmount();
  });

  it("waits for real work in a first session, then says it once", async () => {
    const view = render(<App client={stub()} config={{ ...config }} initHint={{ returning: false }} />);
    await tick(200);
    await type(view.stdin, "one");
    await type(view.stdin, "two");
    expect(strip(view.lastFrame()!)).not.toContain(INIT_HINT);
    await type(view.stdin, "three");
    expect(strip(view.lastFrame()!)).toContain(INIT_HINT);
    await type(view.stdin, "four");
    expect(strip(view.lastFrame()!).split(INIT_HINT).length - 1).toBe(1);
    view.unmount();
  });

  it("stays quiet once the file exists, whoever wrote it", async () => {
    const view = render(<App client={stub()} config={{ ...config }} initHint={{ returning: false }} />);
    await tick(200);
    writeFileSync(join(dir, "CLIXAD.md"), "# written during the session");
    for (const line of ["one", "two", "three"]) await type(view.stdin, line);
    expect(strip(view.lastFrame()!)).not.toContain(INIT_HINT);
    view.unmount();
  });

  it("says nothing when main.ts did not ask, which is every other test", async () => {
    const view = render(<App client={stub()} config={{ ...config }} />);
    await tick(200);
    for (const line of ["one", "two", "three"]) await type(view.stdin, line);
    expect(strip(view.lastFrame()!)).not.toContain(INIT_HINT);
    view.unmount();
  });
});
