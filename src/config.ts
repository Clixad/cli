/**
 * CLI config persistence. Stored at ~/.clixad/config.json.
 * Holds the gateway URL, the auth token, and the user's selected model.
 *
 * **Three rules about writing decide whether people stay signed in**, and all
 * three were learned from installs that signed themselves out for no reason the
 * user could see. They are the reason `saveConfig` is not a `writeFileSync`:
 *
 *  1. **An environment override is never written back.** `CLIXAD_GATEWAY_URL`
 *     is applied to the object `loadConfig` returns, and `saveConfig` used to
 *     write that object whole — so one run against a local gateway pinned
 *     `http://127.0.0.1:8787` into config.json permanently, the next plain run
 *     read it as a superseded default, and the identity migration below deleted
 *     the account with it. A variable exported into one shell must not be able
 *     to change what is on disk.
 *  2. **Only what this process actually changed is written.** The config is read
 *     once at startup and the object is held for the life of the process, so a
 *     second session writing its startup snapshot restored whatever the first
 *     had replaced. Every completed turn writes `turns`, so the window was not
 *     narrow. `saveConfig` re-reads the file and applies a diff against the
 *     object `loadConfig` handed out.
 *  3. **The write is atomic and a bad read is never silent.** `writeFileSync`
 *     truncates before it writes, so an interrupted save leaves a file that
 *     `JSON.parse` rejects — and the old `catch {}` turned that into "no token",
 *     with no message anywhere. Now the file is written through a temp file and
 *     a rename, an unreadable one is quarantined rather than overwritten, and
 *     both say so through `takeConfigNotices`.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  gatewayUrl: string;
  dashboardUrl: string;
  token?: string;
  userId?: string;
  email?: string;
  login?: string;
  /**
   * The endpoint that minted `token`, recorded at login.
   *
   * A bearer token means nothing to any gateway but the one that issued it, and
   * something has to remember which that was. That used to be `gatewayUrl`
   * itself, which worked only because every save wrote the whole object — the
   * behaviour rule 1 above exists to remove. So the binding is its own field,
   * written by `performLogin` from the *effective* URL, which is the one that
   * actually answered. An older config.json has none and falls back to its
   * stored `gatewayUrl`, so nothing about an existing install changes.
   */
  tokenGateway?: string;
  model: string;
  /**
   * Show the Clixad line under the spinner while a model call runs. Default on.
   *
   * Optional rather than `boolean` so an existing config.json — every install
   * that has ever logged in — keeps working untouched and lands on the default.
   * `false` here is the standing off switch; `CLIXAD_SPONSOR=0` is the one-off.
   * See `sponsor/render.ts`.
   */
  sponsor?: boolean;
  /**
   * How many turns this install has run, ever.
   *
   * The cadence of the feedback prompt, and nothing else: it fires on every
   * fiftieth turn. It lives here rather than in the session file because a
   * session almost never reaches fifty turns while an install reaches it in a
   * week — counted per session the prompt would essentially never appear, which
   * is a feature that exists only in the source.
   *
   * Optional for `sponsor`'s reason: every config.json that has ever been written
   * predates it and must keep working. `logout` deliberately leaves it alone —
   * it is a property of the install, not of the account, and resetting it on a
   * sign-out would mean somebody who switches accounts is asked again
   * immediately.
   */
  turns?: number;
  /**
   * The `/effort` setting per model id, as typed at `/effort` (already moved
   * to a level that model takes). A model with no entry runs at its default.
   *
   * Per model rather than one setting, Claude Code's choice and here for a
   * money reason too: one setting would carry a `max` chosen on a free model to
   * the dearest model in the catalog on the next `/model`. Optional for
   * `sponsor`'s reason. Written through `saveEffort`, never by replacing the
   * whole map, or a second session would undo the first one's setting.
   */
  effort?: Record<string, string>;
}

const CONFIG_PATH = join(homedir(), ".clixad", "config.json");

/**
 * Where an unreadable config.json is kept.
 *
 * It holds a bearer token, so it is worth recovering by hand and worth writing
 * 0600. Overwriting it in place would be the one way this module could destroy
 * an account that was merely unparseable.
 */
const QUARANTINE_PATH = `${CONFIG_PATH}.corrupt`;

