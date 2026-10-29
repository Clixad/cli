/**
 * Whether a published CLI is newer than the one running.
 *
 * `npm install -g clixad` pins the version of that day, so without a notice an
 * installed CLI never hears about a release. The comparison decides whether
 * that notice appears, and a wrong answer in either direction is visible: a
 * nag to "update" to an older version, or silence about a real one.
 */
import { describe, expect, it } from "vitest";
import { isNewerVersion } from "../src/version.ts";

describe("isNewerVersion", () => {
  it("orders beta releases numerically, not as text", () => {
    expect(isNewerVersion("0.0.1-beta.23", "0.0.1-beta.22")).toBe(true);
    expect(isNewerVersion("0.0.1-beta.10", "0.0.1-beta.9")).toBe(true);
    expect(isNewerVersion("0.0.1-beta.9", "0.0.1-beta.10")).toBe(false);
  });

  it("puts a release after every pre-release of the same version", () => {
    expect(isNewerVersion("0.0.1", "0.0.1-beta.22")).toBe(true);
    expect(isNewerVersion("0.0.1-beta.22", "0.0.1")).toBe(false);
  });

  it("compares the numeric core first", () => {
    expect(isNewerVersion("0.1.0-beta.1", "0.0.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.0.9", "0.1.0-beta.1")).toBe(false);
  });

  it("never calls the same version, or one it cannot read, newer", () => {
    expect(isNewerVersion("0.0.1-beta.22", "0.0.1-beta.22")).toBe(false);
    expect(isNewerVersion("latest", "0.0.1-beta.22")).toBe(false);
    expect(isNewerVersion("0.0.1-beta.23", "unknown")).toBe(false);
  });
});
