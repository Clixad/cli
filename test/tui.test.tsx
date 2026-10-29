/**
 * Smoke tests for the Ink TUI: the welcome banner, the completion menu, and a
 * full agent turn — tool call, diff, permission dialog, approval — driven
 * through the real key handling with a scripted gateway. Uses
 * ink-testing-library so no real terminal is needed.
 */
import React from "react"; // classic JSX transform needs React in scope (see src/tui/app.tsx)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { EventEmitter } from "node:events";

// /earn opens a browser; a test must not spawn one.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { matchCommands } from "../src/tui/commands.ts";
import { BANNER_TIPS, visibleLength, welcomeBanner } from "../src/banner.ts";
import { VERSION_LABEL } from "../src/version.ts";
import type { CliConfig } from "../src/config.ts";
import { AuthError, messageText } from "../src/client.ts";
import { MODE_LABEL, MODES } from "../src/permissions.ts";
import { MODE_STYLE } from "../src/tui/views.tsx";
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
  { id: "claude-sonnet-4.6", tier: "mid", est_ads_per_task: 18 },
];

/** Only the methods the TUI touches on first paint. */
function stubClient(turns: Pick<ChatTurn, "message" | "finishReason">[] = []): GatewayClient {
  let i = 0;
  return {
    models: async () => catalog,
    wallet: async () => wallet,
    // Every surface that might be somebody's first contact today claims the
    // streak, `/wallet` included. `null` is what a gateway too old for the route
    // answers, so it is also the quietest possible double.
    claimStreak: async () => null,
    async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      const turn = turns[i++];
      if (!turn) throw new Error("no scripted turn left");
      for (const chunk of messageText(turn.message).match(/.{1,6}/gs) ?? []) opts.onDelta?.(chunk);
      return { ...turn, creditsCharged: 7, balance: 4981 };
    },
  } as unknown as GatewayClient;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** Let Ink process a keystroke and re-render. */
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ARROW_DOWN = "\x1b[B";
const ESC = "\x1b";

const bannerOpts = {
  name: "FlosGit",
  model: "gemini-2.5-flash-lite",
  balance: 4988,
  adsToday: 2,
  earnedUsdToday: 0.04,
  maxRewardUsd: 0.8,
  cwd: "/home/flo/clixad",
  version: "v0.0.1",
};

