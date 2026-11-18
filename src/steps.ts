/**
 * How long one turn may run on its own, and what is said when it stops.
 *
 * A turn is one message from the user and every model call the agent makes to
 * act on it. Each of those calls is billed and resends the conversation, so a
 * turn needs a ceiling: an agent that is stuck must not spend credits without
 * end. The ceiling used to be 16 calls, which a medium task reaches by itself
 * (reading a handful of files, editing a few, running the tests twice and
 * fixing what they say is already twenty), so ordinary work stopped part way
 * with "ask me to continue" and waited for a person to type it.
 *
 * Two guards replace it, each aimed at its own failure:
 *
 * - **A repeat guard** (`REPEAT_LIMIT`, in the agent loop): the same tool calls
 *   with the same results several rounds in a row is an agent going in
 *   circles, and it is stopped there, whatever the ceiling says. This is what
 *   catches the stuck agent early and cheaply.
 * - **A ceiling** high enough that real work finishes under it, set per install
 *   with `/steps` and saved in config.json. It is the backstop for a loop the
 *   repeat guard cannot see (calls that differ every time and never converge).
 *
 * Both say why they stopped, what the turn cost, and how to carry on.
 */
import type { CliConfig } from "./config.ts";

/** Model calls one turn may make, unless `/steps` says otherwise. */
export const DEFAULT_MAX_STEPS = 100;
/**
 * The range `/steps` accepts. There is no "unlimited": the ceiling is the only
 * thing that bounds a loop the repeat guard does not recognise, and a setting
 * that removed it would be a way to spend a wallet on nothing.
 */
export const MIN_MAX_STEPS = 10;
export const MAX_MAX_STEPS = 500;

/**
 * Rounds in a row with the same tool calls (names and arguments) and the same
 * results before the agent is stopped as going in circles.
 *
 * Four rather than two or three: a model that re-runs a failing command once
 * to be sure, or polls something that has not changed yet, is not stuck, and
 * stopping it would be the interruption this module exists to remove. By the
 * fourth identical round it has been told the same thing three times.
 * `read_output` says how long a command has been running, so polling a build
 * never reads as a repeat.
 */
export const REPEAT_LIMIT = 4;

/** The ceiling this install runs with: its saved setting when that is valid, else the default. */
export function maxStepsOf(config: Pick<CliConfig, "maxSteps">): number {
  const n = config.maxSteps;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_MAX_STEPS && n <= MAX_MAX_STEPS
    ? n
    : DEFAULT_MAX_STEPS;
}

/**
 * What `/steps <arg>` asks for: a number in range, `default`, or nothing usable
 * (with the sentence that says why).
 */
export function parseStepsArg(arg: string): { steps: number } | { reset: true } | { error: string } {
  const a = arg.trim().toLowerCase();
  if (a === "default" || a === "reset" || a === "auto") return { reset: true };
  if (!/^\d+$/.test(a)) {
    return { error: `/steps takes a number from ${MIN_MAX_STEPS} to ${MAX_MAX_STEPS}, or "default"` };
  }
  const n = Number(a);
  if (n < MIN_MAX_STEPS || n > MAX_MAX_STEPS) {
    return {
      error:
        n > MAX_MAX_STEPS
          ? `${n} is above the highest limit, ${MAX_MAX_STEPS}. A limit is what stops a stuck task from spending credits without end.`
          : `${n} is below the lowest limit, ${MIN_MAX_STEPS}.`,
    };
  }
  return { steps: n };
}

/** `/steps` with no argument: the setting and what it means. */
export function stepsSummary(config: Pick<CliConfig, "maxSteps">): string {
  const n = maxStepsOf(config);
  const which = n === DEFAULT_MAX_STEPS && config.maxSteps === undefined ? " (the default)" : "";
  return (
    `  A task may make up to ${n} model calls${which} before it stops and asks you to continue.\n` +
    `  It also stops as soon as it repeats the same tool calls with the same results ${REPEAT_LIMIT} times in a row.\n` +
    `  /steps <${MIN_MAX_STEPS}-${MAX_MAX_STEPS}> changes the limit, /steps default goes back to ${DEFAULT_MAX_STEPS}.`
  );
}

/** Why a turn stopped before the model said it was done. */
export type EarlyStop = "max_steps" | "repeating";

/**
 * The lines a stopped turn ends on, in the REPL (`repl: true`) or after
 * `clixad -p`.
 *
 * Every time: why it stopped and what to do next. In the REPL the work so far
 * is in the conversation, so "continue" picks it up; a `-p` run keeps no
 * session, so there the way on is a narrower task or a higher limit, and the
 * limit is set in the REPL because that is where `/steps` is.
 */
export function earlyStopLines(stop: EarlyStop, opts: { steps: number; limit: number; repl: boolean }): string[] {
  if (stop === "repeating") {
    return [
      `Stopped: the agent made the same tool calls with the same results ${REPEAT_LIMIT} times in a row, so it was going in circles.`,
      opts.repl
        ? 'The work so far is kept. Type "continue" to let it try again, ideally with a hint about what to do differently.'
        : "Run it again with a hint about what to do differently.",
    ];
  }
  return [
    `Stopped after ${opts.steps} model calls, this turn's limit, so a stuck task cannot spend credits without end.`,
    opts.repl
      ? `The work so far is kept. Type "continue" to carry on, or raise the limit with /steps (now ${opts.limit}).`
      : `Give it a narrower task, or raise the limit with /steps in the REPL (now ${opts.limit}).`,
  ];
}
