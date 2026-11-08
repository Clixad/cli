/**
 * A workspace that links out of itself.
 *
 * The attack, as reported: a repository commits a symlink (`notes.txt ->
 * ~/.ssh/id_rsa`, or a linked directory) and asks the agent to read it.
 * `safeResolve` only looked at the path as written, which stays inside the
 * workspace, and `readFileSync` follows links, so the file at the other end
 * went into the conversation. Writes followed links the same way, including a
 * link to a file that does not exist yet.
 *
 * Every test here builds that shape for real, with a "secret" outside the
 * workspace, and checks that no tool and no other reader of workspace files
 * gets at it, while links that stay inside keep working.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, ToolError, safeResolve, type ToolContext } from "../src/tools.ts";
import { expandMentions } from "../src/mentions.ts";
import { collectContext } from "../src/context.ts";

const OUTSIDE = "ONLY-OUTSIDE-THE-WORKSPACE";

// Creating a symlink on Windows needs a privilege CI runners do not have.
const posix = process.platform !== "win32";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "clixad-symlink-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "id_rsa"), `${OUTSIDE}\n`, "utf8");
  writeFileSync(join(root, "real.txt"), "inside the workspace\n", "utf8");
  if (!posix) return;
  symlinkSync(join(outside, "id_rsa"), join(root, "notes.txt")); // a file link out
  symlinkSync(outside, join(root, "vendor")); // a directory link out
  symlinkSync(join(outside, "planted.txt"), join(root, "dangling.txt")); // a link to a file not there yet
  symlinkSync("../outside/id_rsa", join(root, "relative.txt")); // the same, spelled relatively
  symlinkSync(join(root, "real.txt"), join(root, "alias.txt")); // a link that stays inside
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ root });

/** Runs a tool and returns what it said, thrown or returned, so a leak is visible either way. */
async function outcome(run: () => unknown): Promise<{ ok: boolean; text: string }> {
  try {
    return { ok: true, text: String(await run()) };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}

describe.runIf(posix)("a symlink out of the workspace", () => {
  it("is refused by read_file, for a file link, a relative link and a file inside a linked directory", async () => {
    for (const path of ["notes.txt", "relative.txt", "vendor/id_rsa"]) {
      const result = await outcome(() => TOOLS.read_file(ctx(), { path }));
      expect(result.ok, path).toBe(false);
      expect(result.text).toMatch(/escapes workspace/);
      expect(result.text).not.toContain(OUTSIDE);
    }
  });

  it("is refused by safeResolve itself, which every reader goes through", () => {
    expect(() => safeResolve(root, "notes.txt")).toThrow(ToolError);
    expect(() => safeResolve(root, "vendor")).toThrow(/escapes workspace/);
    expect(() => safeResolve(root, join(root, "vendor", "id_rsa"))).toThrow(/escapes workspace/);
  });

  it("cannot be listed through", async () => {
    const result = await outcome(() => TOOLS.list_dir(ctx(), { path: "vendor" }));
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain("id_rsa");
  });

  it("is not read by grep, and not followed by glob, when walking the workspace", async () => {
    const grep = await outcome(() => TOOLS.grep(ctx(), { pattern: "ONLY-OUTSIDE" }));
    expect(grep.text).not.toContain(OUTSIDE);
    expect(grep.text).toMatch(/no matches/);

    const glob = await outcome(() => TOOLS.glob(ctx(), { pattern: "**/*" }));
    expect(glob.text).not.toContain("id_rsa");
    expect(glob.text).not.toMatch(/^notes\.txt$/m);
  });

  it("is refused when grep is pointed straight at it", async () => {
    const result = await outcome(() => TOOLS.grep(ctx(), { pattern: "ONLY-OUTSIDE", path: "notes.txt" }));
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain(OUTSIDE);
  });

  it("cannot be written through: not a file link, not a linked directory, not a link to a file not there yet", async () => {
    for (const path of ["notes.txt", "vendor/new.txt", "dangling.txt"]) {
      const result = await outcome(() => TOOLS.write_file(ctx(), { path, content: "overwritten" }));
      expect(result.ok, path).toBe(false);
      expect(result.text).toMatch(/escapes workspace/);
    }
    expect(readFileSync(join(outside, "id_rsa"), "utf8")).toBe(`${OUTSIDE}\n`);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
  });

  it("cannot be edited through", async () => {
    const result = await outcome(() =>
      TOOLS.edit_file(ctx(), { path: "notes.txt", old_string: OUTSIDE, new_string: "gone" }),
    );
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain(OUTSIDE);
    expect(readFileSync(join(outside, "id_rsa"), "utf8")).toBe(`${OUTSIDE}\n`);
  });

  it("is checked again after the permission dialog, so a file swapped for a link meanwhile is not written", async () => {
    writeFileSync(join(root, "swap.txt"), "before", "utf8");
    const swapping: ToolContext = {
      root,
      // While the user looks at the dialog, the file becomes a link out.
      permit: async () => {
        unlinkSync(join(root, "swap.txt"));
        symlinkSync(join(outside, "id_rsa"), join(root, "swap.txt"));
        return { allowed: true as const };
      },
    };
    const result = await outcome(() => TOOLS.write_file(swapping, { path: "swap.txt", content: "overwritten" }));
    expect(result.ok).toBe(false);
    expect(readFileSync(join(outside, "id_rsa"), "utf8")).toBe(`${OUTSIDE}\n`);
  });

  it("is not attached by an @mention", () => {
    const expanded = expandMentions("look at @notes.txt and @vendor/id_rsa", root);
    expect(expanded.attached).toEqual([]);
    expect(expanded.text).not.toContain(OUTSIDE);
  });

  it("is not loaded as project instructions", () => {
    symlinkSync(join(outside, "id_rsa"), join(root, "CLIXAD.md"));
    symlinkSync(join(outside, "id_rsa"), join(root, "AGENTS.md"));
    const context = collectContext(root, "base prompt");
    expect(context.systemPrompt).not.toContain(OUTSIDE);
    expect(context.files).toEqual([]);
  });
});

describe.runIf(posix)("a symlink that stays inside the workspace", () => {
  it("still reads, lists, greps and writes as before", async () => {
    expect(await TOOLS.read_file(ctx(), { path: "alias.txt" })).toContain("inside the workspace");
    expect(await TOOLS.grep(ctx(), { pattern: "inside the workspace" })).toContain("alias.txt");
    await TOOLS.write_file(ctx(), { path: "alias.txt", content: "changed\n" });
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("changed\n");
  });

  it("works when the workspace itself is reached through a link", async () => {
    // macOS puts temp directories behind `/var -> /private/var`, and people open
    // projects through linked folders; the real path of both sides is compared.
    const linkedRoot = join(base, "linked-workspace");
    symlinkSync(root, linkedRoot);
    expect(await TOOLS.read_file({ root: linkedRoot }, { path: "real.txt" })).toContain("inside the workspace");
    expect(await TOOLS.read_file({ root: linkedRoot }, { path: "alias.txt" })).toContain("inside the workspace");
    expect(() => TOOLS.read_file({ root: linkedRoot }, { path: "notes.txt" })).toThrow(/escapes workspace/);
  });

  it("still lets the agent create files in new directories", async () => {
    await TOOLS.write_file(ctx(), { path: "src/deep/new.ts", content: "export {};\n" });
    expect(readFileSync(join(root, "src", "deep", "new.ts"), "utf8")).toBe("export {};\n");
  });
});
