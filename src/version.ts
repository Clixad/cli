/**
 * The CLI's version, read from the one file that is allowed to state it.
 *
 * It used to be the literal `"v0.0.1"` typed into `app.tsx`'s banner, which had
 * already drifted two publishes behind by the time anybody looked at it — the
 * welcome box on a `0.0.1-beta.2` install greeted people as v0.0.1. A version is
 * the one string a user quotes back in a bug report, so it may not be a copy.
 *
 * `../package.json` resolves correctly from **both** places this module runs,
 * which is why it is a runtime read and not a build-time constant:
 *
 * - `src/version.ts` under tsx → `apps/cli/package.json`
 * - `dist/clixad.mjs` in the published tarball → the installed `package.json`,
 *   which npm ships in every package whatever `files` says.
 *
 * An esbuild `define` would have covered only the second, leaving `npm run cli`
 * to print a hardcoded fallback — the same drift in a new hiding place.
 *
 * Failure is not worth crashing over: an unreadable package.json yields
 * `"unknown"`, so a banner still draws and `--version` still answers.
 */
import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** `0.0.1-beta.3` — bare, no leading v. Read once; it cannot change at runtime. */
export const VERSION = readVersion();

/** `v0.0.1-beta.3` — for the banner, where the v is part of the label. */
export const VERSION_LABEL = `v${VERSION}`;

/**
 * Whether `candidate` is a later release than `current`, by semver precedence.
 *
 * Enough of semver for this package's versions: three numeric parts, then an
 * optional pre-release whose dot-separated identifiers compare numerically
 * when both are numbers (`beta.10` is after `beta.9`) and as text otherwise. A
 * release is after any pre-release of the same version. Anything that does not
 * parse is never "newer": a notice built on a version string nobody can read
 * would be the update prompt nobody can act on.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!m) return undefined;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]!;
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) return nx > ny;
    if (nx !== undefined) return false;
    if (ny !== undefined) return true;
    return x > y;
  }
  return false;
}
