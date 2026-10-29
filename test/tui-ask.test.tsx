/**
 * The model asking the user a question, and the two commands that show what the
 * agent has left running.
 *
 * `ask_user` reuses the picker `/model` already had, which is the point: the
 * keys mean the same things everywhere. What it adds is `onCancel`, and that is
 * the part worth a test — a turn is awaiting the answer with the keyboard
 * locked, so a dialog that closed without settling the promise would hang the
 * REPL with "esc to stop" on screen and nothing listening.
 */
import React from "react"; // classic JSX transform needs React in scope
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { messageText } from "../src/client.ts";
import { shells } from "../src/shells.ts";
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

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";
/** The picker's subtitle — present only while the question is on screen. */
const WAITING = "The agent is waiting for your answer";

/** Records what the gateway was sent, so a tool result can be asserted on. */
function stubClient(turns: Pick<ChatTurn, "message" | "finishReason">[]) {
  let i = 0;
  const sent: ChatMessage[][] = [];
  const client = {
    models: async () => [],
    wallet: async () => wallet,
    async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      sent.push(structuredClone(messages));
      const turn = turns[i++];
      if (!turn) throw new Error("no scripted turn left");
      for (const chunk of messageText(turn.message).match(/.{1,6}/gs) ?? []) opts.onDelta?.(chunk);
      return { ...turn, creditsCharged: 7, balance: 4981 };
    },
  } as unknown as GatewayClient;
  return { client, sent };
}

const askTurn = (options: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: "q1",
        type: "function" as const,
        function: {
          name: "ask_user",
          arguments: JSON.stringify({ question: "Which database should I use?", options }),
        },
      },
    ],
  },
  finishReason: "tool_calls",
});

const say = (text: string) => ({ message: { role: "assistant" as const, content: text }, finishReason: "stop" });

const OPTIONS = [
  { label: "Postgres", description: "already in the repo" },
  { label: "SQLite", description: "no server to run" },
];

afterEach(() => shells.killAll());

describe("ask_user in the REPL", () => {
  it("puts the question up as a picker and reports the answer back to the model", async () => {
    const { client, sent } = stubClient([askTurn(OPTIONS), say("Postgres it is.")]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);

    stdin.write("pick a database");
    await tick();
    stdin.write("\r");
    await tick(150);

    const dialog = strip(lastFrame() ?? "");
    expect(dialog).toContain("Which database should I use?");
    expect(dialog).toContain("1. Postgres");
    expect(dialog).toContain("already in the repo");
    expect(dialog).toContain(WAITING);

    stdin.write("2"); // the row number, as everywhere else
    await tick(200);

    const after = strip(lastFrame() ?? "");
    expect(after).toContain("answered: SQLite");
    // Closed. Asserted on the picker's own subtitle, not on the question: the
    // question is also the committed tool-call line, and `lastFrame` carries
    // the scrollback with it.
    expect(after).not.toContain(WAITING);

    // The model is told as a fact, on the same turn.
    const toolResult = sent.at(-1)!.find((m) => m.role === "tool");
    expect(messageText(toolResult!)).toBe("The user chose: SQLite");
  });

  it("releases the waiting turn on esc instead of hanging the keyboard", async () => {
    // Only one scripted turn: if esc left the loop running it would ask for a
    // second and the error would show up on screen.
    const { client } = stubClient([askTurn(OPTIONS)]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);

    stdin.write("pick a database");
    await tick();
    stdin.write("\r");
    await tick(150);
    expect(strip(lastFrame() ?? "")).toContain(WAITING);

    stdin.write(ESC);
    await tick(250);

    const after = strip(lastFrame() ?? "");
    expect(after).toContain("(stopped)");
    expect(after).not.toContain(WAITING);
    expect(after).not.toContain("no scripted turn left");
    // The keyboard is back: the working line is gone and typing lands in the box.
    expect(after).not.toContain("esc to stop");
    stdin.write("hello again");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hello again");
  });

  it("tells the model when the question was malformed, without opening a dialog", async () => {
    // One option is not a question. The turn continues rather than stalling.
    const { client, sent } = stubClient([askTurn([{ label: "only one" }]), say("I'll assume Postgres.")]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);

    stdin.write("pick a database");
    await tick();
    stdin.write("\r");
    await tick(200);

    expect(strip(lastFrame() ?? "")).not.toContain(WAITING);
    const toolResult = sent.at(-1)!.find((m) => m.role === "tool");
    expect(messageText(toolResult!)).toContain("at least two options");
  });
});

describe("/mcp", () => {
  it("explains how to configure one when there are none", async () => {
    const { client } = stubClient([]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    stdin.write("/mcp");
    await tick();
    stdin.write("\r");
    await tick(120);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("no MCP servers configured");
    expect(out).toContain("mcpServers");
  });
});

describe("/bg", () => {
  it("says nothing is running before anything has been started", async () => {
    const { client } = stubClient([]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    stdin.write("/bg");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("no background commands have been started");
  });

  it("lists what the agent left running and stops it on request", async () => {
    // The model can see its own background commands through read_output;
    // without this the person whose port 3000 is occupied could not.
    shells.start(process.cwd(), `"${process.execPath}" -e "setInterval(()=>{},1000)"`);
    const { client } = stubClient([]);
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);

    stdin.write("/bg");
    await tick();
    stdin.write("\r");
    await tick(120);
    const listed = strip(lastFrame() ?? "");
    expect(listed).toMatch(/bash_\d+\s+running/);
    expect(listed).toContain("/bg kill all");

    stdin.write("/bg kill all");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toMatch(/stopped bash_\d+/);
    expect(shells.list().every((s) => s.status !== "running")).toBe(true);
  });
});
