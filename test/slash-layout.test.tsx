/**
 * Every slash command leaves the input box where it found it.
 *
 * The bug this file exists for: after `/model` — and after every other command,
 * because typing the slash is what opens the command menu — the input box stood
 * part-way up the screen with empty rows under it that the terminal let you
 * scroll into. Nothing in the stream of writes looked wrong and ink never
 * cleared the screen, so `tui-frame.test.tsx` could not see it: a menu or a
 * picker grew the frame, the terminal scrolled, and when it closed the frame
 * shrank back with nothing to fill the rows it gave up. Only replaying the bytes
 * onto a grid (`screenOf`) shows where the box actually ended up.
 *
 * Each command is run twice: on a fresh screen, where the spacer pins the box,
 * and under a scrollback long enough that the spacer had been zero — the state
 * any real session is in after its first long answer, and the one that broke.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
  clearCount,
  fakeStdin,
  fakeTerminal,
  lastInkedRow,
  plain,
  restoreProcessStdout,
  screenOf,
  settle,
  type FakeTerminal,
  type Screen,
} from "./helpers/terminal.tsx";
import { until } from "./helpers/wait.ts";

// /earn opens a browser, and /login would start a real device flow.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
vi.mock("../src/login.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/login.ts")>()),
  performLogin: async () => ({ status: "failed", error: "no gateway in this test" }),
}));
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

const catalog = [
  { id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 },
  { id: "gpt-5-nano", tier: "cheap", est_ads_per_task: 1.4 },
  { id: "deepseek-v4-flash", tier: "cheap", est_ads_per_task: 1.5 },
  { id: "kimi-k2.7-code", tier: "mid", est_ads_per_task: 12 },
  { id: "claude-sonnet-5.5", tier: "mid", est_ads_per_task: 18 },
];

/** Long enough to push the banner off the top of a 24-row terminal. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long answer`).join("\n");

const client = {
  models: async () => catalog,
  wallet: async () => wallet,
  claimStreak: async () => null,
  handoffCode: async () => undefined,
  referral: async () => ({
    code: "ABCD2345",
    invited: 1,
    credited: 0,
    creditsEarned: 0,
    remaining: 20,
    maxCredited: 20,
    inviterCredits: 5000,
    inviteeCredits: 5000,
  }),
  redeem: async () => ({ status: "unknown" }),
  creditPacks: async () => ({
    enabled: true,
    packs: [
      { id: "starter", label: "Starter", credits: 100_000, price_usd: 1.5 },
      { id: "regular", label: "Regular", credits: 400_000, price_usd: 5 },
    ],
  }),
  async chatStream(_m: ChatMessage[], _model: string, _o: ChatOptions): Promise<ChatTurn> {
    return { message: { role: "assistant", content: LONG_ANSWER }, finishReason: "stop", creditsCharged: 3, balance: 4985 };
  },
} as unknown as GatewayClient;

const ESC_KEY = "\u001b";
const DOWN = "\u001b[B";

/**
 * What to type for each command, and how to leave whatever it opens.
 *
 * `/exit` is the one command missing, and on purpose: it takes the whole frame
 * with it. Every command that opens a picker or a wait is closed the way a
 * person would close it, since the shrink on the way *out* is where the rows
 * used to go missing.
 */
/** Wait until the screen shows one of these before the next key: the picker or wait is open. */
type Open = { open: string[] };
const PICKER = { open: ["Select model"] };

const COMMANDS: Array<[name: string, keys: Array<string | Open>]> = [
  ["/help", ["/help", "\r"]],
  ["/model (esc)", ["/model", "\r", PICKER, ESC_KEY]],
  ["/model (pick)", ["/model", "\r", PICKER, DOWN, "\r"]],
  ["/models", ["/models", "\r"]],
  ["/mode plan", ["/mode plan", "\r"]],
  ["/wallet", ["/wallet", "\r"]],
  ["/earn (esc)", ["/earn", "\r", { open: ["waiting for the offer…"] }, ESC_KEY]],
  ["/refer", ["/refer", "\r"]],
  ["/redeem", ["/redeem", "\r", "ABCD-EFGH", "\r"]],
  ["/buy (esc)", ["/buy", "\r", { open: ["Buy credits"] }, ESC_KEY]],
  ["/login", ["/login", "\r"]],
  ["/compact", ["/compact", "\r"]],
  ["/clear", ["/clear", "\r"]],
  ["/resume", ["/resume", "\r", { open: ["Resume a session", "no saved sessions in this directory yet"] }, ESC_KEY]],
  ["/init", ["/init", "\r"]],
  ["/bg", ["/bg", "\r"]],
  ["/mcp", ["/mcp", "\r"]],
  ["/ then backspace", ["/", "\u007f"]],
];

