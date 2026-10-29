/**
 * The cost preview (`src/estimate.ts`).
 *
 * The one figure the CLI multiplies out itself. That it agrees with the
 * gateway's pricing engine is checked where the engine is,
 * `test/monorepo/estimate-engine.test.ts`; what is here is the CLI's own half.
 */
import { describe, expect, it } from "vitest";
import { estimateClause, parseTaskShape, shortCredits, taskVerdict, type TaskShape } from "../src/estimate.ts";

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
