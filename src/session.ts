/**
 * Session and input history persistence, next to the config in ~/.clixad.
 *
 *   sessions/<id>.json   one conversation (messages incl. tool results), so
 *                        `clixad --continue` / `--resume` can pick it back up
 *   history              the REPL's input history across restarts
 *
 * A session is rewritten whole on every turn rather than appended: compaction
 * rewrites earlier messages, so an append-only log would drift out of sync with
 * what the model actually sees. Conversations are small enough for this to be free.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withoutImages, type ChatMessage } from "./client.ts";

const ROOT = join(homedir(), ".clixad");
const SESSION_DIR = join(ROOT, "sessions");
const HISTORY_FILE = join(ROOT, "history");
const MAX_HISTORY = 200;
/**
 * How many conversations are kept, across every directory; the oldest go first.
 * It was 50 until 0.0.1-beta.45, which somebody working in a few projects
 * reached in a couple of weeks, and the conversations that fell off were gone
 * with nothing said. A session file is text (`withoutImages`), tens of
 * kilobytes for most, and `/resume` can now delete one by hand.
 */
export const MAX_SESSIONS = 200;

export interface StoredSession {
  id: string;
  /** ISO timestamp of the first turn. */
  started: string;
  updated: string;
  cwd: string;
  model: string;
  /** First user message, for the resume picker. */
  title: string;
  messages: ChatMessage[];
}

export type SessionMeta = Omit<StoredSession, "messages"> & {
  /** How many messages it holds, for the resume picker. */
  messageCount: number;
};

/**
 * What a session id may look like before it is turned into a path:
 * `newSessionId`'s shape, and anything else made only of filename-safe
 * characters. `/resume <id>` and `clixad --resume <id>` take it as typed, and
 * `../config` must not reach the config file through the session directory.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/**
 * Whether two paths name the same directory, the way the sessions are filed.
 *
 * Compared after `resolve`, so a trailing separator does not count. On Windows
 * also without regard to case: the same directory comes back from
 * `process.cwd()` as `C:\work` in one terminal and `c:\work` in another (the
 * drive letter follows how the shell was started), and a strict comparison
 * files them as two directories, so `/resume` in one cannot see the other's.
 */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export function sessionDir(): string {
  return SESSION_DIR;
}

export function newSessionId(): string {
  // Sortable and filename-safe: 20260723T142805-a1b2.
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${now}-${Math.random().toString(16).slice(2, 6)}`;
}

export function saveSession(session: StoredSession): void {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    // Without the image bytes: a session file was text until screenshots could
    // reach a conversation, and fifty of them carrying base64 is a directory
    // nobody asked for. See `withoutImages` — the live conversation keeps them.
    const stored: StoredSession = { ...session, messages: withoutImages(session.messages) };
    writeFileSync(join(SESSION_DIR, `${session.id}.json`), JSON.stringify(stored), "utf8");
    prune();
  } catch {
    // Persistence is a convenience — never break a turn over it.
  }
}

export function loadSession(id: string): StoredSession | undefined {
  if (!isSessionId(id)) return undefined;
  try {
    const s = JSON.parse(readFileSync(join(SESSION_DIR, `${id}.json`), "utf8")) as StoredSession;
    // A file that parses but is not a conversation (cut short by a full disk,
    // or not ours) would hand the REPL `undefined` for its messages.
    return s && Array.isArray(s.messages) && typeof s.id === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete one saved session. True when a file was removed.
 *
 * Only a file in the session directory named by a well-formed id: the id
 * arrives as typed, and this is the one function here that removes things.
 */
export function deleteSession(id: string): boolean {
  if (!isSessionId(id)) return false;
  const path = join(SESSION_DIR, `${id}.json`);
  try {
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Newest first. `cwd` filters to sessions started in that directory. */
export function listSessions(cwd?: string, limit = 20): SessionMeta[] {
  if (!existsSync(SESSION_DIR)) return [];
  const metas: SessionMeta[] = [];
  for (const name of readdirSync(SESSION_DIR)) {
    if (!name.endsWith(".json")) continue;
    const s = loadSession(name.slice(0, -5));
    if (!s) continue;
    if (cwd && !sameDirectory(s.cwd ?? "", cwd)) continue;
    const { messages, ...meta } = s;
    metas.push({ ...meta, title: meta.title ?? "", updated: meta.updated ?? "", messageCount: messages.length });
  }
  metas.sort((a, b) => b.updated.localeCompare(a.updated));
  return metas.slice(0, limit);
}

/**
 * Whether any saved session was started in `cwd`, which is how the REPL knows
 * somebody is coming back to a project rather than opening it for the first
 * time.
 *
 * Asked at every start, so it reads only the head of each file: `saveSession`
 * writes `cwd` before the messages, and parsing fifty whole conversations to
 * answer a yes-or-no question would put their size on the startup path. A head
 * that does not reach `cwd` (a title longer than the window) falls back to a
 * full read of that one file.
 */
export function hasSessionIn(cwd: string): boolean {
  if (!existsSync(SESSION_DIR)) return false;
  try {
    for (const name of readdirSync(SESSION_DIR)) {
      if (!name.endsWith(".json")) continue;
      const path = join(SESSION_DIR, name);
      let head = "";
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(4096);
        head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      } finally {
        closeSync(fd);
      }
      // The first `"cwd":` is the field: every key ahead of it is a date or
      // an id, and a quote inside the title further on is escaped.
      const field = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)?.[1];
      let stored: string | undefined;
      try {
        stored = field ? (JSON.parse(field) as string) : loadSession(name.slice(0, -5))?.cwd;
      } catch {
        stored = undefined;
      }
      if (stored && sameDirectory(stored, cwd)) return true;
    }
  } catch {
    // A directory we cannot read is not a reason to say anything at startup.
  }
  return false;
}

/** The session to pick up with `--continue`: newest in this directory. */
export function latestSession(cwd: string): StoredSession | undefined {
  const [meta] = listSessions(cwd, 1);
  return meta ? loadSession(meta.id) : undefined;
}

/** Keep the session directory from growing without bound: newest N survive. */
function prune(): void {
  const files = readdirSync(SESSION_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => ({ n, t: statSync(join(SESSION_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of files.slice(MAX_SESSIONS)) {
    try {
      rmSync(join(SESSION_DIR, n));
    } catch {
      /* ignore */
    }
  }
}

export function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).slice(-MAX_HISTORY).reverse();
  } catch {
    return [];
  }
}

/** History is newest-first in memory, oldest-first on disk (like a shell's). */
export function saveHistory(entries: string[]): void {
  try {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(HISTORY_FILE, entries.slice(0, MAX_HISTORY).reverse().join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }
}
