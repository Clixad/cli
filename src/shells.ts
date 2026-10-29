/**
 * Background shell commands, and the registry that outlives one tool call.
 *
 * `run_command` blocks until the process exits and kills it after two minutes,
 * which is right for a build and useless for the thing an agent most often
 * needs: a dev server, a watcher, a test run in `--watch`. Those never exit, so
 * starting one used to mean either freezing the turn for two minutes or not
 * doing it at all.
 *
 * A background command is therefore a different shape, not a longer timeout. It
 * returns an id immediately, keeps running across turns, and the model reads
 * whatever it has printed *since it last looked* — a cursor, not a re-dump, so
 * watching a log costs the new lines rather than the whole file every time.
 *
 * Two rules the registry exists to keep:
 *
 *  - **Nothing outlives the CLI.** A dev server the agent started is ours to
 *    stop; leaving one holding port 3000 after the terminal closed is the kind
 *    of thing people rightly never forgive. `killAll` runs on exit and on the
 *    signals that precede it.
 *  - **Memory is bounded.** A watcher printing a line a second for an hour is
 *    normal, so the buffer is a window over the tail and the registry says out
 *    loud when output fell off the front of it.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Characters of output kept per shell. Older output falls off the front. */
export const MAX_SHELL_BUFFER = 200_000;
/** Background commands that may run at once. */
export const MAX_SHELLS = 8;
/**
 * Finished commands kept around before the oldest is forgotten.
 *
 * `MAX_SHELLS` bounds only what is *running*, so nothing bounded this at all: a
 * session that starts and finishes one command after another kept every one of
 * them, each holding up to `MAX_SHELL_BUFFER` characters, for as long as the
 * REPL was open — a hundred test runs is twenty megabytes of output nobody will
 * read again. Recent ones stay because reading a command that has just exited
 * is the ordinary way the model collects its result; a command that finished
 * eight commands ago is not one anybody is still asking about.
 */
export const MAX_FINISHED_SHELLS = 8;
/** Lines of a fresh shell's output the caller may want as a preview. */
export const START_PREVIEW_MS = 400;

export type ShellStatus = "running" | "exited" | "killed" | "failed";

export interface ShellSnapshot {
  id: string;
  command: string;
  status: ShellStatus;
  /** Present once it has stopped. Null when it was killed by a signal. */
  exitCode?: number | null;
  startedAt: number;
  runningMs: number;
}

export interface ShellRead {
  snapshot: ShellSnapshot;
  /** Everything printed since the last read of this shell. */
  output: string;
  /** Characters that fell out of the buffer before they were ever read. */
  missed: number;
  /** Set when `filter` dropped lines, so an empty result is not a mystery. */
  filtered?: { kept: number; total: number };
}

export class ShellError extends Error {}

interface Entry {
  id: string;
  command: string;
  child: ChildProcess;
  status: ShellStatus;
  exitCode?: number | null;
  startedAt: number;
  /** Tail of the output, at most MAX_SHELL_BUFFER characters. */
  buffer: string;
  /** Characters discarded from the front of the buffer, ever. */
  dropped: number;
  /** Absolute offset already handed to a reader. */
  cursor: number;
  /** Set the moment we ask it to die, so a 0 exit code still reads as killed. */
  killing: boolean;
}