describe("TUI", () => {
  it("renders the welcome banner with the duck, wallet and input box", () => {
    const { lastFrame } = render(<App client={stubClient()} config={config} wallet={wallet} />);
    const out = strip(lastFrame() ?? "");

    // Banner: title, greeting, wallet, model + tips
    expect(out).toContain(`Clixad ${VERSION_LABEL}`); // read from package.json, never typed
    expect(out).toContain("Welcome back, FlosGit!");
    expect(out).toContain("4,988 credits");
    expect(out).toContain("$0.04/$0.80 today"); // the cap is on payout, not on ad count
    expect(out).toContain("gemini-2.5-flash-lite");
    expect(out).toContain("Getting started");

    // Duck is drawn with half-block glyphs
    expect(out).toMatch(/[▀▄]/);

    // Bordered input box with the ❯ prompt + status line
    expect(out).toContain("❯");
    expect(out).toMatch(/[╭╰]/);
    expect(out).toContain("ask before edits"); // permission mode in the status line
  });

  it("fills the given width, every line edge to edge", () => {
    for (const width of [66, 80, 120, 203]) {
      const lines = welcomeBanner({ ...bannerOpts, width }).split("\n");
      for (const line of lines) expect(visibleLength(line)).toBe(width);
    }
  });

  it("narrows the command list as the user types", () => {
    expect(matchCommands("/").map((c) => c.name)).toContain("wallet");
    expect(matchCommands("/mod").map((c) => c.name)).toEqual(["model", "models", "mode"]);
    expect(matchCommands("/model").map((c) => c.name)).toEqual(["model", "models"]);
    expect(matchCommands("/models").map((c) => c.name)).toEqual(["models"]);
    expect(matchCommands("/mode ").map((c) => c.name)).toEqual([]); // a space ends the command word
    expect(matchCommands("/zz")).toEqual([]);
    expect(matchCommands("/model gpt")).toEqual([]); // args typed → menu closed
    expect(matchCommands("hello")).toEqual([]);
  });

  it("shows the matching commands under the input box and picks with the arrows", async () => {
    const { stdin, lastFrame } = render(<App client={stubClient()} config={config} wallet={wallet} />);

    stdin.write("/mod");
    await tick();
    const menu = strip(lastFrame() ?? "");
    expect(menu).toContain("/model ");
    expect(menu).toContain("/models");
    expect(menu).toContain("/mode [name]");
    expect(menu).toContain("↑↓ choose");
    expect(menu).toContain("❯ /model "); // first row highlighted

    stdin.write(ARROW_DOWN);
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("❯ /models");

    stdin.write("\t"); // tab completes into the box without running
    await tick();
    const done = strip(lastFrame() ?? "");
    expect(done).toContain("❯ /models");
    expect(done).toContain("ask before edits"); // menu closed, status line back
  });

  it("opens a model picker on /model, marking the active one", async () => {
    const { stdin, lastFrame } = render(<App client={stubClient()} config={{ ...config }} wallet={wallet} />);

    stdin.write("/model");
    await tick();
    stdin.write("\r"); // the menu's first row is /model → runs it
    await tick(120);

    const picker = strip(lastFrame() ?? "");
    expect(picker).toContain("Select model");
    expect(picker).toContain("1. gemini-2.5-flash-lite");
    expect(picker).toContain("3. claude-sonnet-4.6");
    expect(picker).toContain("~18 ads/task");
    expect(picker).toContain("← current"); // the configured model is marked
    expect(picker).toContain("⏎ confirm");

    stdin.write(ARROW_DOWN);
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("❯ 2. gpt-5-nano");

    stdin.write("\r");
    await tick(80);
    const after = strip(lastFrame() ?? "");
    expect(after).toContain("model → gpt-5-nano");
    expect(after).not.toContain("Select model"); // dialog closed
    expect(after).toContain("gpt-5-nano ·"); // status line switched over
  });

  it("picks a model by its row number", async () => {
    const { stdin, lastFrame } = render(<App client={stubClient()} config={{ ...config }} wallet={wallet} />);
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick(120);

    stdin.write("3");
    await tick(80);
    expect(strip(lastFrame() ?? "")).toContain("model → claude-sonnet-4.6");
  });

  it("cycles the permission mode with shift+tab", async () => {
    const { stdin, lastFrame } = render(<App client={stubClient()} config={config} wallet={wallet} />);
    stdin.write("\x1b[Z"); // shift+tab
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("auto-accept edits");
    stdin.write("\x1b[Z");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("plan mode");
  });

  /**
   * The mode is the only clause under the box that changes what the agent may
   * do, and it used to be grey among five other grey clauses — so shift+tab
   * moved it and nothing on screen looked different. Each mode owns a colour
   * now, and the test reads the *unstripped* frame for exactly that reason.
   */
  it("gives every permission mode its own colour and glyph", async () => {
    // Colour is asserted on the map rather than on a frame: ink-testing-library
    // writes to a non-TTY, where chalk's level is 0 and every escape is dropped,
    // so a rendered frame cannot see a colour at all. The glyph it can see.
    const colours = new Set(MODES.map((m) => MODE_STYLE[m].color));
    expect(colours.size).toBe(MODES.length);

    const { stdin, lastFrame } = render(<App client={stubClient()} config={config} wallet={wallet} />);
    // gemini-2.5-flash-lite is not offered auto mode, so the cycle is three
    // long here and the fourth press comes back round; auto mode's own glyph
    // is drawn in `auto-mode-run.test.tsx`.
    for (const mode of ["normal", "acceptEdits", "plan", "normal"] as const) {
      const out = strip(lastFrame() ?? "");
      expect(out).toContain(`${MODE_STYLE[mode].glyph} ${MODE_LABEL[mode]}`);
      stdin.write("\x1b[Z"); // shift+tab
      await tick();
    }
  });

  it("shows a tip in the banner rather than a second copy of the model", () => {
    const withTip = welcomeBanner({ ...bannerOpts, width: 80, tipIndex: 0 });
    expect(strip(withTip)).toContain("/init");
    expect(strip(withTip)).toContain("make a CLIXAD.md");
    // The model id is not repeated here; the status line under the box has it.
    expect(strip(withTip).split("\n").filter((l) => l.includes("gemini-2.5-flash-lite"))).toEqual([]);

    // It rotates, and every tip still fits the narrowest supported box.
    const tips = new Set(BANNER_TIPS.map((_, i) => strip(welcomeBanner({ ...bannerOpts, width: 66, tipIndex: i }))));
    expect(tips.size).toBe(BANNER_TIPS.length);
    for (const frame of tips) for (const line of frame.split("\n")) expect(line.length).toBe(66);
  });
});

