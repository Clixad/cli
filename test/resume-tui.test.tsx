/**
 * Resuming a conversation, through the real REPL (0.0.1-beta.45).
 *
 * Reported after 0.0.1-beta.44: resuming printed the session id, the message
 * count and the first message, and nothing else of the conversation, which
 * read as if it had not been loaded at all; sessions from before the update
 * could not be found; and there was no way to delete one. Each case runs in a
 * directory of its own, since the suite shares one HOME.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { deleteSession, listSessions, loadSession, saveSession, type StoredSession } from "../src/session.ts";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient } from "../src/client.ts";
import { frameIn, frameWith, waitFor } from "./helpers/wait.ts";

const config = (): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  model: "gemini-2.5-flash-lite",
});

/** A gateway that answers every call with `ANSWERED` and records what it was sent. */
function gateway() {
  const sent: ChatMessage[][] = [];
  const client = {
    models: async () => [],
    wallet: async () => ({ balance: 1, ads_today: 0, earned_usd_today: 0, max_reward_usd_per_day: 5, grant_per_ad: 1, ledger: [] }),
    async chatStream(messages: ChatMessage[], _model: string, _opts: ChatOptions): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      return { message: { role: "assistant", content: "ANSWERED" }, finishReason: "stop", creditsCharged: 1, balance: 1 };
    },
  } as unknown as GatewayClient;
  return { client, sent };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function submit(stdin: { write(s: string): void }, line: string) {
  stdin.write(line);
  await tick();
  stdin.write("\r");
}

/** A conversation of the kind the agent writes: a task, a tool call, its result, an answer. */
const CONVERSATION: ChatMessage[] = [
  { role: "user", content: "rename the helper in util.ts" },
  {
    role: "assistant",
    content: "Reading it first.",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "util.ts" }) } }],
  },
  { role: "tool", tool_call_id: "c1", content: "1\texport const helper = 1;\n2\texport const other = 2;" },
  { role: "assistant", content: "Renamed `helper` to `assist` in util.ts." },
];

let cwd: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "clixad-resume-tui-")));
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

function stored(id: string, over: Partial<StoredSession> = {}): StoredSession {
  return {
    id,
    started: "2026-11-01T10:00:00.000Z",
    updated: "2026-11-01T10:05:00.000Z",
    cwd,
    model: "gemini-2.5-flash-lite",
    title: "rename the helper in util.ts",
    messages: CONVERSATION,
    ...over,
  };
}

/** What a resumed transcript has to show: the task, the tool call, and both answers. */
const DRAWN = ["rename the helper in util.ts", "Reading it first.", "Read(util.ts)", "Read 2 lines", "Renamed helper to assist"];

/** Every row of `DRAWN` is on screen, in order. */
function expectDrawn(frame: string) {
  let at = -1;
  for (const row of DRAWN) {
    const next = frame.indexOf(row, at + 1);
    expect(next, row).toBeGreaterThan(at);
    at = next;
  }
}

describe("a resumed conversation", () => {
  it("is drawn in full when the REPL opens on it (clixad --continue)", async () => {
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} session={stored("20261101T100000-aaaa")} />);
    const frame = await frameWith(lastFrame, [...DRAWN, "resumed session 20261101T100000-aaaa (4 messages)"]);
    expectDrawn(frame);
    expect(frame).toContain("the agent has all of this conversation");

    // And the model gets all of it with the next message.
    await submit(stdin, "now update the callers");
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    expect(sent.at(-1)!.slice(1)).toEqual([...CONVERSATION, { role: "user", content: "now update the callers" }]);
  });

  it("is drawn in full and carried into the next message after /resume", async () => {
    saveSession(stored("20261101T100000-bbbb"));
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "/resume");
    await frameWith(lastFrame, "Resume a session");
    stdin.write("\r");
    expectDrawn(await frameWith(lastFrame, DRAWN));

    await submit(stdin, "now update the callers");
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    expect(sent.at(-1)!.slice(1)).toEqual([...CONVERSATION, { role: "user", content: "now update the callers" }]);
    // The next turn saved over the same session, with everything in it.
    expect(loadSession("20261101T100000-bbbb")?.messages).toHaveLength(CONVERSATION.length + 2);
  });

  it("works on a session file an older CLI wrote", async () => {
    // Written by hand, byte for byte the shape 0.0.1-beta.43 and .44 wrote,
    // rather than through today's `saveSession`.
    const id = "20261020T080000-cccc";
    mkdirSync(join(homedir(), ".clixad", "sessions"), { recursive: true });
    writeFileSync(
      join(homedir(), ".clixad", "sessions", `${id}.json`),
      JSON.stringify({ id, started: "2026-10-20T08:00:00.000Z", updated: "2026-10-20T08:03:00.000Z", cwd, model: "kimi-k2.5", title: "rename the helper in util.ts", messages: CONVERSATION }),
    );
    const { client, sent } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "/resume");
    expect(await frameWith(lastFrame, ["Resume a session", "4 messages"])).toContain("4 messages");
    stdin.write("\r");
    expectDrawn(await frameWith(lastFrame, DRAWN));
    await submit(stdin, "go on");
    await frameWith(lastFrame, "ANSWERED");
    unmount();
    expect(sent.at(-1)!.slice(1, 5)).toEqual(CONVERSATION);
  });
});

