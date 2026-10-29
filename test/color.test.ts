/**
 * Redirected output has to be clean.
 *
 * The one-shot commands wrote ANSI unconditionally, so `clixad models > list`,
 * `clixad wallet | grep` and `clixad -p "…" > answer.txt` all produced files
 * full of escape codes — while the sponsored line refused to draw one
 * decorative row unless the stream was a terminal, and `title.ts` refused to
 * send an escape anywhere but a TTY. Same rule, same reason, now applied to the
 * colour too.
 */
import { describe, expect, it } from "vitest";
import { colorEnabled, palette } from "../src/color.ts";
import { clearScreen } from "../src/banner.ts";

const ESC = "\u001b";

describe("colorEnabled", () => {
  it("paints an interactive terminal", () => {
    expect(colorEnabled({ isTTY: true, env: {} })).toBe(true);
  });

  it("refuses a pipe, a redirect and anything else that is not a terminal", () => {
    expect(colorEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(colorEnabled({ isTTY: undefined, env: {} })).toBe(false);
  });

  it("honours NO_COLOR on a terminal", () => {
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    // Empty means unset, per the convention.
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("refuses TERM=dumb", () => {
    expect(colorEnabled({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });

  it("lets FORCE_COLOR decide in both directions, ahead of everything else", () => {
    // A CI job that captured a pty and wants colour anyway.
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "3" } })).toBe(true);
    expect(colorEnabled({ isTTY: true, env: { FORCE_COLOR: "1", NO_COLOR: "1" } })).toBe(true);
    // And off, even on a terminal.
    expect(colorEnabled({ isTTY: true, env: { FORCE_COLOR: "0" } })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { FORCE_COLOR: "false" } })).toBe(false);
  });
});

describe("palette", () => {
  it("emits escapes on a terminal", () => {
    const c = palette({ isTTY: true, env: {} });
    expect(c.enabled).toBe(true);
    expect(c.red("no")).toBe(`${ESC}[31mno${ESC}[0m`);
    expect(c.bold("yes")).toBe(`${ESC}[1myes${ESC}[0m`);
  });

  it("emits nothing but the text into a pipe", () => {
    const c = palette({ isTTY: false, env: {} });
    expect(c.enabled).toBe(false);
    for (const paint of [c.cyan, c.green, c.yellow, c.red, c.dim, c.bold]) {
      expect(paint("plain")).toBe("plain");
    }
  });

  it("leaves not one escape byte in a redirected run", () => {
    const c = palette({ isTTY: false, env: {} });
    const transcript = [
      c.bold("Sessions:"),
      c.cyan("abc123") + c.dim("  2026-08-26 10:00  a title"),
      c.yellow("Out of credits") + c.red(" (balance 0)"),
      c.green("✓ +40,000 credits"),
    ].join("\n");
    expect(transcript).not.toContain(ESC);
  });
});

describe("clearScreen", () => {
  const recorder = () => {
    const writes: string[] = [];
    return { writes, stream: (isTTY: boolean | undefined) => ({ isTTY, rows: 24, write: (s: string) => void writes.push(s) }) };
  };

  it("clears a real terminal", () => {
    const { writes, stream } = recorder();
    clearScreen(stream(true) as never);
    expect(writes.join("")).toContain(`${ESC}[2J`);
  });

  it("writes nothing at all into a redirected stdout", () => {
    // It used to pass whenever *either* stream was a terminal, so
    // `clixad > log.txt` from an interactive shell put forty newlines and a
    // clear-screen sequence into the file.
    const { writes, stream } = recorder();
    clearScreen(stream(false) as never);
    expect(writes).toEqual([]);
    clearScreen(stream(undefined) as never);
    expect(writes).toEqual([]);
  });
});