/**
 * The frame-height rules moved to `tui-frame.test.tsx`.
 *
 * They could not be tested from here. `ink-testing-library`'s stdout has no
 * `isTTY` and a `columns` getter hardcoded to 100, so ink ran its
 * non-interactive path — it never erased a frame, never handled a resize, and
 * never reached `shouldClearTerminalForFrame`, the fallback that clears the
 * screen and replays the session and that every one of those rules exists to
 * avoid. Pinning `process.stdout` made the numbers *look* right while ink was
 * laying out against something else entirely, which is how the bottom region
 * came to be two rows over the viewport on the most ordinary path in the
 * product with a green suite.
 */

describe("TUI working line", () => {
  it("sits under the output, not inside the input box", async () => {
    const gates: Array<() => void> = [];
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
        opts.onDelta?.("thinking about it");
        await new Promise<void>((r) => gates.push(r));
        return { message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 7, balance: 4981 };
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(200);

    const lines = strip(lastFrame() ?? "").split("\n");
    const working = lines.findIndex((l) => l.includes("working…"));
    // The *input* box, i.e. the last one drawn — the banner is a box too.
    const boxTop = lines.map((l) => l.trimStart().startsWith("╭")).lastIndexOf(true);
    expect(working).toBeGreaterThanOrEqual(0);
    expect(boxTop).toBeGreaterThanOrEqual(0);
    // Above the box, and below the streamed text it belongs to.
    expect(working).toBeLessThan(boxTop);
    expect(lines.findIndex((l) => l.includes("thinking about it"))).toBeLessThan(working);
    // The promise the box used to carry travels with the line.
    expect(lines[working]).toContain("esc to stop");

    gates.shift()?.();
    await tick(80);
  });
});

/**
 * The /earn wait polls for up to five minutes for a reward that may never come —
 * a screenout pays nothing, and closing the wall is the most likely thing a user
 * does. Esc said it stopped things and did not, which locked the REPL for the
 * whole five minutes: the only abort controller belonged to the agent loop.
 */
describe("TUI /earn wait", () => {
  /** The wall's client: hands out a handoff code, and the balance never moves. */
  const earnClient = () =>
    ({
      models: async () => catalog,
      wallet: async () => wallet,
      handoffCode: async () => "hoff_1",
    }) as unknown as GatewayClient;

  it("stops the wait on esc and gives the input box back", async () => {
    const { stdin, lastFrame } = render(<App client={earnClient()} config={config} wallet={wallet} />);

    stdin.write("/earn");
    await tick();
    stdin.write("\r");
    await tick(120);

    const waiting = strip(lastFrame() ?? "");
    expect(waiting).toContain("waiting for the offer…"); // not "working…" — no model call is running
    expect(waiting).toContain("esc to stop");

    stdin.write(ESC);
    await tick(120);

    const stopped = strip(lastFrame() ?? "");
    expect(stopped).toContain("stopped waiting");
    expect(stopped).not.toContain("esc to stop"); // the spinner is gone
    expect(stopped).toContain("ask before edits"); // status line, i.e. the box is live again

    // And the keyboard really is back: the next keystroke lands in the editor.
    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi");
  });

  it("does not tell a screenout it failed", async () => {
    const { stdin, lastFrame } = render(<App client={earnClient()} config={config} wallet={wallet} />);
    stdin.write("/earn");
    await tick();
    stdin.write("\r");
    await tick(120);
    stdin.write(ESC);
    await tick(120);

    const out = strip(lastFrame() ?? "");
    expect(out).toMatch(/still lands whenever the offer clears/);
    expect(out).not.toMatch(/error|failed/i);
  });
});

