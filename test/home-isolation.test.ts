/**
 * The suite may not write into the real home directory.
 *
 * The CLI keeps its account under `~/.clixad` — `config.json` holds the bearer
 * token that spends real credits, next to `history` and `sessions/` — and every
 * one of those paths is `homedir()` joined at module load. The TUI tests drive
 * the real code, so `npm test` was signing the developer out: the model picker
 * test calls `saveConfig`, the `/login` test writes a fixture token over the
 * real one, and every scripted turn appended its prompt to the shell history.
 * It was found by reading the file and seeing `write nope.txt` sitting next to
 * things a person had actually typed.
 *
 * `test/setup-home.ts` redirects `HOME`/`USERPROFILE` at a temp directory before any
 * module can capture it. This pins that, because the failure is silent: nothing
 * errors, the suite stays green, and the damage is in a file nobody looks at.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath } from "../src/config.ts";
import { sessionDir } from "../src/session.ts";

describe("test home isolation", () => {
  // One per worker, so files running in parallel never share a config.json.
  const testHome = join(tmpdir(), `clixad-test-home-${process.env.VITEST_POOL_ID ?? "0"}`);

  it("resolves homedir() to the temp home, not the developer's", () => {
    expect(homedir()).toBe(testHome);
  });

  it("keeps every path the CLI persists to inside it", () => {
    // Not a substring check on the name: only a real prefix proves containment.
    for (const path of [configPath(), sessionDir()]) {
      expect(path.startsWith(testHome + "/") || path.startsWith(testHome + "\\")).toBe(true);
    }
  });
});
