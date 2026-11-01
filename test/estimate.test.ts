/**
 * The cost preview (`src/estimate.ts`).
 *
 * The one figure the CLI multiplies out itself. That it agrees with the
 * gateway's pricing engine is checked where the engine is,
 * `test/monorepo/estimate-engine.test.ts`; what is here is the CLI's own half.
 */
import { describe, expect, it } from "vitest";
import {
  estimateClause,
  parseTaskShape,
  premiumLowNotice,
  premiumShortNotice,
  rowTaskHint,
  shortCredits,
  spendOn,
  taskHint,
  taskVerdict,
  type TaskShape,
} from "../src/estimate.ts";
import type { ModelInfo } from "../src/client.ts";

describe("the shape", () => {
  it("refuses anything that is not a whole, sensible shape", () => {
    const good = { calls_typical: 2, calls_long: 10, growth_tokens: 300, output_tokens: 600 };
    expect(parseTaskShape(undefined)).toBeUndefined();
    expect(parseTaskShape("2..10")).toBeUndefined();
    expect(parseTaskShape({ ...good, calls_typical: 0 })).toBeUndefined();
    expect(parseTaskShape({ ...good, calls_long: 1 })).toBeUndefined();
    expect(parseTaskShape({ ...good, growth_tokens: "300" })).toBeUndefined();
    expect(parseTaskShape({ ...good, output_tokens: Number.NaN })).toBeUndefined();
    expect(parseTaskShape(good)).toBeDefined();
  });
});

describe("whether it fits", () => {
  const range = { low: 1_000, high: 5_000 };

  it("is free when today's allowance covers a long task on its own", () => {
    expect(taskVerdict(range, { balance: 0, freeLeft: 5_000 })).toBe("free");
  });

  it("fits when allowance and balance together cover a long task", () => {
    expect(taskVerdict(range, { balance: 3_000, freeLeft: 2_000 })).toBe("fits");
    expect(taskVerdict(range, { balance: 25_000 })).toBe("fits");
  });

  it("may run short when only a typical task is covered", () => {
    expect(taskVerdict(range, { balance: 1_000 })).toBe("tight");
  });

  it("is short when not even a typical task is covered, a negative balance included", () => {
    expect(taskVerdict(range, { balance: 999 })).toBe("short");
    expect(taskVerdict(range, { balance: -4_000 })).toBe("short");
  });
});

describe("what the status line says", () => {
  it("keeps the printed range around the computed one", () => {
    expect(shortCredits(562, "down")).toBe("562");
    expect(shortCredits(3_060, "up")).toBe("3.1k");
    expect(shortCredits(3_060, "down")).toBe("3k");
    expect(shortCredits(19_050, "down")).toBe("19k");
    expect(shortCredits(122_625, "up")).toBe("123k");
    expect(shortCredits(1_234_567, "up")).toBe("1.3M");
  });

  it("names the way on that costs nothing, when there is one", () => {
    const range = { low: 19_000, high: 100_000 };
    expect(estimateClause(range, "short", true)).toEqual({
      variants: ["task ≈ 19k–100k · not enough, /model", "≈19k–100k, not enough", "≈19k–100k short"],
      warn: true,
    });
    expect(estimateClause(range, "short", false).variants[0]).toContain("/earn");
    expect(estimateClause(range, "tight", true)).toMatchObject({ warn: true });
    expect(estimateClause(range, "tight", true).variants[0]).toBe("task ≈ 19k–100k · may run short");
  });

  it("keeps the verdict in words in every phrasing, since colour is not always there", () => {
    const range = { low: 19_000, high: 100_000 };
    for (const v of estimateClause(range, "short", true).variants) expect(v).toMatch(/not enough|short/);
    for (const v of estimateClause(range, "tight", true).variants) expect(v).toMatch(/run short|tight/);
    for (const v of estimateClause(range, "free", true).variants) expect(v).toContain("free");
  });

  it("stays quiet in colour when the task is covered", () => {
    expect(estimateClause({ low: 562, high: 3_060 }, "fits", false)).toEqual({
      variants: ["task ≈ 562–3.1k cr", "≈562–3.1k cr"],
      warn: false,
    });
    expect(estimateClause({ low: 562, high: 3_060 }, "free", false)).toMatchObject({ warn: false });
  });
});

/** Kept here so a change to the shape type is a compile error in this file too. */
export type _Shape = TaskShape;

describe("the floor on a raised /effort", () => {
  it("says only what a task costs at least, with the verdict in words", () => {
    const range = { low: 4_200, high: 26_000 };
    expect(estimateClause(range, "fits", false, { floor: true }).variants[0]).toBe("task ≥ 4.2k cr");
    expect(estimateClause(range, "short", false, { floor: true }).variants[0]).toBe("task ≥ 4.2k · not enough, /earn");
  });
});

describe("the premium figure in the preview", () => {
  it("is named in the longest phrasing of a warning, and the shorter ones are kept", () => {
    const out = estimateClause({ low: 31_000, high: 164_000 }, "short", false, { against: "9.8k premium" });
    expect(out.variants[0]).toBe("task ≈ 31k–164k · 9.8k premium · not enough, /earn");
    expect(out.variants).toContain("task ≈ 31k–164k · not enough, /earn");
    expect(out.warn).toBe(true);
  });

  it("is not named on a task that fits", () => {
    expect(estimateClause({ low: 1_000, high: 2_000 }, "fits", false, { against: "9.8k premium" }).variants[0]).toBe(
      "task ≈ 1k–2k cr",
    );
  });
});