/**
 * The model an install runs when nobody on it has chosen one.
 *
 * **Not the model new accounts start on**, and it must not be moved to become
 * one. Since `saveConfig` writes a diff (2026-09-09), a login no longer writes
 * `model`, so every install that signed up after that and never opened `/model`
 * has no model on disk and runs this. Changing it would move all of them to a
 * different model on their next start, silently, which is exactly what "existing
 * accounts keep their setting" rules out. A new account is given its model by
 * the gateway at signup instead (`default_model`, see `performLogin`), which
 * writes it to disk and so never reaches this line.
 */
export const FALLBACK_MODEL = "gemini-2.5-flash-lite";

const DEFAULTS: CliConfig = {
  // Where the token was minted and is bound (`tokenGateway`), so it stays put:
  // moving it would sign every install out. app.clixad.io is the same server.
  gatewayUrl: "https://clixad.onrender.com",
  // The ad wall is served by the gateway process itself, at its public
  // address, app.clixad.io since 2026-10-20. A
  // browser opened here is signed in by the handoff code, so the two fields
  // may name different hosts of one gateway.
  dashboardUrl: "https://app.clixad.io",
  model: FALLBACK_MODEL,
};

/**
 * Endpoints an explicitly-set environment variable may override.
 *
 * These have to be applied *after* the stored file, not folded into the defaults.
 * The stored value would otherwise always win — making `CLIXAD_GATEWAY_URL`
 * silently do nothing, despite `.env.example` advertising it as the way to point
 * the CLI at another gateway.
 */
/**
 * The keys these two tables may name: the string-valued ones.
 *
 * Both write a `string` into `config[key]`, so `keyof CliConfig` stopped
 * type-checking the moment a non-string field (`sponsor`) joined the interface —
 * the assignment narrows to `never`. Naming the string keys keeps the tables
 * honest instead of casting the error away, and a future non-string field is a
 * compile error here rather than a silent `"false"` in a boolean.
 */
type StringConfigKey = {
  [K in keyof CliConfig]-?: NonNullable<CliConfig[K]> extends string ? K : never;
}[keyof CliConfig];

const ENV_OVERRIDES: Array<[StringConfigKey, string]> = [
  ["gatewayUrl", "CLIXAD_GATEWAY_URL"],
  ["dashboardUrl", "CLIXAD_DASHBOARD_URL"],
];

/**
 * Endpoint values that were once the shipped default.
 *
 * Changing `DEFAULTS` only reaches installs that have never logged in — everyone
 * else keeps talking to whatever the default was on the day they signed up,
 * which for the whole pre-deployment history of this CLI is a `127.0.0.1` port
 * that now answers nothing. Moving the gateway to a real host without this is a
 * silent breakage for every existing user.
 *
 * A stored value listed here is treated as "never chosen, just inherited" and
 * gives way to the current default. Anything the user set themselves is
 * untouched, and pointing the CLI at a local gateway on purpose is what
 * `CLIXAD_GATEWAY_URL` is for — it is applied after this and still wins.
 *
 * `dashboardUrl` matters as much as `gatewayUrl` here despite looking cosmetic:
 * the ad wall is the primary way to earn credits, so a stale value does not
 * degrade the product, it dead-ends it.
 */
const SUPERSEDED_DEFAULTS: Partial<Record<StringConfigKey, string[]>> = {
  gatewayUrl: ["http://127.0.0.1:8787", "http://localhost:8787"],
  // clixad.onrender.com still answers, so an install that kept it would work;
  // it moves because the earn page's address is app.clixad.io (2026-10-20).
  dashboardUrl: ["http://127.0.0.1:8788", "http://localhost:8788", "https://clixad.onrender.com"],
};

/**
 * The identity fields: what a login writes, and what a gateway issued.
 *
 * Exported because `logout` has to delete exactly this set and used to spell it
 * out a second time — which is how `login` came to be left behind once already,
 * leaving somebody else's GitHub handle on the welcome banner after a sign-out.
 * One list, two callers.
 */
export const IDENTITY_KEYS = ["token", "userId", "email", "login", "tokenGateway"] as const;

/**
 * Do two endpoint strings name the same server?
 *
 * `http://localhost:8787` and `http://127.0.0.1:8787` are one gateway and must
 * not read as two: discarding a token because a URL was respelled would sign
 * somebody out of a gateway that still knows them. Anything `URL` cannot parse
 * falls back to a trimmed string compare.
 */