describe("deleting a session", () => {
  it("takes d twice in the /resume picker, and any other key in between keeps it", async () => {
    saveSession(stored("20261101T100000-old1", { title: "first task", updated: "2026-11-01T10:00:00.000Z" }));
    saveSession(stored("20261101T110000-old2", { title: "second task", updated: "2026-11-01T11:00:00.000Z" }));
    const { client } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "/resume");
    await frameWith(lastFrame, ["second task", "first task", "d delete"]);

    stdin.write("d");
    await frameWith(lastFrame, "Press d again to delete it for good");
    // Changing the row takes the question back.
    stdin.write("\x1b[B");
    await frameIn(lastFrame, { hasNot: ["Press d again"] });
    expect(listSessions(cwd, 10)).toHaveLength(2);

    stdin.write("d");
    await frameWith(lastFrame, "Press d again");
    stdin.write("d");
    await waitFor(() => listSessions(cwd, 10).length === 1);
    // The newest is first, so the second row was the older one.
    expect(listSessions(cwd, 10).map((s) => s.title)).toEqual(["second task"]);
    const frame = await frameWith(lastFrame, "deleted session 20261101T100000-old1");
    expect(frame).toContain("Resume a session");
    unmount();
  });

  it("does not delete the conversation you are in", async () => {
    const { client } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} session={stored("20261101T100000-here")} />);
    saveSession(stored("20261101T100000-here"));
    await frameWith(lastFrame, "Reading it first.");
    await submit(stdin, "/resume");
    await frameWith(lastFrame, "Resume a session");
    stdin.write("d");
    await tick();
    stdin.write("d");
    await frameWith(lastFrame, "That is the conversation you are in");
    unmount();
    expect(loadSession("20261101T100000-here")).toBeDefined();
  });

  it("works typed as /resume delete <id>", async () => {
    saveSession(stored("20261101T100000-typd"));
    const { client } = gateway();
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
    await submit(stdin, "/resume delete 20261101T100000-typd");
    await frameWith(lastFrame, "deleted session 20261101T100000-typd");
    await submit(stdin, "/resume delete 20261101T100000-typd");
    await frameWith(lastFrame, "no such session: 20261101T100000-typd");
    unmount();
    expect(loadSession("20261101T100000-typd")).toBeUndefined();
  });
});

describe("sessions from another directory", () => {
  it("are counted when this one has none, and listed by /resume all", async () => {
    const other = mkdtempSync(join(tmpdir(), "clixad-resume-other-"));
    try {
      // Newest of all, so it is on the picker's first screen whatever the
      // suite's other files have saved into the same HOME.
      saveSession(stored("20261101T100000-else", { cwd: other, title: "work done elsewhere", updated: new Date(Date.now() + 60_000).toISOString() }));
      const { client } = gateway();
      const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} />);
      await submit(stdin, "/resume");
      const none = await frameIn(lastFrame, { has: ["no saved sessions in this directory yet", "/resume all lists them"] });
      // At least the one written above; the suite's other files write theirs into the same HOME.
      expect(none.replace(/\s+/g, " ")).toMatch(/[1-9]\d* in other directories: \/resume all lists them/);
      await submit(stdin, "/resume all");
      const frame = await frameWith(lastFrame, ["Resume a session from any directory", "work done elsewhere"]);
      expect(frame).toContain("work done elsewhere");
      unmount();
    } finally {
      deleteSession("20261101T100000-else");
      rmSync(other, { recursive: true, force: true });
    }
  });
});