/**
 * The same rule for the slash commands that await the gateway. Render's free tier
 * spins the instance down, so the first request after a quiet spell can take the
 * better part of a minute — during which the box said "esc to stop" and esc did
 * nothing, because only the agent loop ever had a controller.
 */
describe("TUI esc during a slash command", () => {
  /** A gateway that never answers, which is what a cold start looks like here. */
  const hungClient = () =>
    ({
      models: async () => catalog,
      // `/wallet` claims the streak before reading the balance, so the figure it
      // prints already includes today's grant. It is the *wallet* read that has
      // to hang here — that is the request a cold gateway leaves in flight.
      claimStreak: async () => null,
      wallet: (signal?: AbortSignal) =>
        new Promise<WalletInfo>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
        }),
    }) as unknown as GatewayClient;

  it("aborts /wallet and hands the keyboard back", async () => {
    const { stdin, lastFrame } = render(<App client={hungClient()} config={config} wallet={wallet} />);

    stdin.write("/wallet");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("loading…");

    stdin.write(ESC);
    await tick(120);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("(stopped)"); // not the AbortError's message as an error
    expect(out).not.toContain("esc to stop");

    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi");
  });
});

/**
 * `/login`, and the loop it exists to break.
 *
 * A 401 in the REPL printed "Not logged in. Run `clixad login` first" — a shell
 * command, at a prompt where anything without a leading slash is a *prompt*. So
 * typing it went to the model, hit the same 401, and printed the same line
 * again. The instruction the CLI gave could not be followed where it was given.
 */
