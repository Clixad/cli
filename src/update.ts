/**
 * `/update`: install the newest clixad from npm without leaving the REPL.
 *
 * It used to be a line at startup, "Update with: npm install -g clixad@latest",
 * which people copied into another terminal or did not. Now the REPL runs it.
 *
 * Only for the install it can see is an npm global one, because that is the
 * one install `npm install -g` updates. Anything else is told what to run:
 *
 *  - **npx** fetches the package itself, and a global install would be a
 *    second copy nobody asked for;
 *  - **a source checkout** (or `npm link`, which points at one) would be
 *    replaced by the published package, link and all;
 *  - **pnpm, yarn or bun** keep their own global folders, which npm does not
 *    touch, so npm would report success and the running command would stay
 *    the old one;
 *  - **a project's own node_modules** is not npm's global folder either.
 *
 * Whether the package is in npm's global folder is read from the layout npm
 * gives a global install (`<prefix>/lib/node_modules/clixad` with
 * `<prefix>/bin/clixad`, or `<prefix>\node_modules\clixad` with
 * `<prefix>\clixad.cmd` on Windows), and otherwise asked of npm (`npm root
 * -g`): nvm, Homebrew and a custom prefix all put it somewhere different. npm
 * is then told that prefix, so the update lands where the running command
 * lives and not in whichever prefix npm is configured with today. The layout
 * comes first because npm masks anything in its output that looks like a
 * secret, a UUID in a path included.
 *
 * Nothing here prints. `runUpdate` returns an outcome and `updateLines` words
 * it, `performLogin`'s split, so a test can drive the whole thing with a fake
 * npm and a fake registry.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewerVersion } from "./version.ts";

/** The command a person can always run themselves, and the one every refusal names. */
export const UPDATE_COMMAND = "npm install -g clixad@latest";

export type Manager = "pnpm" | "yarn" | "bun";

export type Install =
  /** In npm's global folder: `/update` can update it. `prefix` is that install's own, when its layout names it. */
  | { kind: "npm"; dir: string; prefix?: string }
  | { kind: "npx" }
  /** A checkout, run with tsx or linked with `npm link`. */
  | { kind: "source"; dir: string }
  /** Another package manager's global folder. */
  | { kind: "manager"; manager: Manager }
  /** In some node_modules that is not npm's global one, or npm could not say. */
  | { kind: "elsewhere"; dir: string };

/** What a command run reported. `error` is a spawn failure (npm missing), not a non-zero exit. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export interface UpdateDeps {
  /** The installed package's directory, symlinks resolved. */
  packageDir: string;
  /** Whether a path exists, for reading the install's layout; `existsSync` unless a test says otherwise. */
  exists?: (path: string) => boolean;
  /** The version running now. */
  current: string;
  /** Run npm with these arguments. */
  npm: (args: readonly string[], signal: AbortSignal) => Promise<RunResult>;
  /** The newest version on npm, or undefined when the registry did not say. */
  latest: (signal: AbortSignal) => Promise<string | undefined>;
  /** The version a package directory holds now, read after npm ran. */
  installedVersion: (dir: string) => string | undefined;
  /** The newest version the gateway last reported, used when the registry did not answer. */
  gatewayLatest?: string | undefined;
  platform?: NodeJS.Platform;
}

export type UpdateOutcome =
  | { status: "current"; version: string }
  | { status: "updated"; from: string; to: string }
  | { status: "unsupported"; install: Exclude<Install, { kind: "npm" }> }
  | {
      status: "failed";
      reason: "permission" | "network" | "not-published" | "no-npm" | "other";
      /** What to run by hand, with the exact version when it is known. */
      command: string;
      /** npm's global folder, for a permission refusal. */
      dir?: string;
      /** npm's own first error line, cleaned, for an unexpected failure. */
      detail?: string;
    }
  | { status: "aborted"; command: string };

