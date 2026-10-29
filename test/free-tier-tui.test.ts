/**
 * What the terminal says about the free tier.
 *
 * Three surfaces, and none of them may do money arithmetic. The CLI cannot
 * import the pricing engine (the bundle ships standalone through npm), so every
 * figure here arrives finished from the gateway, and the tests below check that
 * what is *rendered* is what was *sent*, never a number this package derived.
 * The rule the sponsored line's `needs` placeholders and `streakLabel` follow.
 *
 * The status-line half is also a frame test in disguise. That row is counted as
 * exactly one row by `chromeHeight`, and the input box is pinned to the bottom
 * by that count — so a clause that pushes it to two rows moves the box for the
 * rest of the session. Adding one without extending the drop-by-rank loop is
 * precisely how that happened last time.
 */
import { describe, expect, it } from "vitest";
import { modelHint, statusLine, turnMeta } from "../src/tui/app.tsx";
import { visibleLength } from "../src/banner.ts";
import type { ModelInfo } from "../src/client.ts";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "gpt-5-nano",
  label: "GPT-5 Nano",
  provider: "openai",
  tier: "cheap",
  ad_fundable: true,
  credits_per_mtoken_input: 7_500,
  credits_per_mtoken_output: 60_000,
  est_credits_per_task: 1_650,
  est_ads_per_task: 0.04,
  free: true,
  ...over,
});

/** What `/v1/wallet` sends: five free models with wildly different turn counts. */
const allowance = {
  models: ["gpt-5-nano", "gemini-2.5-flash-lite", "deepseek-v4-flash", "gemini-3.5-flash-lite", "kimi-k2.5"],
  turns_left: {
    "gpt-5-nano": 31,
    "gemini-2.5-flash-lite": 19,
    "deepseek-v4-flash": 15,
    "gemini-3.5-flash-lite": 6,
    "kimi-k2.5": 3,
  },
};

describe("the model picker", () => {
  it("says how many free turns are left, per model", () => {
    // The thing the picker exists to show: the same allowance is thirty turns
    // on one free model and three on another, and nothing else on screen says
    // so. A single "free" badge on every row would hide exactly that.
    expect(modelHint(model(), allowance)).toContain("free: ~31 turns left");
    expect(modelHint(model({ id: "kimi-k2.5" }), allowance)).toContain("free: ~3 turns left");
  });

  it("prints the gateway's figure verbatim, deriving nothing", () => {
    const odd = { ...allowance, turns_left: { ...allowance.turns_left, "gpt-5-nano": 7 } };
    expect(modelHint(model(), odd)).toContain("~7 turns");
  });

  it("counts one turn in the singular", () => {
    // The last free turn of the day is the one somebody is most likely to be
    // looking at, and "~1 turns left" is the row that reads as unfinished.
    const one = { ...allowance, turns_left: { ...allowance.turns_left, "gpt-5-nano": 1 } };
    expect(modelHint(model(), one)).toContain("~1 turn left");
    expect(modelHint(model(), one)).not.toContain("~1 turns");
  });

  it("still shows what a model costs once the free turns run out", () => {
    // A free model is not a free model forever: past the allowance it costs
    // offers like everything else, so the effort estimate never goes away.
    const spent = { ...allowance, turns_left: { ...allowance.turns_left, "gpt-5-nano": 0 } };
    const hint = modelHint(model(), spent);
    expect(hint).toContain("free: none left today");
    expect(hint).toContain("on completion");
  });

  it("says nothing about free for a model that never was", () => {
    // Silence, not "not free": a row that has never been free has nothing to
    // report, and a negative badge on nine of fourteen rows is noise.
    const hint = modelHint(model({ id: "claude-opus-5.5", free: false }), allowance);
    expect(hint).not.toContain("free");
    expect(hint).toContain("on completion");
  });

  it("needs the catalog and the account to agree before it claims free", () => {
    // A paused tier answers with an empty allowance, so the catalog flag alone
    // must never leave "free" on screen.
    expect(modelHint(model(), undefined)).not.toContain("free");
    expect(modelHint(model(), { models: [], turns_left: {} })).not.toContain("free");
  });
});