describe("TUI /login", () => {
  const start = {
    session: "sess_1",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    interval: 1,
    expires_in: 900,
  };

  /** Signs in on the first poll. */
  const loginClient = () =>
    ({
      models: async () => catalog,
      wallet: async () => wallet,
      claimStreak: async () => null,
      deviceStart: async () => start,
      devicePoll: async () => ({
        status: "complete",
        token: "adg_real",
        userId: "u_1",
        email: "flo@example.com",
        login: "FlosGit",
        balance: 12345,
        created: false,
      }),
    }) as unknown as GatewayClient;

  it("is offered by the completion menu", () => {
    expect(matchCommands("/log").map((c) => c.name)).toContain("login");
  });

  it("shows the device code and signs in without leaving the REPL", async () => {
    const cfg: CliConfig = { ...config, token: undefined };
    const { stdin, lastFrame } = render(<App client={loginClient()} config={cfg} wallet={wallet} />);

    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(120);

    const waiting = strip(lastFrame() ?? "");
    expect(waiting).toContain("ABCD-1234");
    expect(waiting).toContain("https://github.com/login/device");
    expect(waiting).toContain("signing in…"); // its own label, not "working…"

    await tick(1400); // one poll interval, clamped to a second

    const done = strip(lastFrame() ?? "");
    expect(done).toContain("signed in as FlosGit");
    expect(done).toContain("12,345 credits");
    // The live client is handed the new token by reference, not rebuilt.
    expect(cfg.token).toBe("adg_real");
  });

  /**
   * § 305 (2) BGB: terms nobody was pointed at do not become part of the
   * contract, and the contract is concluded here rather than on the website —
   * a footer link on clixad.io never reaches somebody signing in from a
   * terminal.
   *
   * It has to be pushed *before* `performLogin` rather than from inside the
   * device-code renderer, because the dev shortcut creates an account without
   * ever showing a device code. Asserting it lands before the code is what
   * catches a move into `verify`.
   */
  it("shows the terms before the device code, not after it", async () => {
    const cfg: CliConfig = { ...config, token: undefined };
    const { stdin, lastFrame } = render(<App client={loginClient()} config={cfg} wallet={wallet} />);

    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(120);

    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("at least 18");
    expect(frame).toContain("https://clixad.io/terms.html");
    expect(frame).toContain("https://clixad.io/privacy.html");
    expect(frame.indexOf("clixad.io/terms.html")).toBeLessThan(frame.indexOf("ABCD-1234"));
  });

  // Same rule as /earn and /wallet: the box says "esc to stop", and the device
  // flow polls for fifteen minutes, so esc has to reach it.
  it("stops the wait on esc and gives the keyboard back", async () => {
    const pending = {
      ...loginClient(),
      devicePoll: async () => ({ status: "pending" }),
    } as unknown as GatewayClient;
    const { stdin, lastFrame } = render(<App client={pending} config={config} wallet={wallet} />);

    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(120);
    expect(strip(lastFrame() ?? "")).toContain("signing in…");

    stdin.write(ESC);
    await tick(120);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("(stopped)");
    expect(out).not.toContain("esc to stop");

    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi");
  });

  // The loop itself: a 401 must name the command that exists *here*.
  it("points a 401 at /login rather than at the shell", async () => {
    const unauthorized = () =>
      ({
        models: async () => catalog,
        // Never throws, by contract — so the 401 the test is about can only come
        // from the wallet read, which is exactly where a real one comes from.
        claimStreak: async () => null,
        wallet: async () => {
          throw new AuthError();
        },
      }) as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={unauthorized()} config={config} wallet={wallet} />);
    stdin.write("/wallet");
    await tick();
    stdin.write("\r");
    await tick(120);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("/login");
    expect(out).not.toContain("clixad login"); // the instruction that cannot be run here
  });
});

/**
 * Esc means stop. It used to mean "deny this one call" *inside* the permission
 * dialog, so the turn carried on and paid for another round-trip to be told no
 * — while the working line one row above promised "esc to stop".
 */
describe("TUI esc at the permission dialog", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-esc-"));
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  const writeTurn = {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function" as const,
          function: { name: "write_file", arguments: JSON.stringify({ path: "nope.txt", content: "x" }) },
        },
      ],
    },
    finishReason: "tool_calls",
  };

  it("stops the turn instead of denying one call and carrying on", async () => {
    let calls = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
        calls++;
        void opts;
        return { ...writeTurn, creditsCharged: 7, balance: 4981 };
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("write nope.txt");
    await tick();
    stdin.write("\r");
    await tick(200);
    expect(strip(lastFrame() ?? "")).toContain("[y/⏎] once"); // the dialog is up
    expect(strip(lastFrame() ?? "")).toContain("esc stops the turn"); // and says so

    stdin.write(ESC);
    await tick(250);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("(stopped)");
    // Not the wording of a refusal: nothing was denied, the turn was stopped.
    expect(out).not.toContain("denied: create nope.txt");
    expect(() => readFileSync(join(root, "nope.txt"), "utf8")).toThrow();
    // And no second model call was paid for to be told about it.
    expect(calls).toBe(1);

    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi"); // keyboard is back
  });

  it("still denies just the one call on n, and the turn continues", async () => {
    let calls = 0;
    const turns = [writeTurn, { message: { role: "assistant" as const, content: "Understood." }, finishReason: "stop" }];
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return { ...turns[calls++]!, creditsCharged: 7, balance: 4981 } as ChatTurn;
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("write nope.txt");
    await tick();
    stdin.write("\r");
    await tick(200);
    stdin.write("n");
    await tick(250);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("denied: create nope.txt");
    expect(out).toContain("Understood."); // the turn ran on and answered
    expect(calls).toBe(2);
  });

  /**
   * The refusal says two things to two audiences. What the user sees must be
   * the short one — the long one is an instruction addressed to the model, and
   * rendered as a red tool error it reads like a malfunction.
   */
  it("shows the human half of a plan-mode refusal, not the model's instructions", async () => {
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return { ...writeTurn, creditsCharged: 7, balance: 4981 } as ChatTurn;
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("\x1b[Z"); // → auto-accept
    await tick();
    stdin.write("\x1b[Z"); // → plan
    await tick();
    stdin.write("write nope.txt");
    await tick();
    stdin.write("\r");
    await tick(300);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("plan mode — create nope.txt was not run");
    expect(out).not.toContain("Do not attempt further writes");
  });
});

