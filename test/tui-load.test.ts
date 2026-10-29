/**
 * How the TUI is loaded, which decides whether a long session runs out of heap.
 *
 * One crashed at about 4 GB after 13.7 hours. React's development build kept a
 * `performance.measure()` for every render whose props changed, and ink 7's two
 * text caches kept every frame of every streamed answer. Both are settled when
 * React and ink are first evaluated, so the end-to-end cases run a fresh child
 * process (`helpers/load-probe.ts`): this worker has loaded both long ago.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedCache, INK_TEXT_CACHE_LIMIT, boundInkSource, withProductionReact } from "../src/tui/load.ts";
import { CLI_DIR, nodeModulesWith, TSX as tsx } from "./helpers/paths.ts";

const probe = join(CLI_DIR, "test/helpers/load-probe.ts");

interface ProbeResult {
  measures: number;
  caches: number[];
  builds: string[];
  nodeEnvBefore: string | null;
  nodeEnvAfter: string | null;
}

function runProbe(mode: "fixed" | "before", nodeEnv?: string): ProbeResult {
  const env = { ...process.env };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  // stderr piped: ink restores the cursor there on exit, which is noise here.
  const out = execFileSync(tsx, [probe, mode], { encoding: "utf8", env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`probe printed no result:\n${out}`);
  return JSON.parse(line) as ProbeResult;
}

describe("loading the TUI for a session of any length", () => {
  it("runs React's production build, keeps no measures and bounds ink's caches", () => {
    const r = runProbe("fixed");
    expect(r.builds).toEqual(["react-reconciler.production.js", "react.production.js"]);
    expect(r.measures).toBe(0);
    // Both caches were made through the bound, and 1,500 repaints filled them to it.
    expect(r.caches).toEqual([INK_TEXT_CACHE_LIMIT, INK_TEXT_CACHE_LIMIT]);
  }, 60_000);

  it("leaves NODE_ENV as the user had it, set or not", () => {
    expect(runProbe("fixed").nodeEnvAfter).toBeNull();
    const dev = runProbe("fixed", "development");
    expect(dev.nodeEnvBefore).toBe("development");
    expect(dev.nodeEnvAfter).toBe("development");
    // And the builds are production whatever the shell said.
    expect(dev.builds).toEqual(["react-reconciler.production.js", "react.production.js"]);
  }, 60_000);

  it("is what the old way did not do (the failure, measured)", () => {
    const r = runProbe("before");
    expect(r.builds).toEqual(["react-reconciler.development.js", "react.development.js"]);
    expect(r.measures).toBeGreaterThan(1000); // one per changed render, kept forever
    expect(r.caches).toEqual([]); // ink's own unbounded maps
  }, 60_000);
});

describe("boundInkSource", () => {
  const inkBuild = join(nodeModulesWith("ink"), "ink", "build");
  const url = (file: string) => `file://${join(inkBuild, file)}`;

  /**
   * The patch is text replacement on ink's published build, so it is held to
   * the ink that is installed. An upgrade that moves these lines fails here,
   * rather than quietly leaving the caches unbounded again.
   */
  it("patches the installed ink's two caches", () => {
    for (const file of ["measure-text.js", "wrap-text.js"]) {
      const patched = boundInkSource(url(file), readFileSync(join(inkBuild, file), "utf8"));
      expect(patched, file).toBeDefined();
      expect(patched).toContain('Symbol.for("clixad.inkTextCache")');
    }
    const wrap = boundInkSource(url("wrap-text.js"), readFileSync(join(inkBuild, "wrap-text.js"), "utf8"))!;
    expect(wrap).toContain("cache.get(cacheKey)");
    expect(wrap).toContain("cache.set(cacheKey, wrappedText)");
    expect(wrap).not.toContain("cache[cacheKey]");
  });

  it("leaves every other module, and a source it does not recognise, alone", () => {
    const source = readFileSync(join(inkBuild, "wrap-text.js"), "utf8");
    expect(boundInkSource(url("output.js"), "const cache = {};")).toBeUndefined();
    expect(boundInkSource("file:///elsewhere/wrap-text.js", source)).toBeUndefined();
    // One of three lines moved: no half patch.
    expect(boundInkSource(url("wrap-text.js"), source.replace("cache[cacheKey] = wrappedText;", "cache[k] = w;"))).toBeUndefined();
  });
});

describe("BoundedCache", () => {
  it("forgets the least recently used entry past its limit", () => {
    const cache = new BoundedCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1); // a is now the most recent
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("b")).toBe(false);
    expect([...cache.keys()]).toEqual(["c", "a", "d"]);
    cache.set("c", 30); // an update is not an addition
    expect(cache.size).toBe(3);
    expect(cache.get("c")).toBe(30);
    expect(cache.get("missing")).toBeUndefined();
  });
});

describe("withProductionReact", () => {
  it("restores the variable after the load, and after a load that throws", async () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "test";
      let seen: string | undefined;
      await withProductionReact(async () => {
        seen = process.env.NODE_ENV;
      });
      expect(seen).toBe("production");
      expect(process.env.NODE_ENV).toBe("test");

      delete process.env.NODE_ENV;
      await expect(
        withProductionReact(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect("NODE_ENV" in process.env).toBe(false);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});