describe("what a model may spend", () => {
  const premium = { id: "claude-sonnet-5.5", access: "premium" as const, free: false };
  const budget = { id: "kimi-k2.5", access: "budget" as const, free: false };
  const free = { id: "deepseek-v4-flash", access: "budget" as const, free: true };

  it("takes the gateway's figure for the kind of model when there is one", () => {
    const figures = { budget: 1_200, premium: 500 };
    expect(spendOn(premium, { balance: 33_396, figures }).credits).toBe(500);
    expect(spendOn(budget, { balance: 33_396, figures }).credits).toBe(1_200);
  });

  it("falls back to premium access on a premium model, and to the balance otherwise", () => {
    expect(spendOn(premium, { balance: 33_396, premium: { unlocked: false, credits: 9_800 } }).credits).toBe(9_800);
    expect(spendOn(premium, { balance: 33_396, premium: { unlocked: true, credits: 0 } }).credits).toBe(33_396);
    expect(spendOn(budget, { balance: 33_396, premium: { unlocked: false, credits: 9_800 } }).credits).toBe(33_396);
  });

  it("counts the free allowance only on a model in today's free set", () => {
    const allowance = { models: ["deepseek-v4-flash"], credits_left: 60_000 };
    expect(spendOn(free, { balance: 0, free: allowance }).freeLeft).toBe(60_000);
    expect(spendOn(budget, { balance: 0, free: allowance }).freeLeft).toBeUndefined();
  });
});

describe("what a model row says", () => {
  it("puts the verdict before the figure, since a row is cut from the right", () => {
    const range = { low: 31_000, high: 164_000 };
    expect(taskHint(range, "short", { credits: 9_800, premium: true, heldBack: true })).toBe(
      "task ≈ 31k–164k · not enough (9.8k premium credits)",
    );
    expect(taskHint(range, "tight", { credits: 40_000, premium: false, heldBack: false })).toBe(
      "task ≈ 31k–164k · may run short (40k credits)",
    );
    expect(taskHint(range, "tight", { credits: 40_000, premium: false, heldBack: true })).toBe(
      "task ≈ 31k–164k · may run short (40k usable)",
    );
    expect(taskHint(range, "fits", { credits: 400_000, premium: true, heldBack: false })).toBe("task ≈ 31k–164k · covered");
    // A free row already says it is free.
    expect(taskHint(range, "free", { credits: 0, premium: false, heldBack: false })).toBe("task ≈ 31k–164k");
    expect(taskHint(range, "short", { credits: 0, premium: false, heldBack: false, floor: true })).toBe(
      "task ≥ 31k · not enough (0 credits)",
    );
  });

  it("is worked out at the conversation's size, and is absent without a task shape", () => {
    const sonnet = {
      id: "claude-sonnet-5.5",
      access: "premium",
      free: false,
      credits_per_mtoken_input: 300_000,
      credits_per_mtoken_output: 1_500_000,
    } as unknown as ModelInfo;
    const shape: TaskShape = { callsTypical: 2, callsLong: 15, growthTokens: 500, outputTokens: 600 };
    const spend = { balance: 33_396, premium: { unlocked: false, credits: 9_800 } };
    const fresh = rowTaskHint(sonnet, { shape, contextTokens: 4_000, spend, floor: false })!;
    const long = rowTaskHint(sonnet, { shape, contextTokens: 50_000, spend, floor: false })!;
    expect(fresh).toMatch(/^task ≈ \d[\d.]*k–\d+k · may run short \(9\.8k premium credits\)$/);
    expect(long).toMatch(/^task ≈ \d+k–\d+k · not enough \(9\.8k premium credits\)$/);
    expect(rowTaskHint(sonnet, { shape: undefined, contextTokens: 4_000, spend, floor: false })).toBeUndefined();
  });
});

describe("the premium notices", () => {
  it("say what a task that would stop part way costs, and that Enter sends it anyway", () => {
    const text = premiumShortNotice({
      model: "claude-sonnet-5.5",
      range: { low: 31_000, high: 164_000 },
      credits: 9_800,
      unlockUsd: 3,
    });
    expect(text).toContain("likely costs about 31k–164k credits on claude-sonnet-5.5");
    expect(text).toContain("premium models can spend 9,800 of yours");
    expect(text).toContain("Enter sends it anyway");
    expect(text).toContain("/buy sells credits from $3");
    expect(premiumShortNotice({ model: "m", range: { low: 31_000, high: 164_000 }, credits: 9_800, unlockUsd: null })).not.toContain("/buy");
  });

  it("say the floor, not a range, on a raised /effort", () => {
    expect(
      premiumShortNotice({ model: "m", range: { low: 31_000, high: 164_000 }, credits: 9_800, floor: true, unlockUsd: null }),
    ).toContain("at least 31k credits");
  });

  it("say after a turn that what is left is under a typical next task", () => {
    expect(premiumLowNotice({ model: "claude-sonnet-5.5", credits: 12_000, low: 31_000, unlockUsd: 3 })).toBe(
      "  12,000 premium credits left, under what a typical next task on claude-sonnet-5.5 costs (about 31k). " +
        "/model picks a budget model, /earn or /buy adds credits.",
    );
  });
});