/**
 * Every "… +N lines (ctrl+o)" on screen has to be reachable. The shortcut used
 * to remember a single output — the most recent — while every collapsed entry
 * advertised it, so all but one of those labels were a promise nothing kept.
 */
describe("TUI ctrl+o", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-ctrlo-"));
    cwd = process.cwd();
    process.chdir(root);
    writeFileSync(join(root, "a.txt"), Array.from({ length: 20 }, (_, i) => `AAA-${i + 1}`).join("\n"));
    writeFileSync(join(root, "b.txt"), Array.from({ length: 20 }, (_, i) => `BBB-${i + 1}`).join("\n"));
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("walks back through the collapsed outputs, newest first", async () => {
    const readCall = (id: string, path: string) => ({
      id,
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path }) },
    });
    const turns = [
      {
        message: { role: "assistant" as const, content: null, tool_calls: [readCall("c1", "a.txt"), readCall("c2", "b.txt")] },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant" as const, content: "Read both." }, finishReason: "stop" },
    ];
    let i = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return { ...turns[i++]!, creditsCharged: 7, balance: 4981 } as ChatTurn;
      },
    } as unknown as GatewayClient;

    const { stdin, frames, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("read both");
    await tick();
    stdin.write("\r");
    await tick(300);

    // Both entries are collapsed, and both advertise the shortcut.
    const committed = strip(lastFrame() ?? "");
    expect(committed.split("(ctrl+o)").length - 1).toBe(2);

    const seen = () => frames.map(strip).join("\n");
    stdin.write("\x0f"); // ctrl+o
    await tick(80);
    expect(seen()).toContain("BBB-20"); // the newest output first

    stdin.write("\x0f");
    await tick(80);
    expect(seen()).toContain("AAA-20"); // then the one before it

    stdin.write("\x0f");
    await tick(80);
    expect(strip(lastFrame() ?? "")).toContain("nothing left to expand");
  });

  /**
   * The outputs are kept for ctrl+o, and they used to be kept for the whole
   * session: once compaction dropped them from the conversation, this list was
   * the only thing holding every file the agent had read.
   */
  it("keeps the newest outputs within a bound, and says when it reaches past it", async () => {
    const big = (tag: string) => Array.from({ length: 2000 }, (_, i) => `${tag}-${i + 1} `.padEnd(190, "x")).join("\n");
    const files = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    for (const f of files) writeFileSync(join(root, `${f}.txt`), big(f.toUpperCase()));
    const turns = [
      {
        message: {
          role: "assistant" as const,
          content: null,
          tool_calls: files.map((f) => ({
            id: f,
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ path: `${f}.txt` }) },
          })),
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant" as const, content: "Read them all." }, finishReason: "stop" },
    ];
    let i = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return { ...turns[i++]!, creditsCharged: 7, balance: 4981 } as ChatTurn;
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("read them all");
    await tick();
    stdin.write("\r");
    await tick(600);
    expect(strip(lastFrame() ?? "")).toContain("Read them all.");

    // About 390,000 characters each: the newest five fit under 2,000,000.
    const notices: string[] = [];
    for (let n = 0; n < 6; n++) {
      stdin.write("\x0f");
      await tick(120);
      notices.push(strip(lastFrame() ?? ""));
    }
    expect(notices[0]).toContain("read_file f7.txt");
    expect(notices[4]).toContain("read_file f3.txt");
    expect(notices[5]).toContain("nothing left to expand — older output is not kept this far back");
  });
});

