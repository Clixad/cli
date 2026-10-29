/**
 * The suite runs in a known environment, whatever the machine running it set.
 *
 * `setup-env.ts` clears every variable the CLI reads to decide how it behaves.
 * This pins both halves of that: nothing on the list is set when a test runs,
 * and nothing the CLI reads is missing from the list. The second half is the
 * one that matters, because the failure is invisible where the code is
 * written: a test that depends on `CI` being unset passes on every laptop and
 * fails only on a runner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_DIR } from "./helpers/paths.ts";
import { CLI_ENV } from "./setup-env.ts";

const listFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));

/** Read by the CLI and deliberately left alone; see `setup-env.ts`. */
const MANAGED_ELSEWHERE = new Set(["NODE_ENV", "HOME", "USERPROFILE"]);

/** Every environment variable name the CLI's source reads. */
function variablesRead(): Set<string> {
  const names = new Set<string>();
  for (const file of listFiles(join(CLI_DIR, "src"))) {
    const source = readFileSync(join(CLI_DIR, "src", file), "utf8");
    // `process.env.X`, `env.X` and `env?.X`: every gate takes its environment
    // as an object and reads it by name.
    for (const m of source.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]!);
    // `process.env["X"]`, and a variable named in a table (config.ts's overrides).
    for (const m of source.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) names.add(m[1]!);
    for (const m of source.matchAll(/"(CLIXAD_[A-Z0-9_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

describe("the test environment", () => {
  it("has none of the variables that change how the CLI behaves", () => {
    for (const name of CLI_ENV) expect(process.env[name], name).toBeUndefined();
  });

  it("clears every variable the CLI reads, so none can leak in from the machine", () => {
    const read = variablesRead();
    // The scan has to find the ones that caused this file to exist.
    for (const name of ["CI", "NO_COLOR", "TERM_PROGRAM", "CLIXAD_SPONSOR", "CLIXAD_GATEWAY_URL"]) {
      expect(read, name).toContain(name);
    }
    const listed = new Set<string>(CLI_ENV);
    const missing = [...read].filter((name) => !listed.has(name) && !MANAGED_ELSEWHERE.has(name));
    expect(missing, "add these to CLI_ENV in test/setup-env.ts").toEqual([]);
  });
});
