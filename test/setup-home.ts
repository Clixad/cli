/**
 * Runs once per test file, before any test in it: points the home directory at
 * a temp directory, so no test can touch the real `~/.clixad`.
 *
 * The CLI keeps its account under `~/.clixad`: `config.json` (the bearer token
 * that spends real credits), `history`, and `sessions/`. Every one of those
 * paths is `homedir()` joined at module load, and the TUI tests drive the real
 * code, so a test run was signing the developer out. The model picker test picks
 * a row, which calls `saveConfig`; the `/login` test signs in as a fixture and
 * writes `token: "adg_real"` over the real one; every scripted turn appended its
 * prompt to the shell history and left a session file behind. It was found by
 * reading the file: the history had `write nope.txt` in it, next to things a
 * person had actually typed.
 *
 * `homedir()` reads `HOME` (`USERPROFILE` on Windows), and a setup file runs
 * before the test module, and therefore before `config.ts` computes its path,
 * so pointing both at a temp directory redirects all of it at once. The path is
 * fixed rather than random: vitest reuses a worker for several files, the
 * modules that captured it stay captured, and two different directories inside
 * one process would be worse than one wrong one.
 *
 * It is one directory **per worker** (`VITEST_POOL_ID`), not one for the whole
 * run. With one, files running in parallel shared a `config.json`: a TUI test
 * that finishes a turn saves the turn count, and a config no `loadConfig` handed
 * out is saved whole, so its `model` landed between the paywall test saving the
 * model it had switched to and reading it back. Fixed within a process, which
 * is the property the paragraph above needs, and private to it.
 *
 * The rule is on the *path*, never on a caller's stated intention, and there is
 * no opt-out. `vitest.config.ts` beside this file runs it for this package on
 * its own, and the monorepo's root setup imports it for the whole suite.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = join(tmpdir(), `clixad-test-home-${process.env.VITEST_POOL_ID ?? "0"}`);
mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