describe("the turn meta line", () => {
  const balance = 4_988;

  it("reads exactly as it always has on a paid turn", () => {
    expect(turnMeta({ creditsCharged: 240, creditsWaived: 0, balance })).toBe(
      "[240 credits · balance 4,988]",
    );
  });

  it("says what a free turn would have cost, and what is left", () => {
    // "0 credits" on its own is a number somebody will assume is a bug.
    const line = turnMeta({ creditsCharged: 0, creditsWaived: 390, freeCreditsLeft: 7_110, balance });
    expect(line).toContain("free");
    expect(line).toContain("390 credits waived");
    expect(line).toContain("7,110 free credits left");
    expect(line).not.toContain("0 credits ·");
  });

  it("says both when the allowance ran out mid-turn", () => {
    // The ordinary way an allowance ends, and neither figure alone describes it.
    const line = turnMeta({ creditsCharged: 1_200, creditsWaived: 300, balance });
    expect(line).toContain("free: 300");
    expect(line).toContain("then 1,200 charged");
  });
});

describe("the status line", () => {
  const session = {
    model: "gemini-2.5-flash-lite",
    balance: 4_988,
    spent: 148_230,
    contextPct: 0.81,
    minutes: 6,
    freeLeft: 7_110,
  };

  for (const cols of [120, 100, 80, 60, 40, 30, 20, 12]) {
    it(`stays one row at ${cols} columns with the free clause present`, () => {
      const line = statusLine(session, cols);
      expect(visibleLength(line)).toBeLessThanOrEqual(cols);
      expect(line).not.toContain("\n");
    });
  }

  it("shows what is left of the allowance", () => {
    expect(statusLine(session, 120)).toContain("free 7,110");
  });

  it("shows a spent allowance rather than hiding it", () => {
    // `free 0` is how somebody finds out why their balance started moving,
    // without having to have read a notice they scrolled past.
    expect(statusLine({ ...session, freeLeft: 0 }, 120)).toContain("free 0");
  });

  it("says nothing when there is no free tier or the model is not in it", () => {
    const { freeLeft: _drop, ...paid } = session;
    expect(statusLine(paid, 120)).not.toContain("free");
  });

  it("outranks the context warning but never the balance", () => {
    // Both are news; this one decides whether the *next* turn costs anything,
    // which is the stronger claim on the row.
    const tight = statusLine(session, 58);
    expect(tight).toContain("free 7,110");
    expect(tight).toContain("4,988 cr");

    const narrow = statusLine(session, 34);
    expect(narrow).toContain("gemini-2.5-flash-lite");
    expect(narrow).toContain("4,988 cr");
  });
});

describe("the status line with a cost preview", () => {
  const session = {
    model: "claude-opus-5.5",
    balance: 4_988,
    spent: 148_230,
    contextPct: 0.81,
    minutes: 6,
    estimate: ["task ≈ 19k–100k · not enough, /model", "≈19k–100k, not enough", "≈19k–100k short"],
  };

  for (const cols of [120, 100, 80, 60, 40, 30, 20, 12]) {
    it(`stays one row at ${cols} columns`, () => {
      // One more clause, one more rank, and the drop-by-rank loop has to reach
      // it before `fitRow` cuts a row that would otherwise wrap.
      expect(visibleLength(statusLine(session, cols))).toBeLessThanOrEqual(cols);
    });
  }

  it("keeps the preview after every other optional clause has gone", () => {
    // It only exists while a task is being typed, and it answers the question
    // the person is asking right then.
    const line = statusLine(session, 66);
    expect(line).toContain("task ≈ 19k–100k · not enough, /model");
    expect(line).toContain("4,988 cr");
    expect(line).not.toContain("/help");
    expect(line).not.toContain("context");
  });

  it("shortens the preview before giving it up, at the width an 80-column terminal leaves", () => {
    // 80 columns minus the mode clause is about 58, where the full sentence and
    // a long model id do not fit together. The verdict survives in words.
    const line = statusLine(session, 58);
    expect(line).toContain("≈19k–100k, not enough");
    expect(line).toContain("claude-opus-5.5");
    expect(line).toContain("4,988 cr");
  });

  it("gives the preview up only where not even its shortest phrasing fits", () => {
    const line = statusLine(session, 30);
    expect(line).not.toContain("≈");
    expect(line).toContain("4,988 cr");
  });

  it("is absent when nothing is being typed", () => {
    const { estimate: _e, ...idle } = session;
    expect(statusLine(idle, 200)).not.toContain("task ≈");
  });
});