function sameEndpoint(a: string, b: string): boolean {
  const norm = (raw: string) => {
    try {
      const url = new URL(raw);
      const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
      return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return raw.trim().replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/** What `loadConfig` last handed out, for `saveConfig` to diff against. */
let baseline: CliConfig | undefined;

/** Keys whose value came from the environment on the last `loadConfig`. */
const envApplied = new Set<StringConfigKey>();

/** Things the user should be told about the last load, drained by the caller. */
let notices: string[] = [];

/**
 * Anything worth saying about the last `loadConfig`, once.
 *
 * `loadConfig` cannot print: it runs before the palette is resolved and before
 * the TUI exists, and the two surfaces render a notice completely differently.
 * So it records and the caller draws, the same split `performLogin` uses for its
 * outcome. Draining rather than reading, because two surfaces asking would
 * otherwise both print it.
 */
export function takeConfigNotices(): string[] {
  const out = notices;
  notices = [];
  return out;
}

interface StoredRead {
  stored: Partial<CliConfig>;
  /** Set when a file is there but could not be turned into an object. */
  problem?: string;
  /** The bytes behind `problem`, so they can be quarantined rather than lost. */
  raw?: string;
}

/**
 * Read config.json, telling "there is none" apart from "it is broken".
 *
 * Those two were one `catch {}` and that is the whole bug: an empty or truncated
 * file is indistinguishable from a fresh install, so the CLI silently started
 * signed out and the next save made it permanent. A missing file is the ordinary
 * state of an install nobody has logged into; anything else is a fault and has
 * to be reported.
 */
function readStored(): StoredRead {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { stored: {} };
    return { stored: {}, problem: `could not be read (${code ?? (err as Error).message})` };
  }
  // Zero bytes is precisely what an interrupted `writeFileSync` leaves behind,
  // since it truncates before it writes. `JSON.parse("")` throws, so without
  // this it would arrive as "not valid JSON" and point at the wrong cause.
  if (raw.trim() === "") return { stored: {}, problem: "was empty", raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { stored: {}, problem: "is not valid JSON", raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { stored: {}, problem: "is not a JSON object", raw };
  }
  return { stored: parsed as Partial<CliConfig> };
}

export function loadConfig(): CliConfig {
  notices = [];
  envApplied.clear();

  const read = readStored();
  const stored = read.stored;
  if (read.problem) {
    notices.push(
      `Your Clixad config (${CONFIG_PATH}) ${read.problem}, so this session starts signed out.\n` +
        `  It is kept at ${QUARANTINE_PATH} the next time anything is saved — sign in again with \`/login\`.`,
    );
  }

  // The gateway the stored token was minted against, before the migration below
  // is allowed to delete the field it may be standing in.
  const mintedAgainst = stored.gatewayUrl;

  // Drop inherited-and-since-moved endpoints before the stored file is layered
  // over the defaults. Guarded on `!== DEFAULTS[key]` so this is a no-op while a
  // listed value is still the current default, and starts migrating people the
  // moment DEFAULTS moves — no second edit, and nothing to forget.
  for (const [key, stale] of Object.entries(SUPERSEDED_DEFAULTS) as Array<
    [StringConfigKey, string[]]
  >) {
    const value = stored[key];
    if (typeof value === "string" && stale.includes(value) && value !== DEFAULTS[key]) {
      delete stored[key];
    }
  }

  const config = { ...DEFAULTS, ...stored };
  for (const [key, envVar] of ENV_OVERRIDES) {
    const value = process.env[envVar];
    if (value) {
      config[key] = value;
      envApplied.add(key);
    }
  }

  // A token belongs to the gateway that issued it, and sending it anywhere else
  // gets `401 {"error":"invalid token"}` forever — which the CLI reads as "not
  // logged in", so the install can explain itself but not fix itself.
  //
  // `tokenGateway` is the explicit binding; an older config.json has none and
  // falls back to the gateway it stored, which is what that field meant before
  // this was written down.
  //
  // **An env redirect is exempt, and that is the whole reason this is not just a
  // comparison.** `CLIXAD_GATEWAY_URL` pointing somewhere else is a detour for
  // one run, not a move: the stored token is still the right token for the
  // gateway it came from, and clearing it here would let one exported variable
  // destroy a real account at the next save. Nothing is persisted on that path
  // either (see `saveConfig`), so the detour ends when the shell does.
  const boundTo = stored.tokenGateway ?? mintedAgainst;
  const redirected = envApplied.has("gatewayUrl");
  if (!redirected && boundTo !== undefined && !sameEndpoint(boundTo, config.gatewayUrl)) {
    if (stored.token !== undefined) {
      notices.push(
        `Signed out: the saved account belongs to ${boundTo}, and this run talks to ${config.gatewayUrl}.\n` +
          `  Sign in again with \`/login\` (or \`clixad login\`).`,
      );
    }
    for (const key of IDENTITY_KEYS) delete config[key];
  }

  baseline = { ...config };
  return config;
}

/**
 * Which keys this process actually changed since `loadConfig` handed the object
 * out. A key that is gone counts as a change too — that is what `logout` does.
 *
 * With no baseline nothing called `loadConfig` in this process, so there is no
 * "changed" to speak of and the whole object is the answer. That path writes an
 * env override, but only a caller that never read the config can reach it, and
 * such a caller never had one applied.
 */
function changedKeys(config: CliConfig): string[] {
  const current = config as unknown as Record<string, unknown>;
  if (!baseline) return Object.keys(current);
  const before = baseline as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(current)]);
  return [...keys].filter((key) => before[key] !== current[key]);
}

/**
 * Replace config.json in one step.
 *
 * A rename is atomic, so a reader sees either the whole old file or the whole
 * new one and never the empty window `writeFileSync`'s truncate opens. The temp
 * file is created 0600 because it holds the token for as long as it exists, and
 * the rename carries that mode onto the real path — which is also what tightens
 * a config.json written 0644 by an older version.
 *
 * `fsync` before the rename, or the rename can be ordered ahead of the data it
 * is supposed to be publishing and a crash leaves the atomic swap pointing at
 * nothing.
 */
function writeAtomically(contents: string): void {
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

export function saveConfig(config: CliConfig): void {
  // 0700: this directory holds the bearer token that spends real credits, so it
  // has no business being world-readable on a shared machine.
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });

  const changed = changedKeys(config);
  const current = readStored();

  // A file we cannot parse is moved aside rather than merged with or silently
  // flattened. It may hold a token somebody still needs, and this is the only
  // moment it would otherwise be destroyed.
  let base: Record<string, unknown> = {};
  if (current.problem) {
    if (current.raw !== undefined) {
      try {
        writeFileSync(QUARANTINE_PATH, current.raw, { encoding: "utf8", mode: 0o600 });
      } catch {
        /* best effort — a failed backup must not fail the save */
      }
    }
  } else {
    base = current.stored as unknown as Record<string, unknown>;
  }

  // The merge is untyped on purpose: it is a JSON object being rebuilt key by
  // key from a name list, and `Partial<CliConfig>[K]` cannot be assigned through
  // a union key without a cast that would claim more than is known here. What
  // keeps it honest is that every name comes from a real `CliConfig` object.
  const next: Record<string, unknown> = { ...base };
  const source = config as unknown as Record<string, unknown>;
  for (const key of changed) {
    const value = source[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }

  writeAtomically(`${JSON.stringify(next, null, 2)}\n`);

  // What is on disk is what a later save in this process must diff against, or
  // the second save would replay the first one's changes over whatever another
  // session wrote in between.
  baseline = { ...config };

  // Windows only models the read-only bit and a stricter mode is not worth
  // failing a save over. The rename above already carries 0600 on POSIX, so this
  // is belt-and-braces for a filesystem that ignored the create mode.
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore — hardening, not a requirement */
  }
}

/**
 * Save the `/effort` setting for one model, `undefined` to go back to its default.
 *
 * `saveConfig` writes what this process changed, a whole top-level key at a
 * time, and the map is one key. Built from this process's copy alone, a
 * second session setting a different model would write its own stale map over
 * the first one's choice: rule 2 of this file's header, one level down. So the map is rebuilt
 * from what is on disk now, with only this model's entry changed.
 */
export function saveEffort(config: CliConfig, model: string, level: string | undefined): void {
  const current = readStored();
  const onDisk = current.problem ? undefined : current.stored.effort;
  const next: Record<string, string> = {};
  for (const [id, value] of Object.entries(onDisk && typeof onDisk === "object" ? onDisk : {})) {
    if (typeof value === "string") next[id] = value;
  }
  if (level === undefined) delete next[model];
  else next[model] = level;
  config.effort = Object.keys(next).length ? next : undefined;
  saveConfig(config);
}

export function configPath(): string {
  return CONFIG_PATH;
}
