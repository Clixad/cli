/**
 * The three advertising formats as they reach a terminal.
 *
 * `sponsor-tui.test.tsx` pins the top bar; this file pins what changed when two
 * more slots arrived, and each of the claims below is a property of the frame
 * rather than of any function — so every one is asserted against what ink
 * actually wrote to a terminal it believed was real:
 *
 *  - a place is asked about only where the terminal can hold it;
 *  - the card sits beside the working line and costs no row, so the input box
 *    does not move when it arrives;
 *  - the status bar is a row under the status line, and the first thing given
 *    up when rows run short;
 *  - a dialog is what the person is reading, and the two newer slots give way
 *    to it;
 *  - a line is reported only if its row was drawn, after the turn, all
 *    three in one report, each under its own format.
 *
 * The lines here are booked ones, because a booked week is what fills all
 * three places at once.
 */
import React from "react";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
  clearCount,
  fakeStdin,
  fakeTerminal,
  isFrame,
  plain,
  restoreProcessStdout,
  settle,
  tallestFrameRows,
  type FakeTerminal,
} from "./helpers/terminal.tsx";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";
import type { DirectAnswer, ServedDirectLine } from "../src/sponsor/direct.ts";
import type { AdFormat } from "../src/sponsor/formats.ts";
import { AD_LABEL, SIDEBAR_CARD_COLS, SIDEBAR_MIN_COLS, SPONSOR_SIGIL } from "../src/sponsor/render.ts";

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

const line = (format: AdFormat, text: string): ServedDirectLine => ({
  format,
  text,
  serveToken: `tok_${format}`,
  clickUrl: "https://app.clixad.io/go?c=x",
});

const LINES: Record<AdFormat, ServedDirectLine> = {
  top_bar: line("top_bar", "Globex: plan sprints in 5 min"),
  sidebar_card: line("sidebar_card", "Nimbus: catch the error first"),
  status_bar: line("status_bar", "Acme Deploys — ship on Friday"),
};

type Report = { format: AdFormat; serveToken: string };

/** A client whose turn hangs until released, recording every report call. */
function watchingClient(turn?: () => Promise<ChatTurn>) {
  const reported: Report[][] = [];
  let release: () => void = () => {};
  const client = {
    models: async () => catalog,
    wallet: async () => wallet,
    reportDirectImpressions: async (items: Report[]) => {
      reported.push(items);
      return 0;
    },
    reportSponsorViews: async () => 0,
    chatStream:
      turn ??
      (async (): Promise<ChatTurn> => {
        await new Promise<void>((r) => {
          release = r;
        });
        return {
          message: { role: "assistant", content: "done" },
          finishReason: "stop",
          creditsCharged: 7,
          balance: 4981,
        } as ChatTurn;
      }),
  } as unknown as GatewayClient;
  return { client, reported, release: () => release() };
}

/**
 * An ask that books a line in each place it is asked about, out of `booked`,
 * and remembers what it was asked.
 */
function bookingAll(asked: AdFormat[][] = [], booked: readonly AdFormat[] = ["top_bar", "sidebar_card", "status_bar"]) {
  return async (formats: readonly AdFormat[]): Promise<DirectAnswer> => {
    asked.push([...formats]);
    return { supported: true, lines: formats.filter((f) => booked.includes(f)).map((f) => LINES[f]) };
  };
}

const mounted: Array<{ unmount: () => void }> = [];

function mount(term: FakeTerminal, props: Partial<React.ComponentProps<typeof App>> = {}) {
  const stdin = fakeStdin();
  const app = render(<App client={watchingClient().client} config={config} wallet={wallet} {...props} />, {
    stdout: term as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounted.push(app);
  return { app, stdin };
}

afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount();
  await settle(20);
  restoreProcessStdout();
});

/** The last repainted region, row by row, as the user would read it. */
const lastFrame = (term: FakeTerminal): string[] => {
  const frames = term.writes.filter(isFrame);
  return plain(frames[frames.length - 1] ?? "").split("\n");
};

const rowIndex = (rows: string[], text: string) => rows.findIndex((r) => r.includes(text));

describe("which places a session asks about", () => {
  it("never asks for a card on a terminal too narrow to draw one", async () => {
    const narrow = fakeTerminal(30, SIDEBAR_MIN_COLS - 1);
    const asked: AdFormat[][] = [];
    mount(narrow, { initialTask: "go", sponsorDirect: bookingAll(asked) });
    await settle(250);
    expect(asked).toEqual([["top_bar", "status_bar"]]);
    expect(plain(narrow.output())).not.toContain(LINES.sidebar_card.text);
  });

  it("asks for a card one column wider", async () => {
    const wide = fakeTerminal(30, SIDEBAR_MIN_COLS);
    const asked: AdFormat[][] = [];
    mount(wide, { initialTask: "go", sponsorDirect: bookingAll(asked) });
    await settle(250);
    expect(asked).toEqual([["top_bar", "sidebar_card", "status_bar"]]);
    expect(plain(wide.output())).toContain(LINES.sidebar_card.text);
  });
});