/**
 * Bracketed paste. Without it a paste arrives as raw keystrokes split across
 * however many reads the OS decides on, and a chunk ending on a `\r` is
 * indistinguishable from Enter — the prompt submitted itself halfway through a
 * pasted stack trace.
 */
describe("TUI paste", () => {
  it("takes a multi-line paste as one piece and does not submit it", async () => {
    let calls = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        calls++;
        return { message: { role: "assistant", content: "hi" }, finishReason: "stop", creditsCharged: 1, balance: 1 } as ChatTurn;
      },
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("\x1b[200~Error: boom\n  at one.ts:1\n  at two.ts:2\x1b[201~");
    await tick(120);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Error: boom");
    expect(out).toContain("at two.ts:2");
    expect(calls).toBe(0); // nothing was sent
  });

  /**
   * The half of the fix a rendered frame cannot see.
   *
   * ink-testing-library falls back to feeding a paste through `useInput` when
   * nothing listens on the paste channel, so the test above would pass with the
   * hook removed. What actually fixes the bug is asking the *terminal* to
   * bracket pastes in the first place — `\x1b[?2004h`, which ink writes only for
   * a TTY, and only while a `usePaste` handler is mounted. So this one renders
   * against a stdout that claims to be one and reads what was written to it.
   */
  it("turns bracketed paste mode on in a real terminal", async () => {
    const written: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 100,
      rows: 30,
      write: (chunk: string) => void written.push(chunk),
    });
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setEncoding() {},
      setRawMode() {},
      resume() {},
      pause() {},
      ref() {},
      unref() {},
      read: () => null,
    });

    const app = inkRender(<App client={stubClient()} config={config} wallet={wallet} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick(80);
    expect(written.join("")).toContain("\x1b[?2004h");
    app.unmount();
    await tick(40);
  });
});

/**
 * A paste the terminal did not bracket.
 *
 * Node's raw mode on the Windows console, and some ssh and tmux setups, hand
 * a paste over as plain keystrokes in whatever chunks the OS reads. A user's
 * 25-line role prompt (1,867 characters) failed that way after bracketed paste
 * shipped: in two chunks only the second reached the model, line by line in
 * one read nothing did, and line by line over a few reads it went out as 21
 * separate billed turns. Each shape below is one of those.
 */
