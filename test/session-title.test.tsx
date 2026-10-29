/**
 * What a saved conversation is called, driven through the real REPL.
 *
 * `StoredSession.title` promises the *first* user message, because that is what
 * the resume picker lists — and the title used to be read off the `session`
 * prop, which is the conversation the REPL opened with and never changes. Every
 * case below was wrong in a different direction: a fresh session was renamed by
 * each new turn, `/clear` filed a brand new conversation under the resumed
 * one's name, and continuing or `/resume`-ing a session renamed it after
 * whatever was typed next. The title lives on `sessionRef` now, so it moves
 * exactly when the id does.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { listSessions, saveSession, type StoredSession } from "../src/session.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787", dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test", model: "gemini-2.5-flash-lite",
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
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/**
 * Each case gets its own working directory.
 *
 * `listSessions` filters by `cwd`, and the suite shares one `HOME` — so run
 * from the repo root these assertions would count the sessions every other TUI
 * test file is writing at the same moment. A directory per case makes "the
 * sessions this test created" mean exactly that.
 */
let cwd: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "adg-session-title-")));
  // Read back rather than kept: on macOS `/var/folders/…` resolves to
  // `/private/var/folders/…`, and the REPL files a session under whatever
  // `process.cwd()` says — so the fixture and the filter have to agree.
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

const ids = () => new Set(listSessions(cwd, 500).map((m) => m.id));
const titleOf = (id: string) => listSessions(cwd, 500).find((m) => m.id === id)?.title;
const type = async (stdin: { write(s: string): void }, line: string) => {
  stdin.write(line); await tick(150); stdin.write("\r"); await tick(650);
};

describe("session titles", () => {
  it("A: a fresh session keeps the FIRST message as its title", async () => {
    const before = ids();
    const { stdin, unmount } = render(<App client={stub()} config={{ ...config }} />);
    await tick(300);
    await type(stdin, "first question");
    await type(stdin, "second question");
    const created = [...ids()].filter((id) => !before.has(id));
    const title = titleOf(created[0]!);
    unmount();
    console.log("A ->", created.length, "session(s), title:", JSON.stringify(title));
    expect(created).toHaveLength(1);
    expect(title).toBe("first question");
  });

  it("B: /clear names the new session after its own first message", async () => {
    const resumed = {
      id: "20260101T000000-aaaa", started: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
      cwd, model: config.model, title: "the old resumed task",
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }],
    } as StoredSession;
    saveSession(resumed);
    const before = ids();
    const { stdin, unmount } = render(<App client={stub()} config={{ ...config }} session={resumed} />);
    await tick(300);
    await type(stdin, "/clear");
    await type(stdin, "a brand new unrelated task");
    const created = [...ids()].filter((id) => !before.has(id));
    const title = titleOf(created[0]!);
    console.log("B -> new:", JSON.stringify(title), "| old still:", JSON.stringify(titleOf(resumed.id)));
    unmount();
    expect(title).toBe("a brand new unrelated task");
    expect(titleOf(resumed.id)).toBe("the old resumed task");
  });

  it("C: continuing a resumed session does not rename it", async () => {
    const resumed = {
      id: "20260102T000000-bbbb", started: "2026-01-02T00:00:00.000Z", updated: "2026-01-02T00:00:00.000Z",
      cwd, model: config.model, title: "fix the login bug",
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }],
    } as StoredSession;
    saveSession(resumed);
    const { stdin, unmount } = render(<App client={stub()} config={{ ...config }} session={resumed} />);
    await tick(300);
    await type(stdin, "now also update the docs");
    console.log("C -> title:", JSON.stringify(titleOf(resumed.id)));
    unmount();
    expect(titleOf(resumed.id)).toBe("fix the login bug");
  });

  it("D: /resume <id> in the REPL does not rename the resumed session", async () => {
    const target = {
      id: "20260103T000000-cccc", started: "2026-01-03T00:00:00.000Z", updated: "2026-01-03T00:00:00.000Z",
      cwd, model: config.model, title: "the target session",
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }],
    } as StoredSession;
    saveSession(target);
    const { stdin, unmount } = render(<App client={stub()} config={{ ...config }} />);
    await tick(300);
    await type(stdin, `/resume ${target.id}`);
    await type(stdin, "carry on please");
    console.log("D -> title:", JSON.stringify(titleOf(target.id)));
    unmount();
    expect(titleOf(target.id)).toBe("the target session");
  });
});
