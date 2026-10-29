/**
 * What the REPL says about an account it could not read, and whom it welcomes.
 *
 * Unknown is not zero. The status row said "0 cr" and the banner "0 credits"
 * whenever the startup read failed, which is the one misreading on that screen
 * that looks like the account has been emptied. And the banner said "Welcome
 * back" to everybody with a name, including an account four seconds old.
 */
import { describe, expect, it } from "vitest";
import { compactBanner, visibleLength, welcomeBanner } from "../src/banner.ts";
import { statusLine } from "../src/tui/app.tsx";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const base = {
  name: "ada",
  model: "deepseek-v4-flash",
  balance: 25_000 as number | undefined,
  adsToday: 0,
  earnedUsdToday: 0,
  maxRewardUsd: 5,
  cwd: "/tmp/project",
  version: "v0.0.1",
  tipIndex: 0,
};

describe("a balance nobody has read yet", () => {
  it("is '? cr' on the status row, never '0 cr'", () => {
    const line = statusLine({ model: "deepseek-v4-flash", balance: undefined, spent: 0, contextPct: 0, minutes: 0 }, 100);
    expect(line).toContain("? cr");
    expect(line).not.toContain("0 cr");
  });

  it("is a figure again as soon as there is one", () => {
    const line = statusLine({ model: "deepseek-v4-flash", balance: 25_200, spent: 0, contextPct: 0, minutes: 0 }, 100);
    expect(line).toContain("25,200 cr");
  });

  it("is 'balance unavailable' in both banners, with no invented earnings beside it", () => {
    for (const banner of [welcomeBanner, compactBanner]) {
      const out = strip(banner({ ...base, balance: undefined, width: 100 }));
      expect(out).toContain("balance unavailable");
      expect(out).not.toMatch(/\b0 credits\b/);
      expect(out).not.toContain("$0.00/$5.00");
    }
  });
});

describe("the greeting", () => {
  it("welcomes a new account as new, and a returning one as back", () => {
    expect(strip(welcomeBanner({ ...base, width: 100, newAccount: true }))).toContain("Welcome to Clixad, ada!");
    expect(strip(welcomeBanner({ ...base, width: 100 }))).toContain("Welcome back, ada!");
    expect(strip(compactBanner({ ...base, width: 60, newAccount: true }))).toContain("Welcome to Clixad, ada!");
  });

  it("keeps a long name inside the box at the narrowest width", () => {
    for (const newAccount of [true, false]) {
      const out = welcomeBanner({ ...base, name: "a-very-long-github-login-name", width: 66, newAccount });
      for (const row of out.split("\n")) expect(visibleLength(row), row).toBeLessThanOrEqual(66);
    }
  });
});
