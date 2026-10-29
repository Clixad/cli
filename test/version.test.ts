/**
 * The version is read, never typed.
 *
 * `app.tsx` used to greet every user with the literal `"v0.0.1"`, which was two
 * publishes stale by the time anyone noticed — on a `0.0.1-beta.2` install the
 * welcome box still said v0.0.1. This test is the thing that makes the next bump
 * impossible to get wrong: it compares what the CLI reports against
 * `apps/cli/package.json`, the file `npm version` actually edits.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION, VERSION_LABEL } from "../src/version.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("VERSION", () => {
  it("is the version in package.json, not a copy of it", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("unknown"); // the read failed if this trips
  });

  it("is bare, and the banner label wears the v", () => {
    // `--version` is piped into scripts and pasted into issue reports, so it
    // prints the bare string; only the banner's label adds the prefix.
    expect(VERSION).not.toMatch(/^v/);
    expect(VERSION_LABEL).toBe(`v${pkg.version}`);
  });

  it("is a beta prerelease while the product is behind a waitlist", () => {
    // A stray publish that dropped the prerelease suffix would put the CLI on
    // `latest` as a 1.0-shaped number for a product that cannot yet create
    // accounts. Cheap to assert, and it names the assumption.
    expect(VERSION).toMatch(/^0\.0\.\d+-beta\.\d+$/);
  });
});
