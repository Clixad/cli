/**
 * When a booked line is drawn as a link. Only terminals that say who they are
 * and are known to understand OSC 8 get one; everything else gets the text.
 */
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { hyperlinksEnabled, osc8 } from "../src/sponsor/hyperlink.ts";

const on = (env: Record<string, string>, isTTY = true) => hyperlinksEnabled({ isTTY, env });

describe("hyperlinksEnabled", () => {
  it("recognises the terminals that understand links", () => {
    expect(on({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.0" })).toBe(true);
    expect(on({ TERM_PROGRAM: "WezTerm" })).toBe(true);
    expect(on({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.95.3" })).toBe(true);
    expect(on({ WT_SESSION: "abc" })).toBe(true);
    expect(on({ TERM: "xterm-kitty" })).toBe(true);
    expect(on({ VTE_VERSION: "7600" })).toBe(true);
  });

  it("says no to the rest, and to versions that predate it", () => {
    expect(on({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(on({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.0.15" })).toBe(false);
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.71.0" })).toBe(false);
    expect(on({ VTE_VERSION: "5000" })).toBe(false);
    expect(on({})).toBe(false);
    expect(on({ TERM_PROGRAM: "WezTerm" }, false)).toBe(false);
    expect(on({ TERM_PROGRAM: "WezTerm", CI: "true" })).toBe(false);
    expect(on({ TERM_PROGRAM: "WezTerm", TERM: "dumb" })).toBe(false);
  });

  it("lets FORCE_HYPERLINK decide either way", () => {
    expect(on({ FORCE_HYPERLINK: "1" }, false)).toBe(true);
    expect(on({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "WezTerm" })).toBe(false);
  });
});

describe("osc8", () => {
  it("wraps the text without changing its width, and keeps control bytes out of the address", () => {
    const linked = osc8("Acme: ship on Friday", "https://clixad.onrender.com/go?c=abc\u0007\u001b]8;;evil");
    expect(stringWidth(linked)).toBe("Acme: ship on Friday".length);
    expect(linked).toBe("\u001b]8;;https://clixad.onrender.com/go?c=abc]8;;evil\u0007Acme: ship on Friday\u001b]8;;\u0007");
  });
});
