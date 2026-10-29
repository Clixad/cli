/**
 * `@path` expansion.
 *
 * The completion menu always offered files for `@`, but picking one inserted
 * only the path — so the model read a filename, called `read_file`, and the
 * user paid a round-trip for something they had already pointed at.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandMentions, findMentions } from "../src/mentions.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adg-mentions-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("findMentions", () => {
  it("takes @ only at the start of a word", () => {
    expect(findMentions("look at @src/a.ts please")).toEqual(["src/a.ts"]);
    // An email address mid-sentence is not a file — the same rule the
    // completion menu applies when it decides whether to open.
    expect(findMentions("mail me@example.com")).toEqual([]);
  });

  it("drops punctuation that ends the sentence, not the path", () => {
    expect(findMentions("check @src/a.ts, then @src/b.ts;")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("mentions the same file once", () => {
    expect(findMentions("@src/a.ts and @src/a.ts")).toEqual(["src/a.ts"]);
  });
});

describe("expandMentions", () => {
  it("attaches the contents, numbered exactly as read_file would return them", () => {
    const { text, attached } = expandMentions("explain @src/a.ts", root);
    expect(attached).toEqual(["src/a.ts"]);
    expect(text).toContain("explain @src/a.ts"); // the typed line survives intact
    expect(text).toContain("--- src/a.ts ---");
    expect(text).toContain("    1\texport const a = 1;");
    expect(text).toContain("do not call read_file on them again");
  });

  it("leaves a message with no mentions completely alone", () => {
    const { text, attached } = expandMentions("just a question", root);
    expect(text).toBe("just a question");
    expect(attached).toEqual([]);
  });

  it("ignores a mention it cannot read rather than failing the message", () => {
    // A typo, a directory and a path outside the workspace: the model can still
    // act on the name, and refusing the whole message would be worse.
    const { text, attached } = expandMentions("see @nope.ts @src @../../etc/passwd", root);
    expect(attached).toEqual([]);
    expect(text).toBe("see @nope.ts @src @../../etc/passwd");
  });

  it("never leaves the workspace, even for a file that exists", () => {
    const outside = mkdtempSync(join(tmpdir(), "adg-outside-"));
    writeFileSync(join(outside, "secret.txt"), "sensitive");
    try {
      const { text, attached } = expandMentions(`read @${join(outside, "secret.txt")}`, root);
      expect(attached).toEqual([]);
      expect(text).not.toContain("sensitive");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops at the character budget instead of pouring a repo into one message", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(5000));
    const { text, attached } = expandMentions("@big.txt", root, 500);
    expect(attached).toEqual(["big.txt"]);
    expect(text).toContain("attachment truncated");
    expect(text.length).toBeLessThan(2000);
  });

  it("attaches several files in the order they were mentioned", () => {
    const { text, attached } = expandMentions("diff @src/b.ts against @src/a.ts", root);
    expect(attached).toEqual(["src/b.ts", "src/a.ts"]);
    expect(text.indexOf("--- src/b.ts ---")).toBeLessThan(text.indexOf("--- src/a.ts ---"));
  });
});