describe("TUI paste without brackets", () => {
  /** The same shape as the reported prompt: over 1 KB, bullets, numbered rules, blank lines. */
  const PROMPT = [
    "Act as a senior engineer and reviewer for this repository, with long experience shipping production software.",
    "SCOPE:",
    "",
    ...Array.from({ length: 7 }, (_, i) => `* Area ${i + 1}: TypeScript, Node.js, React, PostgreSQL, Docker, CI/CD, observability, security.`),
    "",
    "RULES:",
    "",
    ...Array.from({ length: 9 }, (_, i) => `${i + 1}. Read the existing code before changing anything, keep its conventions, and say what changed.`),
    "",
    "STYLE:",
    "Be concise and direct. Prefer working code over explanation. Ask only what cannot be found out by reading.",
  ].join("\n");
  /** What the terminal sends: every newline is a carriage return. */
  const RAW = PROMPT.replace(/\n/g, "\r");

  function recordingClient(sent: string[]): GatewayClient {
    return {
      models: async () => catalog,
      wallet: async () => wallet,
      claimStreak: async () => null,
      async chatStream(messages: ChatMessage[]): Promise<ChatTurn> {
        sent.push(messageText(messages[messages.length - 1]!));
        return { message: { role: "assistant", content: "ok" }, finishReason: "stop", creditsCharged: 1, balance: 1 } as ChatTurn;
      },
    } as unknown as GatewayClient;
  }

  async function pasteThenEnter(deliver: (stdin: { write(data: string): void }) => Promise<void> | void) {
    const sent: string[] = [];
    const { stdin } = render(<App client={recordingClient(sent)} config={config} wallet={wallet} />);
    await tick(60);
    await deliver(stdin);
    await tick(150);
    const beforeEnter = sent.length;
    stdin.write("\r"); // the person's own Enter, long after the paste
    await tick(150);
    return { beforeEnter, sent };
  }

  it("keeps a prompt that arrived in one chunk", async () => {
    expect(RAW.length).toBeGreaterThan(1024);
    const { beforeEnter, sent } = await pasteThenEnter((stdin) => stdin.write(RAW));
    expect(beforeEnter).toBe(0);
    expect(sent).toEqual([PROMPT]);
  });

  it("keeps both halves of a prompt read in two chunks", async () => {
    const { beforeEnter, sent } = await pasteThenEnter((stdin) => {
      stdin.write(RAW.slice(0, 1024));
      stdin.write(RAW.slice(1024));
    });
    expect(beforeEnter).toBe(0);
    expect(sent).toEqual([PROMPT]);
  });

  it("does not send a line at every carriage return in one read", async () => {
    const { beforeEnter, sent } = await pasteThenEnter((stdin) => {
      for (const line of RAW.split("\r")) {
        stdin.write(line);
        stdin.write("\r");
      }
    });
    expect(beforeEnter).toBe(0);
    expect(sent).toEqual([PROMPT]);
  });

  it("does not send a line at every carriage return across reads", async () => {
    // A turn of the event loop between writes is what separate reads are: React
    // renders in between, which is exactly what made the handler's `editor`
    // stale. Not a timed sleep, which a loaded machine stretches past the window.
    const nextRead = () => new Promise((resolve) => setImmediate(resolve));
    const { beforeEnter, sent } = await pasteThenEnter(async (stdin) => {
      for (const line of RAW.split("\r")) {
        stdin.write(line);
        await nextRead();
        stdin.write("\r");
        await nextRead();
      }
    });
    expect(beforeEnter).toBe(0);
    expect(sent).toEqual([PROMPT]);
  });

  it("still sends on an Enter typed after the last key", async () => {
    const sent: string[] = [];
    const { stdin } = render(<App client={recordingClient(sent)} config={config} wallet={wallet} />);
    await tick(60);
    for (const ch of "hello") {
      stdin.write(ch);
      await tick(5);
    }
    await tick(80);
    stdin.write("\r");
    await tick(150);
    expect(sent).toEqual(["hello"]);
  });
});

describe("TUI agent turn", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-tui-"));
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a tool call, asks for approval with a diff, and writes on 'y'", async () => {
    const client = stubClient([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hi there" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "Created hello.txt." }, finishReason: "stop" },
    ]);

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);

    stdin.write("create hello.txt");
    await tick();
    stdin.write("\r");
    await tick(120);

    // The permission dialog shows what is about to happen, with the diff.
    const asking = strip(lastFrame() ?? "");
    expect(asking).toContain("create hello.txt");
    expect(asking).toContain("hi there");
    expect(asking).toContain("[y/⏎] once"); // Enter is accepted too, not just y

    stdin.write("y");
    await tick(200);

    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi there");
    const done = strip(lastFrame() ?? "");
    expect(done).toContain("Created hello.txt.");
  });

  it("refuses edits in plan mode without asking", async () => {
    const client = stubClient([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "nope.txt", content: "x" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "Here is the plan instead." }, finishReason: "stop" },
    ]);

    const { stdin, lastFrame } = render(<App client={client} config={config} wallet={wallet} />);
    stdin.write("\x1b[Z"); // → auto-accept
    await tick();
    stdin.write("\x1b[Z"); // → plan
    await tick();

    stdin.write("write nope.txt");
    await tick();
    stdin.write("\r");
    await tick(250);

    expect(strip(lastFrame() ?? "")).toContain("Here is the plan instead.");
    expect(() => readFileSync(join(root, "nope.txt"), "utf8")).toThrow();
  });
});
