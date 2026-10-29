import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, ToolError, globToRegExp, listWorkspaceFiles, type ToolContext } from "../src/tools.ts";
import type { PermissionRequest } from "../src/permissions.ts";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adg-tools-"));
  ctx = { root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Records what the tool asked permission for, and answers with `allowed`. */
function recordingPermit(allowed: boolean) {
  const seen: PermissionRequest[] = [];
  const permit = async (req: PermissionRequest) => {
    seen.push(req);
    return allowed
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "the user denied it", notice: "denied by you" } as const);
  };
  return { seen, permit };
}

describe("agent tools", () => {
  it("writes then reads a file", async () => {
    await TOOLS.write_file(ctx, { path: "src/hello.txt", content: "hi" });
    // Numbered: the numbers are what let the model cite a place in a file, and
    // they are display only — `edit_file` never sees them.
    expect(TOOLS.read_file(ctx, { path: "src/hello.txt" })).toBe("    1\thi");
    expect(readFileSync(join(root, "src/hello.txt"), "utf8")).toBe("hi");
  });

  it("lists directory contents with trailing slash for dirs", async () => {
    await TOOLS.write_file(ctx, { path: "a.txt", content: "x" });
    await TOOLS.write_file(ctx, { path: "sub/b.txt", content: "y" });
    const listing = TOOLS.list_dir(ctx, { path: "." }).split("\n").sort();
    expect(listing).toEqual(["a.txt", "sub/"]);
  });

  it("refuses to escape the workspace root", () => {
    expect(() => TOOLS.read_file(ctx, { path: "../../etc/passwd" })).toThrow(ToolError);
  });

  it("asks permission before writing, with a diff, and honours a denial", async () => {
    const { seen, permit } = recordingPermit(false);
    await expect(TOOLS.write_file({ root, permit }, { path: "x.txt", content: "no" })).rejects.toThrow(ToolError);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.signature).toBe("write:x.txt");
    expect(seen[0]!.preview).toContain("no"); // the diff shows the added line
  });

  // The sandbox check rejected only on a leading `..` *segment* after this fix; it
  // used to reject any relative path merely starting with two dots, so real files
  // like `..gitignore` were unreachable and reported as escape attempts.
  describe("workspace confinement", () => {
    it("still refuses paths that climb out of the workspace", async () => {
      for (const path of ["../outside.txt", "../../etc/passwd", "a/../../outside.txt"]) {
        expect(() => TOOLS.read_file(ctx, { path }), path).toThrow(/escapes workspace/);
      }
    });

    it("allows in-workspace names that merely begin with dots", async () => {
      for (const name of ["..gitignore", "..foo.txt", "...weird"]) {
        await TOOLS.write_file(ctx, { path: name, content: `contents of ${name}` });
        expect(TOOLS.read_file(ctx, { path: name }), name).toBe(`    1\tcontents of ${name}`);
      }
    });

    it("allows a directory whose name begins with dots", async () => {
      await TOOLS.write_file(ctx, { path: "..build/out.txt", content: "nested" });
      expect(TOOLS.read_file(ctx, { path: "..build/out.txt" })).toBe("    1\tnested");
    });
  });

  describe("edit_file", () => {
    beforeEach(async () => {
      await TOOLS.write_file(ctx, { path: "app.ts", content: "const a = 1;\nconst b = 2;\nconst a2 = 1;\n" });
    });

    it("replaces a unique snippet and shows a diff in the permission request", async () => {
      const { seen, permit } = recordingPermit(true);
      await TOOLS.edit_file({ root, permit }, { path: "app.ts", old_string: "const b = 2;", new_string: "const b = 3;" });

      expect(readFileSync(join(root, "app.ts"), "utf8")).toContain("const b = 3;");
      expect(seen[0]!.summary).toBe("edit app.ts");
      expect(seen[0]!.preview).toContain("const b = 3;");
    });

    it("refuses when the snippet is missing", async () => {
      await expect(
        TOOLS.edit_file(ctx, { path: "app.ts", old_string: "nope", new_string: "x" }),
      ).rejects.toThrow(/not found/);
    });

    it("refuses an ambiguous match unless replace_all is set", async () => {
      await expect(
        TOOLS.edit_file(ctx, { path: "app.ts", old_string: "= 1;", new_string: "= 9;" }),
      ).rejects.toThrow(/appears 2 times/);

      await TOOLS.edit_file(ctx, { path: "app.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true });
      expect(readFileSync(join(root, "app.ts"), "utf8")).not.toContain("= 1;");
    });

    /**
     * `String.prototype.replace` expands `$&`, `` $` ``, `$'` and `$$` inside the
     * replacement, so new_string used to be silently corrupted: `$&foo` was written
     * as `<the matched text>foo`. It only affected the single-occurrence branch, so
     * the very same edit produced different bytes depending on `replace_all` — and
     * because the diff preview is derived from the result, the dialog displayed the
     * corruption as though it were intended. Shell scripts, sed and regex-heavy JS
     * hit this constantly.
     */
    describe("$ sigils in new_string are literal", () => {
      const sigils = ["$&", "$`", "$'", "$$", "$1", "$&foo", "a$$b", "s.replace(/x/, '$1-$&')"];

      it("writes them verbatim on a single replacement", async () => {
        for (const sigil of sigils) {
          await TOOLS.write_file(ctx, { path: "t.txt", content: "PLACEHOLDER" });
          await TOOLS.edit_file(ctx, { path: "t.txt", old_string: "PLACEHOLDER", new_string: sigil });
          expect(readFileSync(join(root, "t.txt"), "utf8"), `single: ${sigil}`).toBe(sigil);
        }
      });

      it("writes them verbatim with replace_all", async () => {
        for (const sigil of sigils) {
          await TOOLS.write_file(ctx, { path: "t.txt", content: "P P" });
          await TOOLS.edit_file(ctx, { path: "t.txt", old_string: "P", new_string: sigil, replace_all: true });
          expect(readFileSync(join(root, "t.txt"), "utf8"), `all: ${sigil}`).toBe(`${sigil} ${sigil}`);
        }
      });

      it("agrees between the two paths, and the preview matches what is written", async () => {
        for (const sigil of sigils) {
          await TOOLS.write_file(ctx, { path: "one.txt", content: "X" });
          await TOOLS.write_file(ctx, { path: "all.txt", content: "X" });
          const { seen, permit } = recordingPermit(true);
          await TOOLS.edit_file({ root, permit }, { path: "one.txt", old_string: "X", new_string: sigil });
          await TOOLS.edit_file(ctx, { path: "all.txt", old_string: "X", new_string: sigil, replace_all: true });

          const written = readFileSync(join(root, "one.txt"), "utf8");
          expect(written, `paths disagree for ${sigil}`).toBe(readFileSync(join(root, "all.txt"), "utf8"));
          expect(seen[0]!.preview, `preview lied for ${sigil}`).toContain(written);
        }
      });
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await TOOLS.write_file(ctx, { path: "src/a.ts", content: "export const answer = 42;\n" });
      await TOOLS.write_file(ctx, { path: "src/deep/b.ts", content: "// answer here\n" });
      await TOOLS.write_file(ctx, { path: "notes.md", content: "answer\n" });
      await TOOLS.write_file(ctx, { path: "node_modules/pkg/c.ts", content: "answer\n" });
    });

    it("globs by pattern and skips node_modules", () => {
      const hits = TOOLS.glob(ctx, { pattern: "**/*.ts" }).split("\n");
      expect(hits).toContain("src/a.ts");
      expect(hits).toContain("src/deep/b.ts");
      expect(hits.some((h) => h.includes("node_modules"))).toBe(false);
    });

    it("greps contents and can be narrowed by glob", () => {
      const all = TOOLS.grep(ctx, { pattern: "answer" }).split("\n");
      expect(all.length).toBeGreaterThanOrEqual(3);

      const onlyTs = TOOLS.grep(ctx, { pattern: "answer", glob: "**/*.ts" }).split("\n");
      expect(onlyTs.every((l) => l.endsWith("") && !l.startsWith("notes.md"))).toBe(true);
      expect(onlyTs.some((l) => l.startsWith("src/a.ts:1:"))).toBe(true);
    });

    it("lists workspace files for @-completion", () => {
      const files = listWorkspaceFiles(root);
      expect(files).toContain("notes.md");
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });
  });

  describe("run_command", () => {
    it("runs a shell command and reports the exit code", async () => {
      const out = await TOOLS.run_command(ctx, { command: "echo ok" });
      expect(out).toContain("exit 0");
      expect(out).toContain("ok");
    });

    it("streams output while it runs", async () => {
      const chunks: string[] = [];
      await TOOLS.run_command({ root, onOutput: (c) => chunks.push(c) }, { command: "echo streamed" });
      expect(chunks.join("")).toContain("streamed");
    });

    // Truncation has to be announced, or the model treats a shortened output as the
    // whole story. The old flag was only set by a chunk arriving *after* the cap was
    // passed, so a single oversized write was cut silently.
    it("says so when it truncates, even from one oversized chunk", async () => {
      // 40k in a single write: under the 64KB pipe buffer, so it arrives as one chunk.
      const out = await TOOLS.run_command(ctx, {
        command: `node -e "process.stdout.write('y'.repeat(40000))"`,
      });
      expect(out).toContain("output capped");
      expect(out).toContain("40000"); // and how much was withheld
      expect(out.length).toBeLessThan(40000);
    });

    it("stays quiet about truncation when nothing was truncated", async () => {
      const out = await TOOLS.run_command(ctx, { command: "echo small" });
      expect(out).not.toContain("output capped");
    });

    // "Always allow" must remember what the user actually read in the dialog. The
    // signature was once just the program name, so approving `git status` also
    // approved `git push --force`, and one `rm` approved every later `rm`.
    it("asks permission keyed by the whole command, not the program name", async () => {
      const { seen, permit } = recordingPermit(false);
      await expect(TOOLS.run_command({ root, permit }, { command: "rm -rf /" })).rejects.toThrow(ToolError);
      expect(seen[0]!.signature).toBe("run:rm -rf /");
    });

    it("gives different commands for the same program different signatures", async () => {
      const sig = async (command: string) => {
        const { seen, permit } = recordingPermit(false);
        await expect(TOOLS.run_command({ root, permit }, { command })).rejects.toThrow(ToolError);
        return seen[0]!.signature;
      };
      expect(await sig("git status")).not.toBe(await sig("git push --force"));
      expect(await sig("rm build/tmp.txt")).not.toBe(await sig("rm -rf /"));
      // Reformatting the same command still matches, so "always" stays useful.
      expect(await sig("npm  test")).toBe(await sig("npm test"));
    });

    it("stops when the run is aborted", async () => {
      const ac = new AbortController();
      // node is the one long-running command guaranteed to exist on every platform.
      const sleep = `node -e "setTimeout(() => {}, 5000)"`;
      const running = TOOLS.run_command({ root, signal: ac.signal }, { command: sleep });
      setTimeout(() => ac.abort(), 150);
      expect(await running).toContain("cancelled");
    });
  });
});

describe("globToRegExp", () => {
  it("matches the patterns agents actually emit", () => {
    expect(globToRegExp("**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(true); // bare patterns match at any depth
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("**/*.{ts,tsx}").test("src/app.tsx")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/a.js")).toBe(false);
  });
});

/**
 * `read_file`'s numbering and window.
 *
 * The numbers are what let a model say `app.tsx:412` rather than "near the
 * top", and the window is what stops a 400 kB file being poured into a metered
 * context to look at forty lines of it. The hazard is that `edit_file` matches
 * exactly, so a model copying the numbers into `old_string` finds nothing —
 * which is why the not-found error names them.
 */
describe("read_file numbering and windows", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adg-read-"));
    writeFileSync(join(root, "many.txt"), Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const ctx = () => ({ root });

  it("numbers every line, right-aligned, tab-separated", () => {
    const out = TOOLS.read_file(ctx(), { path: "many.txt", limit: 3 });
    expect(out.split("\n").slice(0, 3)).toEqual(["    1\tline 1", "    2\tline 2", "    3\tline 3"]);
  });

  it("reads a window and says where to carry on", () => {
    const out = TOOLS.read_file(ctx(), { path: "many.txt", offset: 100, limit: 2 });
    expect(out).toContain("  100\tline 100");
    expect(out).toContain("  101\tline 101");
    expect(out).not.toContain("line 102");
    expect(out).toContain("showing lines 100-101 of 250");
    expect(out).toContain("offset: 102");
  });

  it("says nothing about a window when the whole file fits", () => {
    writeFileSync(join(root, "small.txt"), "a\nb\n");
    const out = TOOLS.read_file(ctx(), { path: "small.txt" });
    expect(out).toBe("    1\ta\n    2\tb");
    expect(out).not.toContain("showing lines"); // a complete read makes no claim
  });

  it("does not count a trailing newline as one more line", () => {
    writeFileSync(join(root, "trailing.txt"), "only\n");
    expect(TOOLS.read_file(ctx(), { path: "trailing.txt" })).toBe("    1\tonly");
  });

  it("answers an offset past the end instead of returning nothing", () => {
    const out = TOOLS.read_file(ctx(), { path: "many.txt", offset: 900 });
    expect(out).toContain("250 lines");
    expect(out).toContain("past the end");
  });

  it("tells a model that copied the line numbers exactly what went wrong", async () => {
    writeFileSync(join(root, "edit.txt"), "hello\n");
    await expect(
      TOOLS.edit_file({ root }, { path: "edit.txt", old_string: "    1\thello", new_string: "bye" }),
    ).rejects.toThrow(/without the line numbers/);
  });
});
