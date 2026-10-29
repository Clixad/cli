/**
 * The terminal title: when it may be written, and what it writes.
 *
 * The gate is the interesting half. A title is a control sequence, so the whole
 * risk is writing one somewhere it is not a title but bytes — a redirected
 * stdout, a piped `clixad -p`, a CI log — which is why `titleEnabled` takes its
 * world as an argument instead of reading `process`.
 */
import { describe, expect, it } from "vitest";
import { APP_TITLE, setTerminalTitle, titleEnabled, titleSequence, titleStream } from "../src/title.ts";

const on = { isTTY: true, env: { TERM: "xterm-256color" } };

describe("titleEnabled", () => {
  it("writes to an interactive terminal", () => {
    expect(titleEnabled(on)).toBe(true);
  });

  it("never writes to something that is not a terminal", () => {
    // Piped, redirected, captured — where the sequence would be data, not a title.
    expect(titleEnabled({ ...on, isTTY: false })).toBe(false);
    expect(titleEnabled({ ...on, isTTY: undefined })).toBe(false);
    expect(titleEnabled({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
    // A CI runner with a pty still captures the raw stream into a build log.
    expect(titleEnabled({ isTTY: true, env: { ...on.env, CI: "true" } })).toBe(false);
  });

  it("takes CLIXAD_TITLE=0 for shells that manage their own titles", () => {
    for (const flag of ["0", "false", "off", "no", "OFF"]) {
      expect(titleEnabled({ ...on, env: { ...on.env, CLIXAD_TITLE: flag } })).toBe(false);
    }
    // There is no forcing value: a title on a non-TTY has no reader.
    expect(titleEnabled({ isTTY: false, env: { CLIXAD_TITLE: "1" } })).toBe(false);
  });
});

describe("titleSequence", () => {
  it("is OSC 0, so it sets the tab and the window at once", () => {
    expect(titleSequence(APP_TITLE)).toBe("\x1b]0;Clixad\x07");
  });

  it("strips control characters instead of letting them end the sequence early", () => {
    // A BEL or ESC in the payload would close the OSC and spill the rest onto
    // the screen as text. Only a constant is passed today; this is for the day
    // a title is derived from a task or a branch name.
    expect(titleSequence("a\x07b\x1bc\nd")).toBe("\x1b]0;a b c d\x07");
    expect(titleSequence("  Clixad  ")).toBe("\x1b]0;Clixad\x07");
  });
});

/**
 * Which stream the sequence goes on. stdout alone was too strict: `npm run cli`
 * can hand the process a piped stdout while it is plainly attached to a terminal
 * — `clearScreen` in banner.ts has always known that — and the title is exactly
 * what you still want then.
 */
describe("titleStream", () => {
  const s = (isTTY: boolean | undefined) => ({ isTTY, write: () => true }) as unknown as NodeJS.WriteStream;

  it("prefers stdout when it is a terminal", () => {
    const stdout = s(true);
    expect(titleStream([stdout, s(true)])).toBe(stdout);
  });

  it("falls back to stderr when stdout is piped", () => {
    const stderr = s(true);
    expect(titleStream([s(false), stderr])).toBe(stderr);
  });

  it("picks nothing when neither is a terminal", () => {
    // The guarantee that matters: never into a pipe or a file, on any stream.
    expect(titleStream([s(false), s(false)])).toBeUndefined();
    expect(titleStream([s(undefined), s(undefined)])).toBeUndefined();
  });
});

describe("setTerminalTitle", () => {
  /** A stdout stand-in that records what it was given. */
  const fakeOut = (isTTY: boolean) => {
    const written: string[] = [];
    return { written, out: { isTTY, write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream };
  };

  it("writes nothing at all when no stream is a terminal", () => {
    setTerminalTitle(APP_TITLE, titleStream([fakeOut(false).out, fakeOut(false).out]));
    expect(process.title).toBe("clixad"); // ps still names it, with no bytes written
  });

  it("names the process even when it must stay off the stream", () => {
    const { written, out } = fakeOut(false);
    setTerminalTitle(APP_TITLE, out);
    expect(written).toEqual([]); // nothing on a redirected stdout, ever
    expect(process.title).toBe("clixad"); // but `ps` still says clixad, not node
  });

  it("writes the sequence to a terminal", () => {
    const { written, out } = fakeOut(true);
    setTerminalTitle(APP_TITLE, out);
    // The env decides: this suite runs under CI on the runner, where the gate
    // says no, and on a developer's machine, where it says yes.
    expect(written).toEqual(titleEnabled({ isTTY: true, env: process.env }) ? [titleSequence(APP_TITLE)] : []);
  });
});
