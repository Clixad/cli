/**
 * The mark that moves while the agent works.
 *
 * Claude Code pulses its own logo, a star, and that works because a star is a
 * character family — ✳ ✶ ✻ ✽ are one mark at four weights, so a single cell can
 * breathe. A duck is not a character family, and half-block pixel art below the
 * banner's 14×14 stops being a duck and becomes a yellow blob. So the mark is an
 * emoji, and the tests are about the two things that decision has to keep
 * getting right: it has to be the *yellow* bird rather than the duck-by-name
 * (which every system font draws as a brown mallard), and it has to fall back
 * where no emoji font exists at all.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { BRAILLE_FRAMES, DUCK_FRAMES, SPINNER_TICKS_PER_FRAME, spinnerFrames } from "../src/banner.ts";
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
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 5,
  grant_per_ad: 1800,
  ledger: [],
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** A gateway that never answers, so the working line stays on screen. */
function hangingClient(): GatewayClient {
  return {
    models: async () => [],
    wallet: async () => wallet,
    async chatStream(_m: ChatMessage[], _model: string, _opts: ChatOptions): Promise<ChatTurn> {
      await new Promise(() => undefined);
      throw new Error("unreachable");
    },
  } as unknown as GatewayClient;
}

describe("the frames", () => {
  it("is the yellow bird, not the duck-by-name", () => {
    // `🦆` is a brown mallard in every system font — the right word and the
    // wrong colours. `🐤`/`🐥` are the palette the pixel duck is drawn from.
    expect(DUCK_FRAMES).toEqual(["🐤", "🐥"]);
    expect(DUCK_FRAMES).not.toContain("🦆");
  });

  it("is two frames, so the bird turns rather than tells a story", () => {
    expect(DUCK_FRAMES).toHaveLength(2);
    expect(new Set(DUCK_FRAMES).size).toBe(2);
  });

  it("falls back where there is no emoji font at all", () => {
    // A Linux virtual console and TERM=dumb genuinely cannot draw one.
    expect(spinnerFrames({ TERM: "linux" })).toBe(BRAILLE_FRAMES);
    expect(spinnerFrames({ TERM: "dumb" })).toBe(BRAILLE_FRAMES);
    for (const term of ["xterm-256color", "screen-256color", "alacritty", undefined]) {
      expect(spinnerFrames({ ...(term ? { TERM: term } : {}) }), String(term)).toBe(DUCK_FRAMES);
    }
  });

  it("turns slower than the clock ticks", () => {
    // The seconds next to it need a fast tick; a two-frame cycle at that speed
    // is a strobe rather than a bird.
    expect(SPINNER_TICKS_PER_FRAME).toBeGreaterThan(1);
  });
});

describe("the working line", () => {
  it("shows the duck while a turn is running", async () => {
    const { stdin, lastFrame } = render(<App client={hangingClient()} config={{ ...config }} wallet={wallet} />);
    stdin.write("do something");
    await tick();
    stdin.write("\r");
    await tick(150);

    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("working…");
    expect(DUCK_FRAMES.some((f) => frame.includes(f))).toBe(true);
  });

  it("turns the bird as time passes, so the line is visibly alive", async () => {
    const { stdin, lastFrame } = render(<App client={hangingClient()} config={{ ...config }} wallet={wallet} />);
    stdin.write("do something");
    await tick();
    stdin.write("\r");

    // The frame advances every SPINNER_TICKS_PER_FRAME ticks of 120 ms, so a
    // second is comfortably more than one turn of the bird.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await tick(120);
      const frame = strip(lastFrame() ?? "");
      for (const glyph of DUCK_FRAMES) if (frame.includes(glyph)) seen.add(glyph);
    }
    expect(seen.size).toBe(DUCK_FRAMES.length);
  });

  it("takes the duck away with the turn", async () => {
    let finish: ((t: ChatTurn) => void) | undefined;
    const client = {
      models: async () => [],
      wallet: async () => wallet,
      chatStream: () => new Promise<ChatTurn>((resolve) => (finish = resolve)),
    } as unknown as GatewayClient;

    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(150);
    expect(DUCK_FRAMES.some((f) => (lastFrame() ?? "").includes(f))).toBe(true);

    finish?.({ message: { role: "assistant", content: "done" }, finishReason: "stop", creditsCharged: 7, balance: 4981 });
    await tick(200);

    // `lastFrame` carries the scrollback, so the check is on the live region:
    // the working line and its duck go together.
    const frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("esc to stop");
  });
});
