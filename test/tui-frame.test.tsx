/**
 * The bottom of the screen has one hard rule: it must stay shorter than the
 * terminal. This file is where that rule is actually enforced.
 *
 * `tui.test.tsx` has had a `TUI frame height` block for a long time, and it
 * could not see any of the failures below, because `ink-testing-library`'s
 * stdout has no `isTTY` and a hardcoded `columns` of 100 — so ink ran its
 * non-interactive path, never erased a frame, never resized, and never reached
 * the fallback the whole rule exists to avoid. These tests drive ink against a
 * stdout it believes is a terminal (`helpers/terminal.tsx`) and assert on what
 * ink actually wrote.
 *
 * The measurement that matters is `clearCount`: when the region ink has to
 * repaint grows past the viewport, ink cannot erase it, and falls back to
 * clearing the terminal and replaying **every** static line of the session
 * (`shouldClearTerminalForFrame`). That is what stacks half-drawn input boxes
 * up the screen, and — happening once per streamed token — what makes output
 * arrive in lurches.
 */
import React from "react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
  CLEAR_TERMINAL,
  clearCount,
  fakeStdin,
  frameRows,
  fakeTerminal,
  plain,
  restoreProcessStdout,
  settle,
  tallestFrameRows,
  type FakeTerminal,
} from "./helpers/terminal.tsx";

// /earn opens a browser; a test must not spawn one.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App, ASK_HINT, BUY_HINT, PLAN_HINT, statusLine } from "../src/tui/app.tsx";
import { pickHint } from "../src/tui/views.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";
import { BANNER_TIPS, compactBanner, MIN_BANNER_WIDTH, visibleLength, welcomeBanner } from "../src/banner.ts";
import { AD_MIN_COLS, SPONSOR_MARKER } from "../src/sponsor/render.ts";
import type { ServedLine } from "../src/sponsor/network.ts";

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
  { id: "claude-sonnet-4.6", tier: "mid", est_ads_per_task: 18 },
  { id: "kimi-k2.7-code", tier: "mid", est_ads_per_task: 12 },
  { id: "claude-fable-5.1", tier: "frontier", est_ads_per_task: 140 },
];

const idleClient = () =>
  ({ models: async () => catalog, wallet: async () => wallet }) as unknown as GatewayClient;

/** Streams `text` in small chunks, then hangs — so a frame can be read mid-answer. */
const streamingClient = (text: string) =>
  ({
    models: async () => catalog,
    wallet: async () => wallet,
    async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      for (const chunk of text.match(/.{1,40}/gs) ?? []) {
        opts.onDelta?.(chunk);
        await settle(12);
      }
      await new Promise<void>(() => {});
      return {} as ChatTurn;
    },
  }) as unknown as GatewayClient;

const mounted: Array<{ unmount: () => void }> = [];

