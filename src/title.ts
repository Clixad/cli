/**
 * What the terminal calls this program.
 *
 * A terminal names its tab after the foreground process, and for anything
 * shipped as a Node script that name is **node** — so every Clixad session sat
 * in the tab strip as an anonymous Node process, indistinguishable from the next
 * one. Two different mechanisms fix that, because "the terminal overview" is two
 * different things:
 *
 * - **OSC 0** (`ESC ] 0 ; <text> BEL`) sets the window *and* icon title in one
 *   sequence, which is what a tab strip renders. Every terminal that matters
 *   understands it (xterm, Terminal.app, iTerm2, Windows Terminal, VS Code,
 *   tmux); one that does not ignores it rather than printing it. BEL rather than
 *   the standard ST terminator, because Terminal.app is happier with it and
 *   nothing minds it.
 * - **`process.title`** is what `ps`, `pkill` and Activity Monitor show. One
 *   assignment, no escape sequence, and it is the half that still says something
 *   useful after the process is backgrounded.
 *
 * The escape is written **only to a TTY, and that is not overridable** — the same
 * rule the sponsored line follows, for the same reason: a control sequence in a
 * redirected stdout is corruption in a log file or in the JSON on the left-hand
 * side of a pipe, and `clixad -p` exists to be piped. `process.title` carries no
 * such hazard and is set unconditionally.
 *
 * `NO_COLOR` is deliberately *not* consulted, unlike the sponsored line: that
 * flag is a request about the output being read, and a title adds nothing to it.
 * `CI` is, because a runner that allocates a pty captures the raw stream, escapes
 * and all, into a build log nobody can strip them out of afterwards.
 */

/** The name the terminal should show. */
export const APP_TITLE = "Clixad";

/** The environment bits the gate consults. Passed in so tests can vary them. */
export interface TitleEnv {
  TERM?: string;
  CI?: string;
  CLIXAD_TITLE?: string;
}

export interface TitleGateInput {
  /** `process.stdout.isTTY` — the stream the sequence would land on. */
  isTTY: boolean | undefined;
  env: TitleEnv;
}

/**
 * Whether the title sequence may be written at all.
 *
 * Deny-shaped, like `sponsorEnabled`: anything it is unsure about writes
 * nothing. There is no forcing value — a title on a non-TTY has no reader and
 * no upside, so `CLIXAD_TITLE` only turns it off (for shells and multiplexers
 * that manage titles themselves and treat an app rewriting them as a bug).
 */
export function titleEnabled({ isTTY, env }: TitleGateInput): boolean {
  const flag = env.CLIXAD_TITLE?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  if (!isTTY) return false;
  if (env.TERM === "dumb") return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  return true;
}

/**
 * The OSC 0 sequence for a title.
 *
 * Control characters are stripped rather than escaped: a BEL or an ESC inside
 * the payload ends the sequence early and spills the rest onto the screen as
 * text, and a newline does the same to the line the box is drawn on. Today's
 * only caller passes a constant, so this is a guard for the day something
 * derives a title from a task, a branch name or a path.
 */
export function titleSequence(title: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, " ").trim()}\x07`;
}

/**
 * The stream to write the title to: the first of stdout, stderr that is a
 * terminal — or none, and then nothing is written at all.
 *
 * stdout alone was too strict. `npm run cli` can hand us a **piped stdout**
 * while the process is plainly attached to a terminal (`banner.ts`'s
 * `clearScreen` has always known this and falls back to `process.stdin.isTTY`),
 * and a title is exactly the thing you still want in that case. stderr is the
 * standard place for terminal control that must not enter the data stream, so
 * the "never into a pipe or a file" guarantee is unchanged: this only ever
 * writes to a stream that is itself a terminal.
 *
 * stdin is deliberately *not* used as the fallback the way `clearScreen` does:
 * it tells us a terminal is there, but it is not a stream we may write to.
 */
export function titleStream(
  streams: Pick<NodeJS.WriteStream, "isTTY" | "write">[] = [process.stdout, process.stderr],
): Pick<NodeJS.WriteStream, "isTTY" | "write"> | undefined {
  return streams.find((s) => s?.isTTY);
}

/**
 * Name the terminal window and the process.
 *
 * Called once at startup for every command, not just the REPL: `clixad earn`
 * waits five minutes for a reward and `clixad code` hands the terminal to Kimi,
 * and both are exactly the sessions somebody comes back to a tab strip looking
 * for.
 *
 * What this cannot do: change the name the *kernel* has for the process. A
 * `#!/usr/bin/env node` bin is exec'd as node, so `p_comm` is "node" and stays
 * "node" — `process.title` moves what `ps` prints, not that. A terminal whose
 * tab is configured to show the active process name will therefore keep saying
 * node no matter what is written here; the fix for that one is in the terminal's
 * profile, not in this file.
 */
export function setTerminalTitle(
  title: string = APP_TITLE,
  out: Pick<NodeJS.WriteStream, "isTTY" | "write"> | undefined = titleStream(),
): void {
  // Not gated: no bytes on any stream, and `ps` output is not somebody's log.
  process.title = title.toLowerCase();
  if (!out || !titleEnabled({ isTTY: out.isTTY, env: process.env })) return;
  out.write(titleSequence(title));
}

/**
 * Hand the title back on the way out.
 *
 * An empty title, not a saved one: the xterm title stack (`CSI 22;0t` /
 * `CSI 23;0t`) is not carried by every terminal we run in, and an ignored *pop*
 * leaves "Clixad" sitting on a tab that has moved on to something else — worse
 * than the empty string, which every terminal reads as "go back to your own
 * default". Shells that set a title per prompt (macOS zsh does) overwrite it a
 * moment later anyway.
 */
export function clearTerminalTitle(
  out: Pick<NodeJS.WriteStream, "isTTY" | "write"> | undefined = titleStream(),
): void {
  if (!out || !titleEnabled({ isTTY: out.isTTY, env: process.env })) return;
  out.write(titleSequence(""));
}
