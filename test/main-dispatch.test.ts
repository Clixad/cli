/**
 * `clixad <argv>` routing, driven as a real process.
 *
 * `main()` runs at module scope and is not exported, so the only honest way to
 * check what an argv does is to run it. Both cases below stop before any
 * network call: `HOME` points at an empty directory, so `loadConfig` finds no
 * token, and stdin is not a terminal, so `repl()` says so and returns.
 *
 * The case that matters is the third one: `clixad fix the failing test` used to
 * answer `unknown command: fix` and exit 1, which is one of the first things
 * anybody types.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_DIR, TSX as tsx } from "./helpers/paths.ts";

const entry = join(CLI_DIR, "src/main.ts");

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clixad-home-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * Run the CLI with an empty HOME and no terminal. Never touches the network.
 *
 * `logout` needs a HOME that already holds an account, so the last argument may
 * be one — `runIn` below is the readable spelling of that.
 */
function run(...args: string[]): { out: string; code: number } {
  return runIn(home, ...args);
}

function runIn(hd: string, ...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(tsx, [entry, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: hd, USERPROFILE: hd, NO_COLOR: "1" },
      timeout: 30_000,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("clixad argv routing", () => {
  it("prints the bare version for --version", () => {
    const { out, code } = run("--version");
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("treats a first argument that is not a command as a task", () => {
    const { out, code } = run("fix", "the", "failing", "test");
    // It got as far as opening the REPL — which then declines for want of a
    // terminal — rather than rejecting the words as a command.
    expect(out).toContain("interactive mode needs a terminal");
    expect(out).not.toContain("unknown command");
    expect(code).toBe(0);
  });

  /**
   * `clixad buy` moved into the REPL as `/buy`, and this is the one removed
   * subcommand that may not fall through to the model.
   *
   * It is not a typo — it is what `clixad help`, the terms and every published
   * CLI before this one told people to run — so the ordinary "anything that is
   * not a command is a task" fallback would send "buy starter" to a model,
   * charge for the turn, and answer with something that is not a purchase.
   */
  it("sends `buy` to the REPL rather than to the model", () => {
    const { out, code } = run("buy", "starter");
    expect(code).toBe(0);
    expect(out).toContain("/buy");
    // Neither the task fallback nor an error: it is a signpost.
    expect(out).not.toContain("interactive mode needs a terminal");
    expect(out).not.toContain("unknown command");
  });

  it("still refuses an unknown option", () => {
    // A stray flag is a mistake in a script, never a prompt.
    const { out, code } = run("--nope");
    expect(out).toContain("unknown option: --nope");
    expect(code).toBe(1);
  });
});

describe("clixad logout", () => {
  /**
   * Every identity field, and `login` was the one being left behind — the same
   * field `performLogin` deletes on purpose, because the welcome banner greets
   * by it. A logout that leaves it there leaves somebody's GitHub handle in
   * config.json and their name on the next session's banner.
   */
  it("forgets every identity field, not only the token", () => {
    const signedIn = mkdtempSync(join(tmpdir(), "clixad-logout-"));
    try {
      const path = join(signedIn, ".clixad", "config.json");
      mkdirSync(join(signedIn, ".clixad"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          gatewayUrl: "https://clixad.example",
          dashboardUrl: "https://clixad.example",
          model: "gpt-5-nano",
          token: "adg_secret",
          userId: "u-1",
          email: "someone@example.com",
          login: "SomeGitHubUser",
        }),
      );
      const { out, code } = runIn(signedIn, "logout");
      expect(code).toBe(0);
      expect(out).toContain("logged out");
      const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(after.token).toBeUndefined();
      expect(after.userId).toBeUndefined();
      expect(after.email).toBeUndefined();
      expect(after.login).toBeUndefined();
      // What is not identity survives.
      expect(after.model).toBe("gpt-5-nano");
    } finally {
      rmSync(signedIn, { recursive: true, force: true });
    }
  });
});