/** The package directory of the running CLI, from `src/` under tsx and from `dist/` once bundled. */
export function runningPackageDir(): string {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The version a package.json in `dir` states, or undefined. */
export function readPackageVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the running CLI was installed, from its directory and, for anything
 * that looks like an npm install, npm's own answer about its global folder.
 */
export async function detectInstall(
  packageDir: string,
  npmRoot: () => Promise<string | undefined>,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): Promise<Install> {
  const p = packageDir.split(sep).join("/");
  if (p.includes("/_npx/")) return { kind: "npx" };
  if (!p.includes("/node_modules/")) return { kind: "source", dir: packageDir };
  if (p.includes("/.pnpm/") || p.includes("/pnpm/global/") || p.includes("/pnpm-global/")) return { kind: "manager", manager: "pnpm" };
  if (p.includes("/.bun/install/global/")) return { kind: "manager", manager: "bun" };
  if (p.includes("/yarn/global/") || p.includes("/.yarn/")) return { kind: "manager", manager: "yarn" };
  const prefix = globalPrefixOf(packageDir, exists, platform);
  if (prefix) return { kind: "npm", dir: dirname(packageDir), prefix };
  const root = await npmRoot();
  if (root) {
    const expected = join(root, "clixad");
    let real = expected;
    try {
      real = realpathSync(expected);
    } catch {
      /* not installed there: compared as written */
    }
    if (same(real, packageDir) || same(expected, packageDir)) return { kind: "npm", dir: root };
  }
  return { kind: "elsewhere", dir: packageDir };
}

/**
 * The prefix of a global npm install that holds `packageDir`, read from its
 * layout, or undefined when it is not laid out like one. A project's own
 * node_modules has neither the `lib` (Unix) nor the bin shim beside it
 * (Windows), so it never matches.
 */
export function globalPrefixOf(
  packageDir: string,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const modules = dirname(packageDir);
  if (basename(packageDir) !== "clixad" || basename(modules) !== "node_modules") return undefined;
  if (platform === "win32") {
    const prefix = dirname(modules);
    return exists(join(prefix, "clixad.cmd")) ? prefix : undefined;
  }
  const lib = dirname(modules);
  if (basename(lib) !== "lib") return undefined;
  const prefix = dirname(lib);
  return exists(join(prefix, "bin", "clixad")) ? prefix : undefined;
}

function same(a: string, b: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s).replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

/** A version npm may be asked for: semver, so nothing else can reach a shell on Windows. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The command for one install, with the exact version when it is known. */
export function installCommand(version: string | undefined): string {
  return `npm install -g clixad@${version && VERSION.test(version) ? version : "latest"}`;
}

/** npm's error code, from `npm error code EACCES` (npm 10) or `npm ERR! code EACCES` (older). */
export function npmErrorCode(stderr: string): string | undefined {
  return /npm (?:error|ERR!) code (\w+)/.exec(stderr)?.[1];
}

/** The first line of npm's error that says something, without colour, prefixes or the log path. */
export function npmErrorDetail(stderr: string): string | undefined {
  for (const raw of stderr.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const m = /^npm (?:error|ERR!)\s*(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1]!.trim();
    if (!text || /^(code|errno|syscall|path|dest|A complete log|Log files|\d{4}-)/.test(text)) continue;
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
  return undefined;
}

const PERMISSION = new Set(["EACCES", "EPERM"]);
const NETWORK = new Set(["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
const NOT_PUBLISHED = new Set(["ETARGET", "E404"]);

/**
 * Update the running CLI if npm installed it globally. Never throws: every
 * failure is an outcome with the command a person can run instead.
 */
export async function runUpdate(deps: UpdateDeps, signal: AbortSignal): Promise<UpdateOutcome> {
  let npmMissing = false;
  const npmRoot = async () => {
    const r = await deps.npm(["root", "-g"], signal).catch(() => undefined);
    if (r?.error?.code === "ENOENT") npmMissing = true;
    const out = r && r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
    return out || undefined;
  };
  const install = await detectInstall(deps.packageDir, npmRoot, deps.exists, deps.platform);
  if (signal.aborted) return { status: "aborted", command: UPDATE_COMMAND };
  if (npmMissing) return { status: "failed", reason: "no-npm", command: UPDATE_COMMAND };
  if (install.kind !== "npm") return { status: "unsupported", install };

  const latest = (await deps.latest(signal).catch(() => undefined)) ?? deps.gatewayLatest;
  if (signal.aborted) return { status: "aborted", command: UPDATE_COMMAND };
  if (latest && VERSION.test(latest) && !isNewerVersion(latest, deps.current)) {
    return { status: "current", version: deps.current };
  }
  const command = installCommand(latest);
  const target = latest && VERSION.test(latest) ? latest : "latest";
  const r = await deps.npm(
    ["install", "-g", `clixad@${target}`, "--no-fund", "--no-audit", ...(install.prefix ? ["--prefix", install.prefix] : [])],
    signal,
  );
  if (signal.aborted) return { status: "aborted", command };
  if (r.error) {
    return r.error.code === "ENOENT"
      ? { status: "failed", reason: "no-npm", command }
      : { status: "failed", reason: "other", command, detail: r.error.message.slice(0, 200) };
  }
  if (r.code !== 0) {
    const code = npmErrorCode(r.stderr);
    if (code && PERMISSION.has(code)) return { status: "failed", reason: "permission", command, dir: install.dir };
    if (code && NETWORK.has(code)) return { status: "failed", reason: "network", command };
    if (code && NOT_PUBLISHED.has(code)) return { status: "failed", reason: "not-published", command };
    const detail = npmErrorDetail(r.stderr);
    return { status: "failed", reason: "other", command, ...(detail ? { detail } : {}) };
  }
  const now = deps.installedVersion(deps.packageDir) ?? (target === "latest" ? undefined : target);
  if (!now || now === deps.current) {
    // npm said yes and the package here did not change: it installed
    // somewhere this command does not run from.
    return {
      status: "failed",
      reason: "other",
      command,
      detail: `npm finished, but the clixad in ${deps.packageDir} is still ${deps.current}`,
    };
  }
  return { status: "updated", from: deps.current, to: now };
}

/** The lines `/update` prints for an outcome. The first carries the tone. */
export function updateLines(o: UpdateOutcome): { tone: "good" | "warn" | "error" | "plain"; lines: string[] } {
  switch (o.status) {
    case "current":
      return { tone: "good", lines: [`clixad ${o.version} is the newest version.`] };
    case "updated":
      return {
        tone: "good",
        lines: [
          `Updated clixad from ${o.from} to ${o.to}.`,
          "Restart it to use the new version: /exit, then `clixad --continue` picks this conversation up again.",
        ],
      };
    case "aborted":
      return {
        tone: "warn",
        lines: ["(stopped) npm was told to stop. If clixad does not start next time, run:", `  ${o.command}`],
      };
    case "unsupported": {
      const i = o.install;
      if (i.kind === "npx") {
        return { tone: "plain", lines: ["This clixad runs through npx. `npx clixad@latest` starts the newest version."] };
      }
      if (i.kind === "source") {
        return {
          tone: "plain",
          lines: [`This clixad runs from a source checkout (${i.dir}).`, "Update it with git pull and a rebuild; /update only updates an npm install."],
        };
      }
      if (i.kind === "manager") {
        const command =
          i.manager === "pnpm" ? "pnpm add -g clixad@latest" : i.manager === "bun" ? "bun add -g clixad@latest" : "yarn global add clixad@latest";
        return { tone: "plain", lines: [`This clixad was installed with ${i.manager}. Update it with:`, `  ${command}`] };
      }
      return {
        tone: "warn",
        lines: [
          `This clixad is not in npm's global folder (${i.dir}), or npm could not be asked where that is.`,
          "Update it where you installed it, or install it globally with:",
          `  ${UPDATE_COMMAND}`,
        ],
      };
    }
    case "failed": {
      const run = `  ${o.command}`;
      switch (o.reason) {
        case "permission":
          return {
            tone: "error",
            lines: [
              `The update did not go through: npm may not write to its global folder${o.dir ? ` (${o.dir})` : ""}.`,
              "Run it yourself in a terminal (on macOS or Linux, with sudo if your Node install needs it):",
              run,
            ],
          };
        case "network":
          return {
            tone: "error",
            lines: ["The update did not go through: npm could not reach the registry. Check the connection and try /update again, or run:", run],
          };
        case "not-published":
          return {
            tone: "error",
            lines: ["The update did not go through: npm does not have that version yet. Try again in a few minutes, or run:", run],
          };
        case "no-npm":
          return {
            tone: "error",
            lines: ["npm was not found on this machine's PATH, so /update cannot run it. Update clixad the way you installed it."],
          };
        default:
          return {
            tone: "error",
            lines: [
              `The update did not go through${o.detail ? `: ${o.detail}` : "."}`,
              "Run it yourself to see npm's whole answer:",
              run,
            ],
          };
      }
    }
  }
}

/** Run a command and collect its output. On Windows npm is `npm.cmd`, which needs a shell. */
export function runCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const child = spawn(command, [...args], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" },
    });
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    // SIGINT, which npm answers by rolling back what it had started to replace.
    const stop = () => child.kill("SIGINT");
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** The newest version on the registry, asked directly: the gateway reads it at most once an hour. */
export async function registryLatest(signal: AbortSignal): Promise<string | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  const forward = () => ac.abort();
  signal.addEventListener("abort", forward, { once: true });
  try {
    const res = await fetch("https://registry.npmjs.org/clixad/latest", {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && VERSION.test(body.version) ? body.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
}

/** The real dependencies, for the REPL. */
export function realUpdateDeps(current: string, gatewayLatest?: string): UpdateDeps {
  return {
    packageDir: runningPackageDir(),
    current,
    npm: (args, signal) => runCommand("npm", args, signal),
    latest: registryLatest,
    installedVersion: readPackageVersion,
    gatewayLatest,
  };
}

/**
 * The line said at startup when a newer version is out, or undefined when it
 * was already said today for that version. Once a UTC day per version, so
 * somebody who opens the REPL ten times a day reads it once.
 */
export function updateNotice(
  latest: string | undefined,
  current: string,
  shown: string | undefined,
  today: string,
): { text: string; mark: string } | undefined {
  if (!latest || !isNewerVersion(latest, current)) return undefined;
  const mark = `${latest}@${today}`;
  if (shown === mark) return undefined;
  return { text: `clixad ${latest} is out (you have ${current}). /update installs it.`, mark };
}
