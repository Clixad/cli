/**
 * The house inventory: the only content the sponsored status line ever shows.
 *
 * "Sponsored" here means *by us*. There is no ad network behind this, no request
 * leaves the machine to fill it, and nothing a line says is bought. It is a slot
 * for our own content — usage tips, feature hints, facts about what a model
 * costs — that happens to sit where a network's line would go if one ever did.
 *
 * ## Why no line carries a number
 *
 * This program may import nothing but npm packages (see `build.mjs`: the
 * published bundle marks every bare specifier external), so the gateway's
 * pricing engine is out of reach here, and a credit figure typed into this file
 * would be a literal nothing forces to agree with the engine. That is exactly
 * how a wrong figure ends up in front of people.
 *
 * Lines that want a figure therefore declare a `needs` placeholder and get it
 * filled from data the CLI *already holds*, fetched from the gateway, which
 * derives it from the engine. There is deliberately no way to write a
 * literal: `SponsorLine.text` is checked by `test/sponsor.test.ts` for
 * comma-grouped digits.
 *
 * The two placeholders are both rendered by formatters that already exist and
 * already carry the mandatory label:
 *
 *   - `grant`        → `grantLabel()`       "~51,000 credits on completion (median)"
 *   - `ads_per_task` → `adsPerTaskLabel()`  "~18 ads/task on completion (median)"
 *
 * "on completion" is not decoration. A screenout is the *most common* outcome of
 * starting an offer, so an earn figure without it describes a wall that does not
 * exist. The median label is not decoration either: both figures rest on the
 * median completed offer, and offers pay well below and well above it. Both
 * formatters bake both labels in, which is why lines interpolate them rather
 * than the raw numbers.
 */

/** A runtime figure a line can ask for. Closed set, on purpose. */
export type SponsorNeeds = "grant" | "ads_per_task";

export interface SponsorLine {
  /**
   * Stable id. Rotation is by position, not by id, but a count reported in
   * aggregate later is only readable if the rows have names.
   */
  id: string;
  /**
   * The line. `{grant}` / `{ads_per_task}` are substituted when `needs`
   * names them; a line with an unresolvable placeholder is skipped, never shown
   * with the brace still in it.
   */
  text: string;
  needs?: SponsorNeeds;
}

/**
 * Room a line has on the narrowest terminal worth designing for.
 *
 * 80 columns minus the indent and the `✦ clixad ·` marker. The renderer will
 * truncate anything longer and the layout survives it, but a line that is
 * routinely cut in half is a line that was written too long — the reader gets a
 * clause and an ellipsis, which is worse than a shorter sentence. Enforced by
 * `test/sponsor.test.ts` against the *rendered* length, placeholder expansion
 * included, since that is what actually lands on the screen.
 */
export const LINE_BUDGET = 67;

/**
 * The inventory, in rotation order.
 *
 * Order is the rotation, so this list is versioned in the sense that matters:
 * changing it changes what a session shows next, and nothing else.
 */
export const HOUSE_LINES: readonly SponsorLine[] = [
  { id: "modes", text: "shift+tab cycles permission modes — plan mode is read-only" },
  { id: "interrupt", text: "esc stops a run mid-turn; tokens already generated are billed" },
  { id: "continue", text: "clixad --continue picks up the last session in this directory" },
  { id: "sessions", text: "clixad --resume lists your saved sessions" },
  { id: "context-files", text: "a CLIXAD.md or AGENTS.md in the repo root joins every prompt" },
  { id: "compaction", text: "long sessions compact themselves before the context fills up" },
  { id: "headless", text: 'clixad -p "…" runs headless, with read-only tools' },
  { id: "model-switch", text: "/model switches model mid-session — the conversation carries over" },
  { id: "help", text: "/help lists every slash command" },
  // Placed here rather than at the end of the list on purpose: the rotation is
  // the list, and appending it would put three business-y lines (earn,
  // screenout, this) back to back at the close of every cycle — the one stretch
  // that would read as an ad break.
  { id: "referral", text: "pass it on: clixad.io" },
  { id: "wallet", text: "/wallet shows your balance and what you've earned today" },
  { id: "cheapest-first", text: "/model lists cheapest-turn-first" },
  { id: "model-cost", text: "current model: {ads_per_task}", needs: "ads_per_task" },
  { id: "earn", text: "/earn: offers pay {grant}", needs: "grant" },
  { id: "screenout", text: "a screenout pays nothing and is normal — just start another" },
];