function mount(term: FakeTerminal, props: Partial<React.ComponentProps<typeof App>> = {}) {
  const stdin = fakeStdin();
  const app = render(<App client={idleClient()} config={config} wallet={wallet} {...props} />, {
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

/**
 * Streamed text is measured by the same helpers as everything else, so an
 * answer that is not plain ASCII used to reopen the overflow this whole file
 * is about. Measured before the fix, at 80x20: an ASCII answer cleared the
 * terminal once, the same answer in Chinese eleven times, and one built from
 * `✅ ❌ ⚠️` twelve.
 */
describe("streamed answers that are not ASCII", () => {
  const cases: Array<[string, string]> = [
    ["ascii", "the model keeps talking and talking ".repeat(30)],
    ["chinese", "这是一个中文的句子用来测试宽度计算是否正确".repeat(12)],
    ["emoji", "✅ done ❌ failed ⚠️ careful ".repeat(20)],
    ["mixed", "checking ✅ 中文 done ❌ 日本語 ".repeat(20)],
  ];

  for (const [name, paragraph] of cases) {
    it(`keeps the frame inside the viewport: ${name}`, async () => {
      const term = fakeTerminal(20, 80);
      mount(term, { client: streamingClient(`${paragraph}\n`.repeat(4)), initialTask: "go" });
      await settle(700);

      expect(clearCount(term)).toBe(0);
      // 19 rows of content plus the newline ink appends to a frame that does
      // not fill the viewport — the one row `viewport` deliberately leaves free.
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(20);
      const shown = plain(term.output());
      expect(shown).toContain("working…"); // it really did stream
      // Clipped, not dropped: an answer this long disappeared entirely when a
      // naive clamp decided its one enormous line did not fit.
      expect(shown).toContain(paragraph.slice(0, 12));
    });
  }
});

/**
 * `/model` at a width an editor-plus-terminal split actually produces.
 *
 * The picker's widest row is the loaded model's — prompt, number, label, hint
 * and `← current` — which the real catalog puts at 74 columns, plus four for
 * the box. Below that ink wrapped the three `<Text>` siblings of each row
 * independently and they landed on top of one another
 * (`gemini-2.5-flash-litecompletion`), while `pickerHeight` went on counting
 * one row per item. At 60 columns that produced a 41-row frame in a 24-row
 * terminal and three full clear-and-replay cycles.
 */
describe("the model picker at narrow widths", () => {
  for (const cols of [100, 80, 72, 60, 50, 40, 30, 24]) {
    it(`stays inside a ${cols}-column terminal`, async () => {
      const term = fakeTerminal(24, cols);
      const { stdin } = mount(term);
      await settle(150);
      term.clear();

      stdin.send("/model");
      await settle(60);
      stdin.send("\r");
      await settle(250);

      const frames = term.writes.filter((w) => plain(w).includes("Select model"));
      expect(frames.length).toBeGreaterThan(0); // the picker really opened
      for (const frame of frames) {
        for (const row of plain(frame).split("\n")) {
          expect(visibleLength(row)).toBeLessThanOrEqual(cols);
        }
      }
      expect(clearCount(term)).toBe(0);
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(24);
    });
  }

  it("scrolls a long catalog under a window rather than growing past the terminal", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `model-${i}`,
      tier: "mid",
      est_ads_per_task: 2,
    }));
    const term = fakeTerminal(16, 80);
    const { stdin } = mount(term, {
      client: { models: async () => many, wallet: async () => wallet } as unknown as GatewayClient,
    });
    await settle(150);
    term.clear();

    stdin.send("/model");
    await settle(60);
    stdin.send("\r");
    await settle(250);

    const shown = plain(term.output());
    expect(shown).toContain("Select model");
    const listed = many.filter((m) => shown.includes(m.id)).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(many.length); // a window, not the whole catalog
    expect(clearCount(term)).toBe(0);
    expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(16);
  });

  it("keeps the label and the hint apart instead of overlapping them", async () => {
    const term = fakeTerminal(24, 60);
    const { stdin } = mount(term);
    await settle(150);
    stdin.send("/model");
    await settle(60);
    stdin.send("\r");
    await settle(250);

    const shown = plain(term.output());
    expect(shown).toContain("Select model");
    // The collision the independent wrapping produced, verbatim.
    expect(shown).not.toContain("gemini-2.5-flash-litecompletion");
  });
});

/**
 * The status line is counted as one row, so it has to be one row.
 *
 * With spend, a burn rate and a context warning all present it reaches 101
 * columns. In an 80-column terminal — the commonest width there is — it wrapped
 * to two rows while `chromeHeight` counted one, so the input box sat a row too
 * high for the rest of the session and the frame was a row over the viewport.
 * At 24 columns it wrapped to four.
 */
