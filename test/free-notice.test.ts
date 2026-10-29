/**
 * What the CLI says about the free models (`src/free-tier.ts`).
 *
 * Every figure is the gateway's, so the tests hand in a wallet and check the
 * sentence, never a number derived here.
 */
import { describe, expect, it } from "vitest";
import { freeAlternativeLine, freeHelpLine, freeModelToName, freeTierNotice, type FreeTier } from "../src/free-tier.ts";
import { helpText } from "../src/tui/commands.ts";

const FREE: FreeTier = {
  models: ["gpt-5-nano", "gemini-2.5-flash-lite", "deepseek-v4-flash", "gemini-3.5-flash-lite", "kimi-k2.5"],
  daily_credits: 12_000,
  credits_left: 12_000,
  turns_left: {
    "gpt-5-nano": 50,
    "gemini-2.5-flash-lite": 30,
    "deepseek-v4-flash": 24,
    "gemini-3.5-flash-lite": 11,
    "kimi-k2.5": 5,
  },
  recommended: "deepseek-v4-flash",
};

/** A paused tier, as the gateway sends it: an empty allowance, not a flag. */
const PAUSED: FreeTier = {
  ...FREE,
  daily_credits: 0,
  credits_left: 0,
  turns_left: Object.fromEntries(FREE.models.map((id) => [id, 0])),
};

const SPENT: FreeTier = { ...PAUSED, daily_credits: 12_000 };

describe("which model to name", () => {
  it("names the model in use when it is free and has turns", () => {
    expect(freeModelToName(FREE, "gpt-5-nano")).toEqual({ id: "gpt-5-nano", turns: 50 });
  });

  it("names the recommendation for somebody on a paid model", () => {
    expect(freeModelToName(FREE, "claude-opus-5.5")).toEqual({ id: "deepseek-v4-flash", turns: 24 });
  });

  it("never names a model with nothing left", () => {
    const drained = { ...FREE, turns_left: { ...FREE.turns_left, "deepseek-v4-flash": 0, "kimi-k2.5": 0 } };
    expect(freeModelToName(drained, "kimi-k2.5")).toEqual({ id: "gpt-5-nano", turns: 50 });
  });

  it("falls back to the first with turns on a gateway that recommends nothing", () => {
    const { recommended: _r, ...older } = FREE;
    expect(freeModelToName(older, "claude-opus-5.5")?.id).toBe("gpt-5-nano");
  });
});

describe("the notice when the REPL opens", () => {
  it("tells somebody on a free model that it is free, and that there are others", () => {
    const line = freeTierNotice({ model: "deepseek-v4-flash", balance: 25_000, free: FREE })!;
    expect(line).toContain("deepseek-v4-flash is free today");
    expect(line).toContain("about 24 turns left");
    expect(line).toContain("/model");
  });

  it("tells somebody on a paid model how to get to a free one", () => {
    const line = freeTierNotice({ model: "claude-opus-5.5", balance: 25_000, free: FREE })!;
    expect(line).toContain("5 models are free today");
    expect(line).toContain("/model");
    expect(line).toContain("deepseek-v4-flash");
  });

  it("leads with the empty balance when there is one", () => {
    const line = freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: FREE })!;
    expect(line).toMatch(/^Your balance is empty, but deepseek-v4-flash is still free today/);
    expect(line).toContain("/earn");
  });

  it("says when the free turns come back if both are gone", () => {
    const line = freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: SPENT })!;
    expect(line).toContain("midnight UTC");
    expect(line).toContain("/earn");
  });

  it("names the cheapest pack when nothing free is left, and only with the gateway's figure", () => {
    const line = freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: SPENT, cheapestPackUsd: 3 })!;
    expect(line).toBe(
      "Your balance is empty and today's free turns are used up. They come back at midnight UTC, " +
        "and /earn tops up before then, or a pack from $3 with /buy.",
    );
    // No figure from the gateway (an older one, or one that sells nothing): the line as it was.
    for (const cheapestPackUsd of [null, undefined, 0]) {
      expect(freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: SPENT, cheapestPackUsd })).toBe(
        "Your balance is empty and today's free turns are used up. They come back at midnight UTC, " +
          "and /earn tops up before then.",
      );
    }
    // While a free model still has turns, that is the way on, and no pack is named.
    expect(freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: FREE, cheapestPackUsd: 3 })).not.toContain(
      "/buy",
    );
  });

  it("says nothing on a paused tier, an older gateway, or a spent day with credits in hand", () => {
    expect(freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: PAUSED })).toBeUndefined();
    expect(freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: undefined })).toBeUndefined();
    expect(freeTierNotice({ model: "claude-opus-5.5", balance: 9_000, free: SPENT })).toBeUndefined();
  });

  it("puts no dash where a comma or a full stop will do", () => {
    // Public copy follows one house rule about dashes; these lines are public.
    for (const line of [
      freeTierNotice({ model: "deepseek-v4-flash", balance: 1, free: FREE }),
      freeTierNotice({ model: "claude-opus-5.5", balance: 1, free: FREE }),
      freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: FREE }),
      freeTierNotice({ model: "claude-opus-5.5", balance: 0, free: SPENT }),
    ]) {
      expect(line).not.toContain("—");
    }
  });
});

describe("/help", () => {
  it("leads with the free models while there are any", () => {
    const text = helpText(freeHelpLine({ ...FREE, credits_left: 8_400 }));
    expect(text.split("\n")[0]).toContain("free today");
    expect(text.split("\n")[0]).toContain("8,400 free credits left");
    expect(text.split("\n")[0]).toContain("/model");
  });

  it("says when they come back once they are gone", () => {
    expect(helpText(freeHelpLine(SPENT)).split("\n")[0]).toContain("midnight UTC");
  });

  it("is the old list on a gateway with no free tier", () => {
    expect(freeHelpLine(PAUSED)).toBeUndefined();
    expect(helpText(freeHelpLine(undefined))).toBe(helpText());
    expect(helpText().split("\n")[0]).toContain("/help");
  });
});

describe("a one-shot command refused for credits", () => {
  it("names a free model with the shell command that switches to it", () => {
    const line = freeAlternativeLine([{ id: "deepseek-v4-flash", turnsLeft: 24 }])!;
    expect(line).toContain("clixad model deepseek-v4-flash");
    expect(line).not.toContain("/model");
    expect(line).toContain("run it again");
  });

  it("says nothing when nothing is free", () => {
    expect(freeAlternativeLine([])).toBeUndefined();
    expect(freeAlternativeLine([{ id: "kimi-k2.5", turnsLeft: 0 }])).toBeUndefined();
  });
});
