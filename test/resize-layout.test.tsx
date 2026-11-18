/**
 * The layout stays whole across a resize, on a terminal that rewraps.
 *
 * The report: resizing the terminal while the CLI runs left the rules around
 * the input box doubled. Most terminals rewrap what is on screen when they get
 * narrower, so each full-width rule of the last frame became two rows, and ink
 * erased that frame by the number of rows it had written, which was now too
 * few. The rows it missed stayed above the new frame.
 *
 * `screenOf` could not see this: it replays every write at one size. These
 * tests replay the writes and the resizes together on a terminal that rewraps
 * (`rewrapScreenOf`), and read what is left once the resize has settled: one
 * rule above the prompt, one below, each as wide as the terminal now is, and
 * nothing of an older frame anywhere on screen or in the scrollback.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
  fakeStdin,
  fakeTerminal,
  restoreProcessStdout,
  rewrapScreenOf,
  settle,
  type FakeTerminal,
  type Screen,
} from "./helpers/terminal.tsx";
import { until } from "./helpers/wait.ts";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App, RESIZE_REDRAW_MS } from "../src/tui/app.tsx";
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
];

/** Long enough to push the banner off the top: the scrollback is full and the spacer is zero. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long answer that wraps when the terminal is narrow`).join(
  "\n",
);

const client = {
  models: async () => catalog,
  wallet: async () => wallet,
  claimStreak: async () => null,
  async chatStream(_m: ChatMessage[], _model: string, _o: ChatOptions): Promise<ChatTurn> {
    return { message: { role: "assistant", content: LONG_ANSWER }, finishReason: "stop", creditsCharged: 3, balance: 4985 };
  },
} as unknown as GatewayClient;

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

/** A row that is nothing but a horizontal rule: the input box's top or bottom border. */
const isRule = (row: string) => /^─+$/.test(row);

/** Where the prompt sits between its two rules, or undefined when it is not drawn that way. */
function promptBox(screen: Screen): { top: number; prompt: number; bottom: number } | undefined {
  for (let r = 1; r < screen.rows.length - 1; r++) {
    if (screen.rows[r]!.startsWith("❯") && isRule(screen.rows[r - 1]!) && isRule(screen.rows[r + 1]!)) {
      return { top: r - 1, prompt: r, bottom: r + 1 };
    }
  }
  return undefined;
}

/** Everything a person could scroll to: the scrollback, then the screen. */
const everything = (screen: Screen) => [...screen.scrollback, ...screen.rows];

/** One box, at the full width, and no other rule anywhere. */
function expectOneWholeBox(term: FakeTerminal): Screen {
  const screen = rewrapScreenOf(term);
  const box = promptBox(screen);
  expect(box, screen.rows.join("\n")).toBeDefined();
  expect(screen.rows[box!.top]).toHaveLength(term.columns);
  expect(screen.rows[box!.bottom]).toHaveLength(term.columns);
  expect(everything(screen).filter(isRule), everything(screen).join("\n")).toHaveLength(2);
  for (const row of everything(screen)) expect(row.length).toBeLessThanOrEqual(term.columns);
  return screen;
}

/** After a resize, once the redraw has run and painted. */
const afterRedraw = () => settle(RESIZE_REDRAW_MS + 250);

async function withHistory(rows: number, cols: number): Promise<FakeTerminal> {
  const term = fakeTerminal(rows, cols);
  const stdin = mount(term);
  await settle(150);
  stdin.send("tell me something long");
  // Past the paste window: an Enter right behind typed text is a newline.
  await settle(80);
  stdin.send("\r");
  await until(
    () => rewrapScreenOf(term).rows,
    (rows) => rows.some((r) => r.includes("line 40 of a long answer")),
  );
  await settle(150);
  return term;
}

describe("resizing on a terminal that rewraps", () => {
  const cases: Array<[string, [number, number], [number, number]]> = [
    ["narrower", [24, 100], [24, 70]],
    ["much narrower", [24, 120], [24, 48]],
    ["wider", [24, 70], [24, 110]],
    ["narrower and shorter", [30, 100], [18, 64]],
    ["wider and taller", [18, 64], [30, 100]],
  ];

  for (const [name, [fromRows, fromCols], [toRows, toCols]] of cases) {
    it(`keeps one box after getting ${name}, on a fresh screen`, async () => {
      const term = fakeTerminal(fromRows, fromCols);
      mount(term);
      await settle(200);
      expectOneWholeBox(term);

      term.resize(toRows, toCols);
      await afterRedraw();
      expectOneWholeBox(term);
    });

    it(`keeps one box after getting ${name}, under a full scrollback`, async () => {
      const term = await withHistory(fromRows, fromCols);
      expectOneWholeBox(term);

      term.resize(toRows, toCols);
      await afterRedraw();
      const screen = expectOneWholeBox(term);
      // The session is still there, drawn at the new width.
      expect(everything(screen).some((r) => r.includes("line 40 of a long answer"))).toBe(true);
      expect(everything(screen).filter((r) => r.includes("line 40 of a long answer"))).toHaveLength(1);
    });
  }

  it("keeps one box after a drag, one step every few frames", async () => {
    const term = await withHistory(24, 100);
    for (let cols = 96; cols >= 56; cols -= 4) {
      term.resize(24, cols);
      await settle(30);
    }
    await afterRedraw();
    expectOneWholeBox(term);
  });

  it("cleans up a resize that ends at the width it started from", async () => {
    const term = await withHistory(24, 100);
    term.resize(24, 70);
    await settle(30);
    term.resize(24, 100);
    await afterRedraw();
    expectOneWholeBox(term);
  });

  it("does not redraw for a change of height alone", async () => {
    const term = await withHistory(24, 100);
    const before = term.timeline.length;
    term.resize(20, 100);
    await afterRedraw();
    const writes = term.timeline.slice(before).filter((e): e is string => typeof e === "string");
    expect(writes.some((w) => w.includes("\u001b[3J"))).toBe(false);
    expectOneWholeBox(term);
  });
});