/**
 * Kill a command and everything it started.
 *
 * `child.kill()` reaches only the shell we spawned, so on Windows — where the
 * shell is cmd.exe and the real work is a grandchild — it would leave the build
 * running. Lives here rather than in `tools.ts` because both the foreground and
 * the background path need it and two implementations of "stop the process
 * tree" is how one of them grows a leak.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // Negative pid = the whole process group (see `detached` at the spawn site).
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export class ShellRegistry {
  private entries = new Map<string, Entry>();
  private seq = 0;

  /** Start a command in the background and return it before it has finished. */
  start(root: string, command: string, now = Date.now()): ShellSnapshot {
    this.pruneFinished();
    const live = [...this.entries.values()].filter((e) => e.status === "running");
    if (live.length >= MAX_SHELLS) {
      throw new ShellError(
        `${MAX_SHELLS} background commands are already running (${live.map((e) => e.id).join(", ")}) — ` +
          "stop one with kill_shell before starting another",
      );
    }

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: root,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        // Nothing types at a background command, and leaving stdin inherited
        // lets it steal the keystrokes meant for the REPL.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Most spawn failures arrive as the `error` event below; a few — a
      // command carrying a NUL byte, say — are raised synchronously, and a raw
      // `TypeError` out of here is a fault the agent loop ends the turn on.
      // `ShellError` is what the caller already knows how to tell the model.
      throw new ShellError(`could not start that command: ${(err as Error).message}`);
    }

    const entry: Entry = {
      id: `bash_${++this.seq}`,
      command,
      child,
      status: "running",
      startedAt: now,
      buffer: "",
      dropped: 0,
      cursor: 0,
      killing: false,
    };

    const append = (buf: Buffer) => {
      entry.buffer += buf.toString("utf8");
      if (entry.buffer.length > MAX_SHELL_BUFFER) {
        const over = entry.buffer.length - MAX_SHELL_BUFFER;
        entry.buffer = entry.buffer.slice(over);
        entry.dropped += over;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      entry.status = "failed";
      append(Buffer.from(`\n[failed to start: ${err.message}]\n`));
    });
    child.on("close", (code) => {
      // `failed` already says what happened; a close after an error must not
      // overwrite it with a plain exit.
      if (entry.status === "failed") return;
      entry.status = entry.killing ? "killed" : "exited";
      entry.exitCode = code;
    });

    this.entries.set(entry.id, entry);
    installExitHook(this);
    return snapshot(entry, now);
  }

  /** Everything printed since the last read. Advances that shell's cursor. */
  read(id: string, opts: { filter?: string } = {}, now = Date.now()): ShellRead {
    const entry = this.require(id);
    const from = Math.max(entry.cursor, entry.dropped);
    const missed = Math.max(0, entry.dropped - entry.cursor);
    const raw = entry.buffer.slice(from - entry.dropped);
    entry.cursor = entry.dropped + entry.buffer.length;

    if (!opts.filter) return { snapshot: snapshot(entry, now), output: raw, missed };

    let re: RegExp;
    try {
      re = new RegExp(opts.filter);
    } catch (err) {
      throw new ShellError(`invalid filter regular expression: ${(err as Error).message}`);
    }
    const lines = raw.split("\n");
    const kept = lines.filter((line) => re.test(line));
    return {
      snapshot: snapshot(entry, now),
      output: kept.join("\n"),
      missed,
      filtered: { kept: kept.length, total: lines.length },
    };
  }

  /** Stop a shell. Idempotent: killing a finished one is not an error. */
  kill(id: string, now = Date.now()): ShellSnapshot {
    const entry = this.require(id);
    if (entry.status === "running") {
      entry.killing = true;
      killTree(entry.child);
      // Reported immediately rather than awaited: `close` may take as long as
      // the process wants, and the caller asked us to stop it, not to watch it.
      entry.status = "killed";
    }
    return snapshot(entry, now);
  }

  list(now = Date.now()): ShellSnapshot[] {
    return [...this.entries.values()].map((e) => snapshot(e, now));
  }

  /**
   * Forget all but the most recent `MAX_FINISHED_SHELLS` finished commands.
   *
   * Run when a new one starts, which is the only moment the registry grows.
   * Running commands are never touched — those are `killAll`'s and
   * `kill`'s — and the Map's insertion order is the start order, so "oldest"
   * needs no timestamp.
   *
   * This replaces a `forget(id)` that nothing ever called: an explicit
   * single-entry drop is only useful to a caller who knows a shell is finished
   * with, and neither the tools nor the REPL is in a position to know that.
   */
  private pruneFinished(): void {
    const finished = [...this.entries.values()].filter((e) => e.status !== "running");
    for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_SHELLS))) {
      this.entries.delete(entry.id);
    }
  }

  /** Stop everything. Called on exit; safe to call more than once. */
  killAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== "running") continue;
      entry.killing = true;
      entry.status = "killed";
      try {
        killTree(entry.child, "SIGKILL");
      } catch {
        /* nothing left to do at exit */
      }
    }
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry) return entry;
    const known = [...this.entries.keys()];
    throw new ShellError(
      known.length
        ? `no background command with id ${id} — running ones are: ${known.join(", ")}`
        : `no background command with id ${id} — none have been started`,
    );
  }
}

function snapshot(entry: Entry, now: number): ShellSnapshot {
  return {
    id: entry.id,
    command: entry.command,
    status: entry.status,
    ...(entry.status === "running" ? {} : { exitCode: entry.exitCode ?? null }),
    startedAt: entry.startedAt,
    runningMs: Math.max(0, now - entry.startedAt),
  };
}

/** The registry the tools use. One per process, which is what "background" means. */
export const shells = new ShellRegistry();

/**
 * Make sure nothing we started survives us.
 *
 * Installed on the first `start` rather than at import, so a process that never
 * runs a background command never registers a handler — and once, because a
 * listener per shell would trip Node's max-listeners warning at eleven.
 *
 * `exit` is the one that always fires and may only run synchronously, which
 * `killAll` is. The signal handlers are there because a REPL is usually ended
 * with ctrl+c, and a default-handled SIGINT never reaches `exit` at all; each
 * re-raises after cleaning up so the exit code still says what happened.
 */
let hookInstalled = false;
function installExitHook(registry: ShellRegistry): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", () => registry.killAll());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      registry.killAll();
      // Only take over termination if nobody else wanted it: with another
      // listener attached (the REPL's own ctrl+c handling) exiting here would
      // steal the keypress that was meant to clear the input line.
      if (process.listenerCount(sig) <= 1) process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}