describe("the status line", () => {
  const busySession = { model: "gemini-2.5-flash-lite", balance: 4988, spent: 148_230, contextPct: 0.81, minutes: 6 };

  for (const cols of [120, 100, 80, 60, 40, 30, 20, 12]) {
    it(`is one row at ${cols} columns`, () => {
      const line = statusLine(busySession, cols);
      expect(visibleLength(line)).toBeLessThanOrEqual(cols);
      expect(line).not.toContain("\n");
    });
  }

  it("keeps what the row is for and drops the rest, in that order", () => {
    // Wide: everything.
    const wide = statusLine(busySession, 120);
    expect(wide).toContain("gemini-2.5-flash-lite");
    expect(wide).toContain("4,988 cr");
    expect(wide).toContain("−148,230");
    expect(wide).toContain("cr/min");
    expect(wide).toContain("context 81%");
    expect(wide).toContain("/help");

    // `/help` is a fixed hint and goes first; the context warning is news and
    // survives the burn rate and the subtotal.
    const tight = statusLine(busySession, 62);
    expect(tight).not.toContain("/help");
    expect(tight).toContain("context 81%");
    expect(tight).toContain("4,988 cr");

    // Narrower still: only what is being spent and what is left.
    const narrow = statusLine(busySession, 34);
    expect(narrow).toContain("gemini-2.5-flash-lite");
    expect(narrow).toContain("4,988 cr");
    expect(narrow).not.toContain("cr/min");
    expect(narrow).not.toContain("context");
  });

  it("never wraps the row under the input box, at any width", async () => {
    for (const cols of [80, 60, 40, 24]) {
      const term = fakeTerminal(24, cols);
      mount(term);
      await settle(180);
      for (const row of plain(term.output()).split("\n")) {
        expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      }
      expect(clearCount(term)).toBe(0);
      for (const app of mounted.splice(0)) app.unmount();
      await settle(20);
    }
  });

  it("keeps the row one row with the cost preview on it", async () => {
    // The preview is the longest clause the row has ever carried, and it appears
    // mid-typing. An uncounted second row here would move the box on every
    // keystroke of every task somebody types.
    const priced = [
      {
        id: "claude-opus-5.5",
        tier: "premium",
        est_ads_per_task: 30,
        credits_per_mtoken_input: 750_000,
        credits_per_mtoken_output: 3_750_000,
      },
    ];
    const client = {
      models: async () => priced,
      wallet: async () => wallet,
      taskShape: { callsTypical: 2, callsLong: 10, growthTokens: 300, outputTokens: 600 },
    } as unknown as GatewayClient;
    for (const cols of [120, 80, 60, 40]) {
      const term = fakeTerminal(24, cols);
      const { stdin } = mount(term, { client, config: { ...config, model: "claude-opus-5.5" } });
      await settle(120);
      stdin.send("fix the failing upload test");
      await settle(180);
      for (const row of plain(term.output()).split("\n")) {
        expect(visibleLength(row), `${cols} columns`).toBeLessThanOrEqual(cols);
      }
      expect(clearCount(term), `${cols} columns`).toBe(0);
      if (cols >= 80) {
        expect(plain(term.output()), `${cols} columns`).toContain("not enough");
      }
      for (const app of mounted.splice(0)) app.unmount();
      await settle(20);
    }
  });
});

/**
 * A gated edit with a diff long enough to fill the space.
 *
 * This is the most ordinary path in the product — the default mode asks before
 * every write — and it was two rows over the viewport every time. The working
 * line is two rows that cannot be clipped ("esc to stop" is the one promise
 * the REPL has to keep) and it was subtracted from the budget *after* the
 * dialog had already taken all of it, so those two rows came out of nothing.
 * Measured at 80x24 before the fix: a 25-row region in a 23-row viewport, and
 * five clear-and-replay cycles for one dialog.
 *
 * The preview is measured at the dialog's inner width too. Every modal is a
 * `<Box borderStyle="round" paddingX={1}>`, which is four columns narrower than
 * the terminal, so a line of `cols - 3` columns counted as one row and drew as
 * two.
 */
