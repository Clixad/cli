/** The input box's text model — every rule the REPL's keyboard depends on. */
import { describe, expect, it } from "vitest";
import * as ed from "../src/tui/editor.ts";

const at = (text: string, cursor: number) => ed.fromTextAt(text, cursor);
const type = (state: ed.EditorState, ...keys: ed.EditorKey[]) => keys.reduce(ed.apply, state);

describe("editor", () => {
  it("inserts text at the cursor", () => {
    let s = ed.EMPTY;
    s = type(s, { input: "hello" }, { input: " world" });
    expect(ed.toText(s)).toBe("hello world");
    expect(ed.offset(s)).toBe(11);
  });

  it("moves left and right, including across line ends", () => {
    let s = at("ab\ncd", 5);
    s = type(s, { name: "left" }, { name: "left" }, { name: "left" }); // onto the newline
    expect([s.row, s.col]).toEqual([0, 2]);
    s = type(s, { name: "right" });
    expect([s.row, s.col]).toEqual([1, 0]);
  });

  it("keeps the column when moving between lines of different length", () => {
    const s = type(at("longer line\nab", 6), { name: "down" });
    expect([s.row, s.col]).toEqual([1, 2]); // clamped to the shorter line
  });

  it("splits and joins lines with newline and backspace", () => {
    let s = ed.newline(at("abcd", 2));
    expect(ed.toText(s)).toBe("ab\ncd");
    s = type(s, { name: "backspace" });
    expect(ed.toText(s)).toBe("abcd");
    expect(ed.offset(s)).toBe(2);
  });

  it("pastes multi-line text as multiple lines", () => {
    const s = ed.insert(ed.EMPTY, "first\r\nsecond\rthird");
    expect(s.lines).toEqual(["first", "second", "third"]);
    expect(s.row).toBe(2);
  });

  it("drops control characters from a paste but keeps newlines", () => {
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    const s = ed.insert(ed.EMPTY, `a${NUL}b${ESC}[31mc
d`);
    expect(ed.toText(s)).toBe("ab[31mc\nd");
  });

  it("supports the usual shell bindings", () => {
    expect(ed.toText(type(at("hello world", 11), { ctrl: true, input: "w" }))).toBe("hello ");
    expect(ed.toText(type(at("hello world", 6), { ctrl: true, input: "k" }))).toBe("hello ");
    expect(ed.toText(type(at("hello world", 6), { ctrl: true, input: "u" }))).toBe("world");
    expect(type(at("hello", 3), { ctrl: true, input: "a" }).col).toBe(0);
    expect(type(at("hello", 1), { ctrl: true, input: "e" }).col).toBe(5);
  });

  it("jumps by word with alt+arrows", () => {
    const s = at("src/tui/app.tsx here", 20);
    expect(type(s, { meta: true, name: "left" }).col).toBe(16);
    expect(type(at("one two", 0), { meta: true, name: "right" }).col).toBe(3);
  });

  it("detects a trailing backslash as a line continuation", () => {
    expect(ed.endsWithContinuation(at("keep going \\", 12))).toBe(true);
    expect(ed.endsWithContinuation(at("escaped \\\\", 10))).toBe(false);
    expect(ed.endsWithContinuation(at("plain", 5))).toBe(false);

    const s = ed.continueLine(at("keep going \\", 12));
    expect(s.lines).toEqual(["keep going ", ""]);
    expect(s.row).toBe(1);
  });

  it("round-trips text and cursor offsets", () => {
    const s = at("one\ntwo\nthree", 9);
    expect([s.row, s.col]).toEqual([2, 1]);
    expect(ed.offset(s)).toBe(9);
    expect(ed.toText(s)).toBe("one\ntwo\nthree");
  });
});