const mounted: Array<{ unmount: () => void }> = [];

function mount(term: FakeTerminal) {
  const stdin = fakeStdin();
  const app = render(<App client={client} config={config} wallet={wallet} />, {
    stdout: term as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounted.push(app);
  return stdin;
}

afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount();
  await settle(20);
  restoreProcessStdout();
});

/**
 * The rule under the input — the row everything under the box hangs off. The
 * input is a prompt between two rules, so it is the rule that follows the
 * last prompt row with a rule above it.
 */
function boxBottom(screen: Screen): number {
  const rule = (r: number) => /^─{3,}$/.test(screen.rows[r] ?? "");
  for (let r = screen.rows.length - 2; r >= 1; r--) {
    if (screen.rows[r]!.startsWith("❯") && rule(r - 1) && rule(r + 1)) return r + 1;
  }
  return -1;
}

/**
 * Waiting for the layout, not for a length of time. A command that runs a turn
 * or a request takes as long as the machine makes it take; what these tests
 * measure is where the box ends up once it has, so they wait for that (bounded,
 * then the assertion reads what is there). A box that stays out of place, which
 * is the bug this file is for, still fails.
 */
const pinned = (term: FakeTerminal) => (s: Screen) =>
  boxBottom(s) === term.rows - 3 && lastInkedRow(s) === term.rows - 2 && !s.rows.some((r) => r.includes("esc to stop"));

function show(screen: Screen): string {
  return screen.rows.map((row, i) => `${String(i).padStart(2)}|${row}`).join("\n");
}

for (const state of ["a fresh screen", "a full scrollback"] as const) {
  describe(`slash commands on ${state}`, () => {
    for (const [name, keys] of COMMANDS) {
      it(`${name} leaves the box at the bottom`, async () => {
        const term = fakeTerminal(24, 80);
        const stdin = mount(term);
        await until(() => screenOf(term), pinned(term));
        if (state === "a full scrollback") {
          stdin.send("hello");
          await settle(40);
          stdin.send("\r");
          // The long answer in, the turn over, the box back down.
          await until(
            () => screenOf(term),
            (s) => [...s.scrollback, ...s.rows].some((r) => r.includes("line 40 of a long answer")) && pinned(term)(s),
          );
        }
        const before = screenOf(term);
        // The premise: the box is pinned before anything is typed, with the one
        // row under the status line that `viewport` leaves free.
        expect(boxBottom(before), show(before)).toBe(term.rows - 3);
        expect(lastInkedRow(before), show(before)).toBe(term.rows - 2);
        const clearsBefore = clearCount(term);

        // Typed a character at a time, as a person types it: the lone `/` is
        // what opens the whole command menu, and a command pasted in one chunk
        // would only ever show its own row of it.
        for (const key of keys) {
          if (typeof key !== "string") {
            await until(() => plain(term.output()), (out) => key.open.some((t) => out.includes(t)));
            continue;
          }
          const typed = /^[^\u001b\r\u007f]{2,}$/.test(key) ? [...key] : [key];
          for (const ch of typed) {
            stdin.send(ch);
            await settle(typed.length > 1 ? 25 : key === "\r" ? 300 : 80);
          }
          // A person's Enter comes well after the last key. Sent 25 ms after it,
          // it fell inside the paste window and was a newline, so these commands
          // never opened their picker while the test still passed.
          if (typed.length > 1) await settle(60);
        }
        const after = await until(
          () => screenOf(term),
          (s) =>
            boxBottom(s) === boxBottom(before) &&
            lastInkedRow(s) === lastInkedRow(before) &&
            !s.rows.some((r) => r.includes("esc to stop")),
        );
        expect(boxBottom(after), show(after)).toBe(boxBottom(before));
        expect(lastInkedRow(after), show(after)).toBe(lastInkedRow(before));
        // /clear clears the screen itself; nothing else may have made ink do it.
        if (name !== "/clear") expect(clearCount(term)).toBe(clearsBefore);
      });
    }
  });
}
