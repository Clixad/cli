/**
 * The account's preferences in the CLI: kept with the account,
 * so a model, a reasoning setting, a name and instructions set in the
 * browser's chat or on its account page hold here too, and the other way round.
 *
 * Two rules decide every disagreement:
 *
 *  - **What the account holds wins.** When the REPL opens, a model or an effort
 *    the account names replaces the local one in `config.json`, because the
 *    most recent choice may have been made in the browser. From then on `/model`
 *    and `/effort` write to both, so the account stays the latest word.
 *  - **What only this machine knows goes up once.** An install from before this
 *    release has a model and efforts the account has never heard of; on the
 *    first sync they are sent, so the browser's chat starts where the CLI is.
 *
 * The sponsored line is the one preference applied without being written to
 * `config.json`: "off" on the account turns it off for the session, and
 * clearing it there turns it back on, which a copy saved locally would stop.
 * The name and the instructions are said to the model on every turn
 * (`preferencesInstruction`), like the permission mode.
 *
 * Everything here is best-effort: a gateway that cannot answer leaves the
 * REPL as it was, since a preference is never a reason for it not to open.
 */
import type { AccountSettings } from "./client.ts";
import { FALLBACK_MODEL, saveConfig, saveEffort, type CliConfig } from "./config.ts";

/** What a turn needs from the account's preferences. */
export interface TurnPreferences {
  name: string | null;
  instructions: string | null;
  /** False when the account turned the sponsored line off. */
  sponsorLine: boolean | null;
}

/** The part of the client this needs, so a test can stand in for it. */
export interface SettingsWriter {
  saveSettings(change: Record<string, unknown>): Promise<unknown>;
}

/**
 * Bring `config` and the account's preferences into line, as the REPL opens.
 * Returns what a turn needs; never throws.
 */
export async function syncPreferences(
  client: SettingsWriter,
  config: CliConfig,
  settings: AccountSettings | null,
): Promise<TurnPreferences> {
  if (!settings) return { name: null, instructions: null, sponsorLine: null };
  const upload: Record<string, unknown> = {};

  if (settings.model && settings.model !== config.model) {
    config.model = settings.model;
    saveConfig(config);
  } else if (!settings.model && config.model && config.model !== FALLBACK_MODEL) {
    upload.model = config.model;
  }

  const local = config.effort ?? {};
  for (const [model, level] of Object.entries(settings.efforts)) {
    if (local[model] !== level) saveEffort(config, model, level);
  }
  const localOnly: Record<string, string> = {};
  for (const [model, level] of Object.entries(local)) {
    if (!(model in settings.efforts)) localOnly[model] = level;
  }
  if (Object.keys(localOnly).length) upload.efforts = localOnly;

  if (Object.keys(upload).length) await client.saveSettings(upload).catch(() => null);
  return { name: settings.name, instructions: settings.instructions, sponsorLine: settings.sponsorLine };
}

/** The sentence a turn's system prompt carries for the account's preferences, or "". */
export function preferencesInstruction(prefs: TurnPreferences | undefined): string {
  if (!prefs) return "";
  const parts: string[] = [];
  if (prefs.name) parts.push(`The person's name is ${prefs.name}.`);
  if (prefs.instructions) parts.push(`What the person wants you to keep in mind in every answer:\n${prefs.instructions}`);
  return parts.join("\n\n");
}

/** The sponsored line's config preference, with the account's "off" over it. */
export function sponsorPreference(config: CliConfig, prefs: TurnPreferences | undefined): boolean | undefined {
  return prefs?.sponsorLine === false ? false : config.sponsor;
}
