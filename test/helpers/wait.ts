/**
 * Waiting for a state rather than for a length of time.
 *
 * The TUI tests used to `await tick(80)` after a keystroke and then read the
 * frame. On a laptop that is plenty; on a loaded CI runner the turn has not
 * started, or not finished, 80 ms later, and the test fails although the CLI
 * did nothing wrong. These poll until what the next line of the test depends
 * on is on screen, and give up after `WAIT_MS`, which is a bound and never a
 * sleep: a passing wait returns as soon as its state is there.
 *
 * No retries anywhere. A wait that runs out returns what it last read, and the
 * assertion after it fails on that, so a state that never comes is still a
 * failure, only a later one.
 */

/** How long a wait may take before the test reads what is there and fails on it. */
export const WAIT_MS = 4000;
const POLL_MS = 10;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** A frame as text, escape sequences removed. */
export const plainFrame = (frame: string | undefined): string => (frame ?? "").replace(ANSI, "");

/** Read `read()` until `ok` holds or `ms` passes, and return the last value read. */
export async function until<T>(read: () => T, ok: (value: T) => boolean, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (ok(value) || Date.now() >= end) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

type LastFrame = () => string | undefined;

/** The frame once it shows `text` (every one of them, if several), escape sequences removed. */
export function frameWith(lastFrame: LastFrame, text: string | string[], ms = WAIT_MS): Promise<string> {
  const all = Array.isArray(text) ? text : [text];
  return until(() => plainFrame(lastFrame()), (f) => all.every((t) => f.includes(t)), ms);
}

/** The frame once it no longer shows `text`, escape sequences removed. */
export function frameWithout(lastFrame: LastFrame, text: string, ms = WAIT_MS): Promise<string> {
  return until(() => plainFrame(lastFrame()), (f) => !f.includes(text), ms);
}

/** Wait until `ok()` is true, for state that is not on screen (a call made, a counter moved). */
export async function waitFor(ok: () => boolean, ms = WAIT_MS): Promise<void> {
  await until(ok, (v) => v, ms);
}

/** What the assertions after a wait expect of the frame. */
export interface FrameState {
  has?: string[];
  hasNot?: string[];
  matches?: RegExp[];
  matchesNot?: RegExp[];
}

/**
 * The frame once every expectation in `state` holds, escape sequences removed.
 *
 * Text is looked for as written and with runs of whitespace folded to one
 * space, because some assertions fold a notice that wraps across lines before
 * they read it. Waiting on the assertions themselves is what makes this safe:
 * it can only give a slow state more time, never let a wrong one through,
 * since the assertions still run on the frame afterwards.
 */
export function frameIn(lastFrame: LastFrame, state: FrameState, ms = WAIT_MS): Promise<string> {
  const fold = (f: string) => f.replace(/\s+/g, " ");
  return until(
    () => plainFrame(lastFrame()),
    (f) => {
      const folded = fold(f);
      return (
        (state.has ?? []).every((t) => f.includes(t) || folded.includes(t)) &&
        (state.hasNot ?? []).every((t) => !f.includes(t) && !folded.includes(t)) &&
        (state.matches ?? []).every((re) => re.test(f) || re.test(folded)) &&
        (state.matchesNot ?? []).every((re) => !re.test(f) && !re.test(folded))
      );
    },
    ms,
  );
}
