/**
 * The published bundle, built for real.
 *
 * `loadTui` can only choose React's build and bound ink's caches if it runs
 * before either is evaluated, and in one bundled file it could not: an import
 * of a package is hoisted to the top of the file it is in. `build.mjs` splits
 * the bundle so they live in the TUI's chunk. Nothing else checks that, since
 * every other test runs the source.
 *
 * Built into the `dist` of a copy of the package (its package.json, NOTICE and
 * README beside it), so the same directory can be run the way a shell runs
 * `clixad` and packed the way `npm publish` packs it. The bundle resolves its
 * packages the way an install does, from a node_modules above it: the one this
 * checkout installed, linked in. The copy lives in the OS temp directory and not in
 * the checkout, because a checkout under a synced folder (iCloud Drive's
 * Desktop & Documents) brought back a directory deleted a second after it was
 * made, and left an empty `.build-test-*` behind on every other run.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";
import { CLI_DIR as cliDir, nodeModulesWith } from "./helpers/paths.ts";

const manifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { bin: { clixad: string } };
let pkg: string;
let out: string;

beforeAll(() => {
  pkg = mkdtempSync(join(tmpdir(), "clixad-build-test-"));
  out = join(pkg, "dist");
  for (const file of ["package.json", "LICENSE", "NOTICE", "README.md"]) copyFileSync(join(cliDir, file), join(pkg, file));
  symlinkSync(nodeModulesWith("ink"), join(pkg, "node_modules"), "junction");
  execFileSync(process.execPath, ["build.mjs", out], { cwd: cliDir, stdio: "pipe" });
}, 60_000);
afterAll(() => rmSync(pkg, { recursive: true, force: true }));

const importsOf = (source: string) =>
  [...source.matchAll(/^import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]!);

describe("the published bundle", () => {
  it("keeps ink and React out of everything the entry loads up front", () => {
    const files = readdirSync(out).filter((f) => f.endsWith(".mjs"));
    expect(files).toContain("clixad.mjs");
    // The entry and every chunk it imports statically are evaluated before main() runs.
    const upFront = new Set(["clixad.mjs"]);
    for (const file of upFront) {
      for (const spec of importsOf(readFileSync(join(out, file), "utf8"))) {
        if (spec.startsWith("./")) upFront.add(spec.slice(2));
      }
    }
    const reactOrInk = (spec: string) => /^(ink|react)(\/|$)/.test(spec);
    for (const file of upFront) {
      expect(importsOf(readFileSync(join(out, file), "utf8")).filter(reactOrInk), file).toEqual([]);
    }
    // And they are still in the bundle: in a chunk only reached by a dynamic import.
    const later = files.filter((f) => !upFront.has(f));
    expect(later.some((f) => importsOf(readFileSync(join(out, f), "utf8")).some(reactOrInk))).toBe(true);
  });

  it("runs, and finds its version from a chunk", () => {
    const printed = execFileSync(process.execPath, [join(out, "clixad.mjs"), "--version"], { encoding: "utf8" });
    expect(printed.trim()).toBe(VERSION);
  });
});

// A file mode means nothing on Windows, where npm writes a .cmd shim instead.
describe.skipIf(process.platform === "win32")("the command a package manager links", () => {
  // `bin` is what every package manager links, so that is the file checked,
  // whatever build.mjs happens to call its entry.
  const bin = () => join(pkg, manifest.bin.clixad);

  it("runs as a command, the way a shell starts `clixad`", () => {
    // Through the file's mode and its shebang, never through `node`: a bin
    // that is not executable fails here with EACCES, as `zsh: permission
    // denied: clixad` did. `env` in the shebang finds node on PATH.
    expect(statSync(bin()).mode & 0o111).toBe(0o111);
    const printed = execFileSync(bin(), ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(printed.trim()).toBe(VERSION);
  });

  it("is executable in the tarball npm packs", () => {
    // What a user installs is the tarball, and a package manager that only
    // extracts it keeps the mode recorded there. npm pack does not mark a bin
    // under dist/ itself, so this holds only if the file is executable on disk.
    // The npm that started this run passes its settings down as npm_config_*
    // (a -w among them), and they would make this pack a different package.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", pkg], {
        cwd: pkg,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { filename: string }[];
    const listing = execFileSync("tar", ["-tvzf", join(pkg, packed[0]!.filename)], { encoding: "utf8" });
    // Both bsdtar and GNU tar print the mode first and the path last.
    const entry = listing.split("\n").find((line) => line.trimEnd().endsWith(` package/${manifest.bin.clixad}`));
    expect(entry, listing).toBeDefined();
    expect(entry!.slice(0, 10)).toBe("-rwxr-xr-x");
  }, 60_000);
});
