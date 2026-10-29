/**
 * `/effort`: how long the model thinks before it answers, set per model.
 *
 * The gateway decides what a setting means and sends each model's settings on
 * `/v1/models`. What lives here is the
 * vocabulary, which is a protocol and not a price, and the one rule the CLI
 * needs to say what a stored setting will run at. The gateway applies the same
 * rule again to whatever arrives, so a CLI that gets it wrong changes what is
 * printed and never what is sent to a model.
 *
 * Saved per model, Claude Code's choice and here for a money reason as well:
 * one setting for every model would carry a `max` chosen on a free model to the
 * dearest one in the catalog the moment somebody switched.
 */
import type { CliConfig } from "./config.ts";

/** The scale, cheapest first. Mirrors the gateway's own list. */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What a model's row on `/v1/models` says about its settings. */
export interface EffortInfo {
  efforts?: string[];
  default_effort?: string;
}

function isLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

const rank = (level: EffortLevel) => EFFORT_LEVELS.indexOf(level);

/** The levels a model takes, as the gateway listed them, keeping only ones this CLI knows. */
export function effortsOf(info: EffortInfo | undefined): EffortLevel[] {
  return (info?.efforts ?? []).filter(isLevel);
}

/** A level typed at `/effort`, or undefined. `none` is OpenAI's word for `off`. */
export function parseEffortArg(arg: string): EffortLevel | "auto" | undefined {
  const v = arg.trim().toLowerCase();
  if (v === "auto" || v === "default") return "auto";
  if (v === "none") return "off";
  return isLevel(v) ? v : undefined;
}

/**
 * What `requested` runs at on a model with these settings, or undefined for the
 * model's own default. The gateway's `resolveEffort`, kept in step by
 * `effort.test.ts` on both sides.
 */
export function resolveEffort(info: EffortInfo | undefined, requested: string | undefined): EffortLevel | undefined {
  if (!isLevel(requested)) return undefined;
  const efforts = effortsOf(info);
  if (efforts.length === 0) return undefined;
  if (!isLevel(info?.default_effort)) return requested === "off" && efforts.includes("off") ? "off" : undefined;
  if (efforts.includes(requested)) return requested;
  const below = efforts.filter((e) => rank(e) <= rank(requested));
  return below.length ? below[below.length - 1] : efforts[0];
}

/** The setting saved for `model`, if any. */
export function savedEffort(config: Pick<CliConfig, "effort">, model: string): string | undefined {
  const value = config.effort?.[model];
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether the setting makes the model think more than its default.
 *
 * The cost preview's task shape was measured at the defaults, so a raised
 * setting is the one case where the preview would say too little. A lowered
 * one makes it say too much, which is the direction it already rounds in.
 */
export function effortRaised(info: EffortInfo | undefined, level: EffortLevel | undefined): boolean {
  if (!level || !isLevel(info?.default_effort)) return false;
  return rank(level) > rank(info.default_effort as EffortLevel);
}

/** The words for a level: "thinking off" reads better than "off effort". */
export function effortLabel(level: string): string {
  if (level === "off") return "thinking off";
  if (level === "on") return "thinking on";
  return `${level} effort`;
}
