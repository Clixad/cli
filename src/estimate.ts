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
import { usd, type ModelInfo, type PremiumAccess } from "./client.ts";

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
  opts: {
    /**
     * Only the low end, as `task ≥ low`: on a raised `/effort`, where the
     * shape (measured at the defaults) can say what a task costs at least
     * but not what a long one costs.
     */
    floor?: boolean;
    /**
     * What the verdict was measured against, when that is not the balance on
     * the status line ("9.8k premium"): said in the longest phrasing of a
     * warning, so a balance of bonus credits cannot read as covering a
     * premium task.
     */
    against?: string;
  } = {},
): { variants: string[]; warn: boolean } {
  const span = opts.floor
    ? shortCredits(range.low, "down")
    : range.low === range.high
      ? shortCredits(range.high, "up")
      : `${shortCredits(range.low, "down")}–${shortCredits(range.high, "up")}`;
  const head = `task ${opts.floor ? "≥" : "≈"} ${span}`;
  const tight = `${opts.floor ? "≥" : "≈"}${span}`;
  const against = opts.against ? ` · ${opts.against}` : "";
  switch (verdict) {
    case "free":
      return { variants: [`${head} · free`, `${tight} free`], warn: false };
    case "fits":
      return { variants: [`${head} cr`, `${tight} cr`], warn: false };
    case "tight":
      return {
        variants: [
          ...(against ? [`${head}${against} · may run short`] : []),
          `${head} · may run short`,
          `${tight}, may run short`,
          `${tight} tight`,
        ],
        warn: true,
      };
    case "short": {
      const way = freeElsewhere ? "/model" : "/earn";
      return {
        variants: [
          ...(against ? [`${head}${against} · not enough, ${way}`] : []),
          `${head} · not enough, ${way}`,
          `${tight}, not enough`,
          `${tight} short`,
        ],
        warn: true,
      };
    }
  }
}

/**
 * What one call on `model` may spend for this account, and the free allowance
 * that covers it first, in the shape `taskVerdict` takes.
 *
 * The gateway's own figure for this kind of model when it has one for the
 * balance on screen (`figures`, from `spendable`); else, on a premium model,
 * the premium credits it said this account has, since bonus credits never
 * reach one; else the balance, which claims nothing more. `free` counts only
 * on a model in today's free set.
 */
export function spendOn(
  model: Pick<ModelInfo, "id" | "access" | "free">,
  o: {
    balance: number;
    figures?: { budget: number; premium: number };
    premium?: PremiumAccess;
    free?: { models: string[]; credits_left: number };
  },
): { credits: number; freeLeft?: number } {
  const balance = Math.max(0, o.balance);
  const credits = o.figures
    ? Math.max(0, Math.min(balance, model.access === "premium" ? o.figures.premium : o.figures.budget))
    : model.access === "premium" && o.premium && !o.premium.unlocked
      ? Math.max(0, Math.min(balance, o.premium.credits))
      : balance;
  const onFree = Boolean(model.free && o.free?.models.includes(model.id));
  return { credits, ...(onFree ? { freeLeft: o.free!.credits_left } : {}) };
}

/**
 * What a `/model` row and `clixad models` say a task costs on that model, from
 * the conversation as it stands: `task ≈ 31k–164k · not enough (9.8k premium
 * credits)`. The verdict is against what this account may spend on that kind
 * of model (`spendOn`), which on a premium row is its premium credits, named
 * whenever it does not cover the task. The verdict comes before the figure
 * because a picker row is cut from the right on a narrow terminal. `floor` is
 * a raised `/effort`, where only the low end is known. A free row says nothing
 * more when the allowance covers it: the row already says it is free.
 */
export function taskHint(
  range: { low: number; high: number },
  verdict: TaskVerdict,
  o: { credits: number; premium: boolean; heldBack: boolean; floor?: boolean },
): string {
  const span = o.floor
    ? `task ≥ ${shortCredits(range.low, "down")}`
    : range.low === range.high
      ? `task ≈ ${shortCredits(range.high, "up")}`
      : `task ≈ ${shortCredits(range.low, "down")}–${shortCredits(range.high, "up")}`;
  const have = `${shortCredits(o.credits, "down")} ${o.premium ? "premium credits" : o.heldBack ? "usable" : "credits"}`;
  switch (verdict) {
    case "free":
      return span;
    case "fits":
      return `${span} · covered`;
    case "tight":
      return `${span} · may run short (${have})`;
    case "short":
      return `${span} · not enough (${have})`;
  }
}

/**
 * The task a model row quotes, at `contextTokens` of conversation, or undefined
 * when the gateway sent no task shape. One function for the picker and
 * `clixad models`, so the two say the same thing about the same row.
 */
export function rowTaskHint(
  model: ModelInfo,
  o: {
    shape: TaskShape | undefined;
    contextTokens: number;
    spend: Parameters<typeof spendOn>[1];
    floor: boolean;
  },
): string | undefined {
  if (!o.shape) return undefined;
  const range = estimateTask(model, o.contextTokens, o.shape);
  const { credits, freeLeft } = spendOn(model, o.spend);
  const verdict = taskVerdict(o.floor ? { low: range.low, high: range.low } : range, {
    balance: credits,
    ...(freeLeft !== undefined ? { freeLeft } : {}),
  });
  return taskHint(range, verdict, {
    credits,
    premium: model.access === "premium",
    heldBack: credits < Math.max(0, o.spend.balance),
    floor: o.floor,
  });
}

/**
 * The notice in front of a premium task that would stop part way, shown once a
 * session instead of sending it: what it likely costs, what premium may spend,
 * and the ways on. Enter again sends it anyway. The figures are the estimate's
 * and the gateway's; nothing is decided here but the wording.
 */
export function premiumShortNotice(o: {
  model: string;
  range: { low: number; high: number };
  credits: number;
  floor?: boolean;
  unlockUsd: number | null;
}): string {
  const cost = o.floor
    ? `at least ${shortCredits(o.range.low, "down")}`
    : `about ${shortCredits(o.range.low, "down")}–${shortCredits(o.range.high, "up")}`;
  return (
    `  This task likely costs ${cost} credits on ${o.model}, and premium models can spend ` +
    `${o.credits.toLocaleString("en-US")} of yours, so it would stop part way.\n` +
    "  Enter sends it anyway. /model picks a budget model, /earn opens the offer walls" +
    (typeof o.unlockUsd === "number" && o.unlockUsd > 0 ? `, /buy sells credits from ${usd(o.unlockUsd)}.` : ".")
  );
}

/**
 * The line under a finished premium turn when what premium may still spend is
 * below what a typical next task here costs, so the next one is not started
 * blind into a paywall.
 */
export function premiumLowNotice(o: {
  model: string;
  credits: number;
  low: number;
  unlockUsd: number | null;
}): string {
  return (
    `  ${o.credits.toLocaleString("en-US")} premium credits left, under what a typical next task on ${o.model} ` +
    `costs (about ${shortCredits(o.low, "down")}). /model picks a budget model, /earn` +
    (typeof o.unlockUsd === "number" && o.unlockUsd > 0 ? ` or /buy adds credits.` : " adds credits.")
  );
}