describe("the permission dialog", () => {
  const editTurn = (path: string, content: string) =>
    ({
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path, content }) },
              },
            ],
          },
          finishReason: "tool_calls",
          creditsCharged: 1,
          balance: 4987,
        } as ChatTurn;
      },
    }) as unknown as GatewayClient;

  /** Lines wide enough to land in the four columns the box borders cost. */
  const rewritten = (marker: string, width: number) =>
    Array.from({ length: 40 }, (_, i) => `${marker} ${i} `.padEnd(width, "z")).join("\n");

  for (const [rows, cols] of [
    [24, 80],
    [24, 100],
    [20, 80],
    [30, 60],
    [24, 40],
    [14, 40],
    [10, 36],
    [8, 30],
  ] as const) {
    it(`fits its diff into ${cols}x${rows}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "clixad-frame-"));
      const file = join(dir, "a.txt");
      // Line widths that straddle the border allowance on purpose.
      writeFileSync(file, rewritten("old", cols - 3));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const term = fakeTerminal(rows, cols);
        mount(term, {
          client: editTurn("a.txt", rewritten("new", cols - 3)),
          initialTask: "rewrite it",
        });
        await settle(500);

        const shown = plain(term.output());
        expect(shown).toMatch(/overwrite a/); // the dialog really opened
        expect(shown).toMatch(/esc stops|esc\b/); // and so did its hint row, in some phrasing
        expect(clearCount(term)).toBe(0);
        expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
        for (const row of shown.split("\n")) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * A hint row may get shorter; it may never lose the way out.
 *
 * Every one of these ends on `esc`, so cutting the tail to make it fit removes
 * exactly the key somebody stuck in a modal is looking for. `pickHint` steps
 * down to a shorter phrasing instead.
 */
/**
 * The purchase confirmation, which is the newest bottom-region block and
 * therefore the newest way to overflow the viewport.
 *
 * It is the tallest fixed modal in the product: a pack line, two declarations
 * that each wrap to two or three rows at 80 columns, a terms URL, a typed field
 * and a hint. `BUY_CHROME` counts the field and the hint, and `headRows` is
 * what has to give the rest of it back on a short terminal — if either is wrong
 * the frame is taller than the screen, ink clears it and replays the whole
 * session, which is the failure this file exists for.
 */
describe("the purchase confirmation", () => {
  /** Two packs, so the picker in front of the dialog has rows to show. */
  const buyingClient = () =>
    ({
      models: async () => catalog,
      wallet: async () => wallet,
      creditPacks: async () => ({
        enabled: true,
        packs: [
          { id: "starter", label: "Starter", credits: 500_000, price_usd: 5 },
          { id: "pro", label: "Pro", credits: 6_000_000, price_usd: 50 },
        ],
      }),
    }) as unknown as GatewayClient;

  for (const [rows, cols] of [
    [24, 100],
    [24, 80],
    [20, 80],
    [24, 60],
    [16, 60],
    [14, 40],
    [10, 40],
    [8, 30],
  ] as const) {
    it(`stays inside a ${cols}x${rows} terminal`, async () => {
      const term = fakeTerminal(rows, cols);
      const { stdin } = mount(term, { client: buyingClient() });
      await settle(150);
      term.clear();

      stdin.send("/buy");
      await settle(60);
      stdin.send("\r"); // run it — the picker opens
      await settle(250);
      stdin.send("\r"); // take the first pack — the confirmation opens
      await settle(150);
      // Typing has to be safe too: the field is one budgeted row, and a longer
      // answer than the field allows must not become a second one.
      stdin.send("yesyesyes");
      await settle(120);

      const frames = term.writes.filter((w) => plain(w).includes("Buy credits"));
      expect(frames.length).toBeGreaterThan(0); // the dialog really opened
      for (const frame of frames) {
        for (const row of plain(frame).split("\n")) {
          expect(visibleLength(row)).toBeLessThanOrEqual(cols);
        }
      }
      expect(clearCount(term)).toBe(0);
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
    });
  }

  it("refuses the answer on a terminal too short to have asked the question", async () => {
    // Everything else in this file clips: a diff loses its tail, a plan its
    // end, a streamed answer all but the last rows of it. None of that changes
    // what the user is agreeing to. The two declarations are the thing being
    // agreed to, so where they do not fit the dialog says so and `yes` buys
    // nothing — a declaration taken from somebody who was never shown it is
    // the one failure § 356 (5) is about.
    const term = fakeTerminal(9, 40);
    const { stdin } = mount(term, { client: buyingClient() });
    await settle(150);
    stdin.send("/buy");
    await settle(60);
    stdin.send("\r");
    await settle(250);
    stdin.send("\r");
    await settle(150);

    const shown = plain(term.output());
    // The action comes first in the sentence and the assertion is about the
    // words rather than about where the box happened to wrap: where there is
    // room for one row only, the row that survives has to be the one that says
    // what to do.
    expect(shown).toMatch(/Make this terminal taller/);
    expect(shown).not.toMatch(/right of withdrawal lapses/);

    stdin.send("yes");
    await settle(60);
    stdin.send("\r");
    await settle(200);

    const after = plain(term.output());
    expect(after).toMatch(/make it taller/);
    // Still open, and still unanswered: the fix is a resize, and closing the
    // dialog would throw away the pack that was already chosen.
    expect(after).not.toMatch(/checkout\.stripe\.com/);
    expect(clearCount(term)).toBe(0);
  });

  it("keeps the field and the hint whatever else the box gives up", async () => {
    // The field the buyer types into and the row that says how to answer are
    // chrome: the text above them is what gives way, in either direction — the
    // notes first, then the declarations, then the whole question. A dialog
    // that clipped its own input would be unanswerable, which is the permission
    // dialog's rule in a second place.
    const term = fakeTerminal(10, 60);
    const { stdin } = mount(term, { client: buyingClient() });
    await settle(150);
    stdin.send("/buy");
    await settle(60);
    stdin.send("\r");
    await settle(250);
    stdin.send("\r");
    await settle(150);
    stdin.send("yes");
    await settle(120);

    const shown = plain(term.output());
    expect(shown).toContain("Buy credits");
    expect(shown).toMatch(/❯ yes/);
    expect(clearCount(term)).toBe(0);
  });
});

describe("hint rows", () => {
  const hints: Array<[string, readonly string[]]> = [
    ["permission", ASK_HINT],
    ["plan", PLAN_HINT],
    // The purchase dialog's, which has one more thing it cannot lose than the
    // other two: the word it takes. `yes` is the only way to accept, so a
    // phrasing that fitted by dropping it would leave a dialog nobody can
    // answer — the same failure as losing `esc`, one key over.
    ["buy", BUY_HINT],
  ];

  for (const [name, variants] of hints) {
    for (const cols of [100, 80, 60, 40, 30, 20, 14]) {
      it(`${name}: fits ${cols} columns and still names esc`, () => {
        const hint = pickHint(variants, cols);
        expect(visibleLength(hint)).toBeLessThanOrEqual(cols);
        expect(hint).toContain("esc");
        if (name === "buy") expect(hint).toContain("yes");
      });
    }
  }

  it("falls back to a cut only below the shortest phrasing", () => {
    // Nothing sensible fits in six columns; the point is that it does not throw
    // and does not exceed the width.
    expect(visibleLength(pickHint(ASK_HINT, 6))).toBeLessThanOrEqual(6);
  });
});

/**
 * Resizing, which is where this started.
 *
 * One transient is inherent and worth naming, because the tests below are
 * written around it. Ink's `resize` handler recalculates the yoga layout for
 * the elements **already in the tree** and paints them; it does not re-run
 * React components, and React will not flush a store-driven render inside a
 * Node event handler before that paint happens. So the first frame after a
 * resize event is the previous tree measured against the new terminal, and for
 * one frame a row can be a column too wide. React corrects it milliseconds
 * later. What these tests hold is the part that is ours: once a step has
 * settled, nothing we draw is wider or taller than the terminal we are in, and
 * dragging a divider never cascades into clearing the screen.
 *
 * Already-committed scrollback is a separate matter and is not ours to fix: a
 * `<Static>` line is written to the terminal's history and reflows with it,
 * exactly as any other program's output does.
 */
describe("resizing", () => {
  /** Rows drawn after the resize settled — the state the user is left looking at. */
  const settledRows = (term: FakeTerminal) =>
    term.writes
      .filter((w) => !w.includes(CLEAR_TERMINAL) && !plain(w).includes("Welcome"))
      .flatMap((w) => plain(w).split("\n"));

  const steps: Array<[string, [number, number], [number, number]]> = [
    ["a big height drop", [40, 100], [16, 100]],
    ["a big width drop", [40, 100], [40, 48]],
    ["both at once", [40, 100], [14, 38]],
    ["growing", [14, 38], [40, 100]],
    ["a modest drag step", [40, 100], [24, 76]],
    ["down to a very short terminal", [40, 100], [6, 80]],
    ["down to a very narrow terminal", [40, 100], [30, 24]],
  ];

  for (const [name, [fromRows, fromCols], [toRows, toCols]] of steps) {
    it(`settles correctly after ${name}`, async () => {
      const term = fakeTerminal(fromRows, fromCols);
      const { stdin } = mount(term);
      await settle(180);

      term.resize(toRows, toCols);
      await settle(250);
      term.clear();
      // Type a character. Ink skips a repaint when the frame is unchanged, so
      // asking for one is the only way to read the *settled* tree rather than
      // whatever was painted mid-transition.
      stdin.send("x");
      await settle(200);

      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(toRows);
      for (const row of settledRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(toCols);
    });
  }

  it("drags down two rows at a time without ever clearing the screen", async () => {
    const term = fakeTerminal(40, 100);
    mount(term);
    await settle(180);
    term.clear();

    for (let rows = 38; rows >= 12; rows -= 2) {
      term.resize(rows, 100);
      await settle(25);
    }
    await settle(200);

    expect(clearCount(term)).toBe(0);
    for (const row of settledRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(100);
  });

  it("drags both dimensions without cascading", async () => {
    const term = fakeTerminal(40, 100);
    mount(term);
    await settle(180);

    for (let rows = 38, cols = 96; rows >= 12; rows -= 2, cols -= 4) {
      term.clear();
      term.resize(rows, cols);
      await settle(40);
      expect(clearCount(term)).toBe(0);
    }
    await settle(150);
    // Settled at the smallest size: everything fits.
    term.clear();
    term.resize(12, 44);
    await settle(200);
    for (const row of settledRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(44);
  });

  it("repaints at most twice for one big jump, then stays quiet", async () => {
    const term = fakeTerminal(40, 100);
    mount(term);
    await settle(180);
    term.clear();

    term.resize(14, 38);
    await settle(250);
    // Ink's stale paint, and the corrected one. The second is unavoidable on
    // its own: the frame that was on screen is taller than the new terminal, so
    // `shouldClearTerminalForFrame` has to start over whatever we draw next.
    const afterJump = clearCount(term);
    expect(afterJump).toBeLessThanOrEqual(2);

    // And it settles: no further clearing while nothing changes.
    term.clear();
    await settle(400);
    expect(clearCount(term)).toBe(0);
  });
});

/** The narrow banner has to fit the terminal it was chosen for. */
describe("the welcome banner", () => {
  for (const cols of [100, 80, 66, 65, 50, 40, 30, 24, 20]) {
    it(`fits ${cols} columns`, () => {
      const opts = {
        name: "FlosGit",
        model: "gemini-2.5-flash-lite",
        balance: 4988,
        adsToday: 2,
        earnedUsdToday: 0.04,
        maxRewardUsd: 0.8,
        cwd: "/home/flo/clixad",
        version: "v0.0.1",
        width: cols,
        tipIndex: 0,
      };
      const text = cols >= MIN_BANNER_WIDTH ? welcomeBanner(opts) : compactBanner(opts);
      for (const row of text.split("\n")) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
    });
  }

  it("fits every tip, at every narrow width", () => {
    for (let tipIndex = 0; tipIndex < BANNER_TIPS.length; tipIndex++) {
      for (const cols of [65, 50, 40, 30, 24]) {
        const text = compactBanner({
          model: "m",
          balance: 998_877_665,
          adsToday: 0,
          earnedUsdToday: 0,
          maxRewardUsd: 0.8,
          cwd: "/tmp",
          version: "v0",
          width: cols,
          tipIndex,
        });
        for (const row of text.split("\n")) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      }
    }
  });
});

/**
 * The budget is a cap, not a suggestion.
 *
 * It used to be a subtraction that could go negative — the working line was
 * spent after the dialogs had taken everything — with `Math.max(1, …)` floors
 * underneath that could not be met on a short terminal. Both produce the same
 * result: a frame taller than the screen, which ink answers by clearing it and
 * replaying the session.
 *
 * So the frame is now assembled the other way round. The input box and whatever
 * a modal needs to be answerable are reserved first; the rest of the chrome is
 * granted only while there is room, best first — working line, status line,
 * queue, then the sponsored line, which is ours and goes first. This sweeps the
 * states that combine badly across the sizes people actually use.
 */
describe("the frame never exceeds the terminal", () => {
  const sizes: Array<[number, number]> = [
    [40, 120],
    [24, 80],
    [20, 80],
    [16, 60],
    [14, 40],
    [10, 40],
    [8, 30],
    [6, 24],
  ];

  for (const [rows, cols] of sizes) {
    it(`idle at ${cols}x${rows}`, async () => {
      const term = fakeTerminal(rows, cols);
      mount(term);
      await settle(200);
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
      for (const row of frameRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      expect(clearCount(term)).toBe(0);
    });

    it(`with the model picker open at ${cols}x${rows}`, async () => {
      const term = fakeTerminal(rows, cols);
      const { stdin } = mount(term);
      await settle(150);
      term.clear();
      stdin.send("/model");
      await settle(60);
      stdin.send("\r");
      await settle(250);
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
      for (const row of frameRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
    });

    it(`streaming with a queue behind it at ${cols}x${rows}`, async () => {
      const term = fakeTerminal(rows, cols);
      const { stdin } = mount(term, {
        client: streamingClient("a long answer that keeps going and going ".repeat(20)),
        initialTask: "go",
      });
      await settle(200);
      // Type while it runs: the queue rows are chrome and are counted.
      for (const queued of ["and then this", "and also this", "plus this", "and one more"]) {
        stdin.send(queued);
        await settle(20);
        stdin.send("\r");
        await settle(20);
      }
      await settle(250);
      expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
      for (const row of frameRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
    });
  }
});

/**
 * A dialog whose *summary* is the thing that does not fit.
 *
 * The summary is a path, so on a narrow terminal it wraps on its own — and the
 * space reserved for a modal only ever counted one row for it. Everything
 * inside the box is clipped now, head first: which file is being changed
 * matters more than the tail of its path.
 */
describe("a permission dialog with a very long summary", () => {
  const deepPath = "src/components/very/deeply/nested/directory/structure/thing.tsx";

  for (const [rows, cols] of [
    [24, 80],
    [16, 50],
    [12, 40],
    [10, 30],
  ] as const) {
    it(`fits ${cols}x${rows}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "clixad-summary-"));
      mkdirSync(join(dir, dirname(deepPath)), { recursive: true });
      writeFileSync(join(dir, deepPath), "before\n");
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const term = fakeTerminal(rows, cols);
        mount(term, {
          client: {
            models: async () => catalog,
            wallet: async () => wallet,
            async chatStream(): Promise<ChatTurn> {
              return {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: deepPath, content: "after\n" }),
                      },
                    },
                  ],
                },
                finishReason: "tool_calls",
                creditsCharged: 1,
                balance: 4987,
              } as ChatTurn;
            },
          } as unknown as GatewayClient,
          initialTask: "rewrite it",
        });
        await settle(500);

        expect(plain(term.output())).toContain("overwrite"); // it really opened
        expect(clearCount(term)).toBe(0);
        expect(tallestFrameRows(term)).toBeGreaterThan(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
        for (const row of frameRows(term)) expect(visibleLength(row)).toBeLessThanOrEqual(cols);
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * A terminal too narrow for an advertisement.
 *
 * This lives here and not beside the other sponsored-line tests for the reason
 * the whole file exists: `ink-testing-library`'s stdout has a `columns` getter
 * hardcoded to 100, so a test that pins a width there is pinning nothing. The
 * App reads the width off the stdout ink was handed, which here is a terminal
 * whose width the test actually controls.
 *
 * Two fences, answering two different failures. The serve path refuses first,
 * because a serve is what ADtention bills (`sponsor.test.ts` counts the
 * requests). The fill refuses second, because the terminal can narrow while the
 * request is in flight, and a line that arrives with nowhere to go was not
 * seen — so it is neither painted nor reported.
 */
describe("an advertisement that will not fit", () => {
  const servedLine: ServedLine = {
    id: "c_acme",
    text: "Acme Deploys — ship on Friday",
    impressionId: "imp_0001",
    billable: true,
    fromCache: false,
    credit: 0.00005,
  };

  /** A client that hangs mid-turn and records every impression reported. */
  const watchingClient = () => {
    const reported: string[] = [];
    let release: () => void = () => {};
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      sponsorConfig: async () => null,
      reportImpression: async (r: { impressionId: string }) => {
        reported.push(r.impressionId);
        return 0;
      },
      async chatStream(): Promise<ChatTurn> {
        await new Promise<void>((r) => {
          release = r;
        });
        return {
          message: { role: "assistant", content: "done" },
          finishReason: "stop",
          creditsCharged: 7,
          balance: 4981,
        } as ChatTurn;
      },
    } as unknown as GatewayClient;
    return { client, reported, release: () => release() };
  };

  it("is never asked for when the terminal is already too narrow", async () => {
    const term = fakeTerminal(24, AD_MIN_COLS - 1);
    const { client, reported, release } = watchingClient();
    let serves = 0;
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: async () => {
        serves++;
        return servedLine;
      },
    });
    await settle(250);

    expect(serves).toBe(0);
    // Our own line is unaffected — it is not billed and costs nobody anything.
    expect(plain(term.output())).toContain(SPONSOR_MARKER);

    release();
    await settle(150);
    expect(reported).toEqual([]);
  });

  it("is asked for, and shown, one column wider", async () => {
    const term = fakeTerminal(24, AD_MIN_COLS);
    const { client, release } = watchingClient();
    let serves = 0;
    mount(term, {
      client,
      initialTask: "go",
      sponsorServe: async () => {
        serves++;
        return servedLine;
      },
    });
    await settle(250);

    expect(serves).toBe(1);
    expect(plain(term.output())).toContain(servedLine.text); // whole, not cut
    release();
    await settle(120);
  });

  it("is dropped rather than reported when the terminal narrows mid-flight", async () => {
    const term = fakeTerminal(24, 100);
    const { client, reported, release } = watchingClient();
    let land: (v: ServedLine) => void = () => {};
    const inFlight = new Promise<ServedLine>((r) => {
      land = r;
    });
    mount(term, { client, initialTask: "go", sponsorServe: () => inFlight });
    await settle(150);

    // Wide enough when the request went out; too narrow when it lands.
    term.resize(24, AD_MIN_COLS - 1);
    await settle(80);
    term.clear();
    land(servedLine);
    await settle(200);

    expect(plain(term.output())).not.toContain(servedLine.text);
    release();
    await settle(200);
    expect(reported).toEqual([]);
  });
});
