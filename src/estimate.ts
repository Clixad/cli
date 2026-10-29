/**
 * The cost preview: roughly what the next task costs, and whether the wallet
 * covers it, shown on the status line while a task is being typed.
 *
 * **This is the one figure the CLI multiplies out itself**, and the exception is
 * deliberate. Everywhere else a number arrives finished from the gateway
 * (`turns_left`, `grant_per_ad`, a streak's schedule), because this program
 * cannot import the pricing engine and a figure derived here is one nothing forces to
 * agree with what is metered. Here the main input is the size of the
 * conversation, which only this process knows and which changes every turn;
 * asking the gateway would be a request per keystroke or per turn. So every
 * *rate* still comes from the gateway (`credits_per_mtoken_*` and `task_shape`
 * off `/v1/models`) and only the multiplication happens here, in the same shape
 * the engine meters: call by call, each rounded up. A test that can see both
 * holds it against the engine's own estimate for every model.
 *
 * It is labelled with `≈` wherever it is shown, and a gateway that sends no
 * `task_shape` gets no estimate at all rather than one built on a shape typed
 * into this file.
 */
import type { ModelInfo } from "./client.ts";

/** What the gateway says a task looks like, from its own ledger. */
export interface TaskShape {
  callsTypical: number;
  callsLong: number;
  growthTokens: number;
  outputTokens: number;
}

/**
 * Read `task_shape` off the catalog, or undefined.
 *
 * Refuses rather than repairs: a shape with a missing or nonsensical field is an
 * estimate built on a guess, and no estimate is the honest alternative.
 */
export function parseTaskShape(raw: unknown): TaskShape | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown, min: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= 1_000_000 ? Math.floor(v) : undefined;
  const callsTypical = count(r.calls_typical, 1);
  const callsLong = count(r.calls_long, 1);
  const growthTokens = count(r.growth_tokens, 0);
  const outputTokens = count(r.output_tokens, 0);
  if (callsTypical === undefined || callsLong === undefined) return undefined;
  if (growthTokens === undefined || outputTokens === undefined) return undefined;
  if (callsLong < callsTypical) return undefined;
  return { callsTypical, callsLong, growthTokens, outputTokens };
}

/** One call at the gateway's credit prices, rounded up the way `settle` rounds. */
function callCredits(model: ModelInfo, inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * model.credits_per_mtoken_input + outputTokens * model.credits_per_mtoken_output) / 1_000_000,
  );
}

function taskCredits(model: ModelInfo, contextTokens: number, calls: number, shape: TaskShape): number {
  const start = Math.max(0, Math.round(contextTokens));
  let total = 0;
  for (let i = 0; i < calls; i++) {
    total += callCredits(model, start + i * shape.growthTokens, shape.outputTokens);
  }
  return total;
}

/** A typical task at the low end and a long one at the high end, from here. */
export function estimateTask(
  model: ModelInfo,
  contextTokens: number,
  shape: TaskShape,
): { low: number; high: number } {
  return {
    low: taskCredits(model, contextTokens, shape.callsTypical, shape),
    high: taskCredits(model, contextTokens, shape.callsLong, shape),
  };
}

/**
 * Whether the task fits, in four answers rather than a yes or no.
 *
 * `free` when today's allowance covers even a long task on a free model; `fits`
 * when allowance and balance together do; `tight` when they cover a typical task
 * but not a long one; `short` when they do not cover a typical one either, which
 * is a task that stops at the paywall part-way through.
 */
export type TaskVerdict = "free" | "fits" | "tight" | "short";

export function taskVerdict(
  range: { low: number; high: number },
  wallet: { balance: number; freeLeft?: number },
): TaskVerdict {
  const free = Math.max(0, wallet.freeLeft ?? 0);
  if (free > 0 && free >= range.high) return "free";
  const available = Math.max(0, wallet.balance) + free;
  if (available >= range.high) return "fits";
  if (available >= range.low) return "tight";
  return "short";
}

/**
 * A credit figure short enough for a status line clause: `560`, `3.1k`, `19k`,
 * `1.2M`. The low end of a range rounds down and the high end up, so the range
 * printed always contains the one computed.
 */
export function shortCredits(n: number, direction: "down" | "up"): string {
  const round = direction === "down" ? Math.floor : Math.ceil;
  if (n < 1_000) return String(Math.max(0, Math.round(n)));
  if (n < 10_000) return `${trim(round(n / 100) / 10)}k`;
  if (n < 1_000_000) return `${round(n / 1_000)}k`;
  return `${trim(round(n / 100_000) / 10)}M`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The status line clause, and whether it should be drawn as a warning.
 *
 * Several phrasings, longest first, because the row is one row and an 80-column
 * terminal with a long model id has about 58 columns after the mode: the full
 * sentence does not fit there, and dropping the preview at the most ordinary
 * width there is would drop it for most people. `statusLine` takes the longest
 * that fits before it gives the clause up. Every phrasing keeps the verdict in
 * words, since colour is not there under `NO_COLOR` or in a pipe.
 *
 * `/model` is named when something free is left today to switch to, and `/earn`
 * otherwise, because pointing somebody at a picker with nothing free in it is a
 * detour that ends at the same wall.
 */
export function estimateClause(
  range: { low: number; high: number },
  verdict: TaskVerdict,
  freeElsewhere: boolean,
): { variants: string[]; warn: boolean } {
  const span =
    range.low === range.high
      ? shortCredits(range.high, "up")
      : `${shortCredits(range.low, "down")}–${shortCredits(range.high, "up")}`;
  const head = `task ≈ ${span}`;
  const tight = `≈${span}`;
  switch (verdict) {
    case "free":
      return { variants: [`${head} · free`, `${tight} free`], warn: false };
    case "fits":
      return { variants: [`${head} cr`, `${tight} cr`], warn: false };
    case "tight":
      return { variants: [`${head} · may run short`, `${tight}, may run short`, `${tight} tight`], warn: true };
    case "short":
      return {
        variants: [
          `${head} · not enough, ${freeElsewhere ? "/model" : "/earn"}`,
          `${tight}, not enough`,
          `${tight} short`,
        ],
        warn: true,
      };
  }
}
