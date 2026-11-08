/**
 * Tool results sized to the model's window (`room.ts`).
 *
 * A result larger than a request can hold cannot be kept: compaction can only
 * summarise it, and a model that asked for it reads it again. So it is cut to
 * the room it is given, and the cut is said where it is.
 */
import { describe, expect, it } from "vitest";
import { compactBudget, requestTokens } from "../src/compact.ts";
import { fitResult, jsonBytes, mentionRoom, roundRoom } from "../src/room.ts";

describe("what a result weighs", () => {
  it("is its JSON bytes, escapes and all", () => {
    expect(jsonBytes("abc")).toBe(3);
    expect(jsonBytes("a\tb\n")).toBe(6);
    expect(jsonBytes('say "hi"')).toBe(10);
    expect(jsonBytes("€")).toBe(3);
  });

  it("agrees with what a tool message weighs in a request", () => {
    const text = "  12\tconst a = \"x\";\n".repeat(500);
    const weight = requestTokens([{ role: "tool", tool_call_id: "c", content: text }]);
    expect(weight * 4).toBeGreaterThanOrEqual(jsonBytes(text));
    expect(weight * 4).toBeLessThan(jsonBytes(text) + 100);
  });
});

describe("the room a round and an attachment are given", () => {
  it("is a third and a half of the budget, in bytes at four a token", () => {
    expect(roundRoom(24_000)).toBe(24_000);
    expect(Math.abs(roundRoom(78_000) / 4 - compactBudget(78_000) / 3)).toBeLessThan(1);
    expect(mentionRoom(24_000) / 4).toBe(compactBudget(24_000) / 2);
  });
});

describe("a result cut to its room", () => {
  const big = Array.from({ length: 4_000 }, (_, i) => `match ${i}: src/file${i}.ts`).join("\n");

  it("is untouched when it fits, or when there is no room to keep to", () => {
    expect(fitResult("grep", "one line", 100)).toBe("one line");
    expect(fitResult("grep", big, undefined)).toBe(big);
  });

  it("fits the room, keeps its start, and says how much was left out and how to get it", () => {
    const out = fitResult("grep", big, 5_000);
    expect(jsonBytes(out)).toBeLessThanOrEqual(5_000);
    expect(jsonBytes(out)).toBeGreaterThan(4_500);
    expect(out.startsWith("match 0: src/file0.ts")).toBe(true);
    expect(out).toMatch(/characters left out after this: more than one result takes on this model\. Narrow the pattern/);
    const left = Number(/\[([\d,]+) characters left out/.exec(out)![1]!.replace(/,/g, ""));
    expect(big.startsWith(out.slice(0, out.indexOf("\n… [")))).toBe(true);
    expect(out.indexOf("\n… [") + left).toBe(big.length);
  });

  it("keeps both ends of a command's output, where the error usually is", () => {
    const output = `exit 1\n${"compiling...\n".repeat(3_000)}error TS2304: Cannot find name 'foo'.\n`;
    const out = fitResult("run_command", output, 4_000);
    expect(jsonBytes(out)).toBeLessThanOrEqual(4_000);
    expect(out.startsWith("exit 1\n")).toBe(true);
    expect(out.endsWith("error TS2304: Cannot find name 'foo'.\n")).toBe(true);
    expect(out).toContain("characters left out here");
    expect(out).toContain("Filter the output");
  });

  it("never splits a character in two", () => {
    const emoji = "😀".repeat(5_000);
    const out = fitResult("web_fetch", emoji, 1_000);
    expect(jsonBytes(out)).toBeLessThanOrEqual(1_000);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
