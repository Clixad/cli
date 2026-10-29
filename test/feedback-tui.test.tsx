/**
 * The feedback prompt as it actually reaches a screen.
 *
 * Everything about this feature that can go wrong is a property of *when* the
 * prompt appears and *what it costs*, and neither is a property of any single
 * function — so only a rendered frame can settle them. Four things are pinned:
 *
 *  1. It appears on the fiftieth turn and not on the forty-ninth. The count is
 *     seeded through `config.turns` rather than by running fifty turns, which is
 *     also the honest version of the mechanism: the count is per **install** and
 *     lives in `~/.clixad/config.json`, precisely because a session almost never
 *     reaches fifty turns while an install reaches it in a week.
 *  2. Skipping — the third row, or esc — sends nothing at all. That is what makes
 *     skipping free, and there is deliberately no "skipped" rating: declining to
 *     answer is not a data point, and a value for it would sit in an eval set
 *     forever meaning nothing.
 *  3. A thumbs-down sends exactly what a thumbs-up sends, minus the verdict. The
 *     gateway is what enforces equal pay, but the prompt has to *say* it before
 *     the choice is made, or the user supplies the bias on our behalf.
 *  4. The credit figure on the prompt comes out of the wallet. The CLI cannot
 *     import the pricing engine, so a number typed into this program is a literal
 *     nothing forces to agree with the engine.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type {
  ChatMessage,
  ChatOptions,
  ChatTurn,
  FeedbackReport,
  GatewayClient,
  WalletInfo,
} from "../src/client.ts";

const baseConfig: CliConfig = {
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
  rewards: { feedback_credits: 500 },
  ledger: [],
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";
const ARROW_DOWN = "\x1b[B";

/** A client that answers one turn, and records anything rated. */
function client() {
  const sent: FeedbackReport[] = [];
  const api = {
    models: async () => [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }],
    wallet: async () => wallet,
    claimStreak: async () => null,
    sendFeedback: async (report: FeedbackReport) => {
      sent.push(report);
      return { recorded: true, credited: 500, balance: 5_488 };
    },
    async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
      opts.onDelta?.("the import path is missing its .ts extension");
      return {
        message: { role: "assistant", content: "the import path is missing its .ts extension" },
        finishReason: "stop",
        creditsCharged: 7,
        balance: 4981,
      } as ChatTurn;
    },
  } as unknown as GatewayClient;
  return { api, sent };
}

/** Run one turn against a config whose install has already seen `turns` of them. */
async function turnAt(turns: number) {
  const { api, sent } = client();
  const config = { ...baseConfig, turns };
  const { stdin, lastFrame } = render(<App client={api} config={config} wallet={wallet} />);
  stdin.write("why does the build fail?");
  await tick();
  stdin.write("\r");
  await tick(300);
  return { stdin, lastFrame, sent };
}

describe("the feedback prompt", () => {
  it("does not interrupt a turn that is not the fiftieth", async () => {
    const { lastFrame } = await turnAt(0);
    expect(strip(lastFrame() ?? "")).not.toContain("Was that last answer any good?");
  });

  it("appears on the fiftieth turn of the install", async () => {
    // 49 already run, so the turn below is the fiftieth. The count is per
    // install rather than per session: counted per session this feature would
    // exist only in the source.
    const { lastFrame } = await turnAt(49);
    expect(strip(lastFrame() ?? "")).toContain("Was that last answer any good?");
  });

  it("says both answers pay the same, and what they pay, before the choice", async () => {
    const { lastFrame } = await turnAt(49);
    const out = strip(lastFrame() ?? "");
    // The figure is the wallet's, never this program's — and the equality has to
    // be on screen, or the user supplies the bias we went to some trouble to
    // keep out of the data.
    expect(out).toContain("Both answers pay 500 credits");
    expect(out).toContain("esc skips");
  });

  it("says the exchange is kept, because it is", async () => {
    // The one place in this product where a prompt and a response are written
    // down. Somebody agreeing to that should be told they are.
    expect(strip((await turnAt(49)).lastFrame() ?? "")).toContain("we keep that exchange");
  });
});

describe("answering it", () => {
  it("sends the exchange with the rating on a thumbs-up", async () => {
    const { stdin, sent } = await turnAt(49);
    stdin.write("\r"); // the first row
    await tick(200);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      rating: "up",
      model: "gemini-2.5-flash-lite",
      prompt: "why does the build fail?",
      response: "the import path is missing its .ts extension",
    });
    // Both halves of the idempotency key, so a retry after a dropped connection
    // neither pays twice nor stores the same exchange twice.
    expect(sent[0]!.session).toBeTruthy();
    expect(sent[0]!.turn).toBe(49);
  });

  it("sends exactly the same thing on a thumbs-down, minus the verdict", async () => {
    const { stdin, sent } = await turnAt(49);
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(200);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.rating).toBe("down");
    // Nothing else about the report differs, which is what makes the gateway's
    // equal payment a property of the data rather than of a code path.
    expect(sent[0]!.response).toBe("the import path is missing its .ts extension");
  });

  it("reports what it paid", async () => {
    const { stdin, lastFrame } = await turnAt(49);
    stdin.write("\r");
    await tick(200);
    expect(strip(lastFrame() ?? "")).toContain("+500 credits");
  });
});

describe("skipping it", () => {
  it("sends nothing when the skip row is chosen", async () => {
    const { stdin, sent } = await turnAt(49);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(200);
    // No request, no row, no rating. There is no "skipped" value on purpose:
    // declining to answer is not a data point.
    expect(sent).toHaveLength(0);
  });

  it("sends nothing on esc, and hands the keyboard straight back", async () => {
    const { stdin, lastFrame, sent } = await turnAt(49);
    stdin.write(ESC);
    await tick(150);

    expect(sent).toHaveLength(0);
    const out = strip(lastFrame() ?? "");
    expect(out).not.toContain("Was that last answer any good?");
    // Esc and the skip row are the same outcome — a skip that cost something is
    // a prompt people stop reading.
    stdin.write("next");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("next");
  });

  it("does not ask again about the same exchange", async () => {
    const { stdin, lastFrame, sent } = await turnAt(49);
    stdin.write(ESC);
    await tick(150);
    // The turn was consumed when the prompt opened, so the next turn is turn 51
    // and there is nothing due. Asking twice about one answer would be the
    // fastest way to make this feature unwelcome.
    stdin.write("and now?");
    await tick();
    stdin.write("\r");
    await tick(300);
    expect(strip(lastFrame() ?? "")).not.toContain("Was that last answer any good?");
    expect(sent).toHaveLength(0);
  });
});

describe("a gateway that says nothing about rewards", () => {
  it("drops the figure rather than inventing one", async () => {
    const { api } = client();
    const noRewards = { ...wallet } as WalletInfo;
    delete noRewards.rewards;
    const { stdin, lastFrame } = render(
      <App client={api} config={{ ...baseConfig, turns: 49 }} wallet={noRewards} />,
    );
    stdin.write("why does the build fail?");
    await tick();
    stdin.write("\r");
    await tick(300);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Both answers pay the same");
    // An older gateway sends no figure, and a figure typed into this program is
    // a literal nothing forces to agree with the engine.
    expect(out).not.toMatch(/pay [\d,]+ credits/);
  });
});