describe("where each format is drawn", () => {
  it("puts all three on screen at once, each in its place", async () => {
    const term = fakeTerminal(30, 120);
    const { client, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorDirect: bookingAll() });
    await settle(250);

    const rows = lastFrame(term);
    const working = rowIndex(rows, "esc to stop");
    const top = rowIndex(rows, LINES.top_bar.text);
    const prompt = rowIndex(rows, "❯");
    const status = rowIndex(rows, "gemini-2.5-flash-lite");
    const statusBar = rowIndex(rows, LINES.status_bar.text);

    // The card: its mark on the working line's row, its copy on the row under
    // it, both in the right-hand column.
    expect(rows[working]).toContain(`${SPONSOR_SIGIL} ${AD_LABEL}`);
    expect(rows[working + 1]).toContain(LINES.sidebar_card.text);
    expect(rows[working]!.indexOf("│")).toBe(120 - SIDEBAR_CARD_COLS);
    // The top bar above the input box, the status bar under the status line.
    expect(top).toBeGreaterThan(working);
    expect(prompt).toBeGreaterThan(top);
    expect(status).toBeGreaterThan(prompt);
    expect(statusBar).toBe(status + 1);
    // Every advertisement is marked, the card included.
    expect(rows[top]).toContain(`${AD_LABEL} ·`);
    expect(rows[statusBar]).toContain(`${AD_LABEL} ·`);

    expect(clearCount(term)).toBe(0);
    expect(tallestFrameRows(term)).toBeLessThanOrEqual(30);
    release();
    await settle(120);
  });

  it("costs no row: the input box stays where it was when a card arrives", async () => {
    const heightWith = async (booked: readonly AdFormat[]) => {
      const term = fakeTerminal(30, 120);
      mount(term, { initialTask: "go", sponsorDirect: bookingAll([], booked) });
      await settle(250);
      const rows = lastFrame(term);
      for (const app of mounted.splice(0)) app.unmount();
      await settle(20);
      return { rows: rows.length, prompt: rows.length - rowIndex(rows, "❯") };
    };
    // Same frame, same distance from the prompt to the bottom, card or no card.
    expect(await heightWith(["top_bar", "status_bar", "sidebar_card"])).toEqual(await heightWith(["top_bar", "status_bar"]));
  });

  it("gives the status bar up first when rows run short, and never overflows", async () => {
    // Nine rows hold the input box, the working line, the status line and the
    // top bar, and nothing more. The card costs no row, so it stays.
    const term = fakeTerminal(9, 120);
    const { client, reported, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorDirect: bookingAll() });
    await settle(250);

    const rows = lastFrame(term);
    expect(rowIndex(rows, LINES.status_bar.text)).toBe(-1);
    expect(rowIndex(rows, LINES.top_bar.text)).toBeGreaterThan(-1);
    expect(rowIndex(rows, LINES.sidebar_card.text)).toBeGreaterThan(-1);
    expect(clearCount(term)).toBe(0);
    expect(tallestFrameRows(term)).toBeLessThanOrEqual(9);

    release();
    await settle(150);
    // Answered, never drawn: not seen, so not reported.
    expect(reported.flat().map((r) => r.format).sort()).toEqual(["sidebar_card", "top_bar"]);
  });

  it("fits every terminal it is drawn in", async () => {
    for (const [height, width] of [
      [24, 90],
      [24, 100],
      [16, 140],
      [12, 90],
      [7, 120],
    ] as const) {
      const term = fakeTerminal(height, width);
      mount(term, { initialTask: "go", sponsorDirect: bookingAll() });
      await settle(200);
      expect(clearCount(term), `${width}x${height}`).toBe(0);
      expect(tallestFrameRows(term), `${width}x${height}`).toBeLessThanOrEqual(height);
      for (const row of lastFrame(term)) expect(row.length, `${width}x${height}`).toBeLessThanOrEqual(width);
      for (const app of mounted.splice(0)) app.unmount();
      await settle(20);
      restoreProcessStdout();
    }
  });
});

describe("a dialog is what the person is reading", () => {
  /** A turn whose first model call asks to write a file, so the gate opens. */
  const editTurn = () =>
    watchingClient(async (): Promise<ChatTurn> => {
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt","content":"x"}' } },
          ],
        },
        finishReason: "tool_calls",
        creditsCharged: 1,
        balance: 4987,
      } as ChatTurn;
    });

  it("hides the card and the status bar, and reports neither if they were never seen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clixad-adformats-"));
    writeFileSync(join(dir, "a.txt"), "old");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const term = fakeTerminal(30, 120);
      const { client, reported } = editTurn();
      // The answer lands only once the dialog is already up.
      let land: () => void = () => {};
      const later = new Promise<void>((r) => {
        land = r;
      });
      const book = bookingAll();
      const { stdin } = mount(term, {
        client,
        initialTask: "write it",
        sponsorDirect: async (formats) => {
          await later;
          return book(formats);
        },
      });
      await settle(300);
      expect(plain(term.output())).toMatch(/overwrite a|write a/);
      land();
      await settle(150);

      const rows = lastFrame(term);
      expect(rowIndex(rows, LINES.sidebar_card.text)).toBe(-1);
      expect(rowIndex(rows, LINES.status_bar.text)).toBe(-1);
      // The top bar keeps its place above the input, as it always has.
      expect(rowIndex(rows, LINES.top_bar.text)).toBeGreaterThan(-1);

      // Esc stops the turn with the dialog still up.
      stdin.send("\u001b");
      await settle(200);
      expect(reported.flat().map((r) => r.format)).toEqual(["top_bar"]);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reporting three formats", () => {
  it("reports each drawn line after the turn, under its own format, in one report", async () => {
    const term = fakeTerminal(30, 120);
    const { client, reported, release } = watchingClient();
    mount(term, { client, initialTask: "go", sponsorDirect: bookingAll() });
    await settle(250);
    // Nothing while the call is in flight: the gateway has not settled it.
    expect(reported).toEqual([]);

    release();
    await settle(200);
    expect(reported).toHaveLength(1);
    expect(Object.fromEntries(reported[0]!.map((r) => [r.format, r.serveToken]))).toEqual({
      top_bar: "tok_top_bar",
      sidebar_card: "tok_sidebar_card",
      status_bar: "tok_status_bar",
    });
  });
});
