/**
 * The account's preferences in the CLI (`preferences.ts`): what the account
 * holds wins when the REPL opens, what only this machine knows goes up once,
 * the sponsored line's "off" holds for the session without being saved, and
 * the name and instructions reach the model.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccountSettings } from "../src/client.ts";

// CONFIG_PATH is homedir() joined at module load, config.test.ts's reason.
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "adg-prefs-"));
  hoisted.home = home;
  vi.resetModules();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const file = () => join(home, ".clixad", "config.json");
function write(stored: Record<string, unknown>) {
  mkdirSync(join(home, ".clixad"), { recursive: true });
  writeFileSync(file(), JSON.stringify({ gatewayUrl: "https://gw.test", token: "adg_x", ...stored }), "utf8");
}
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;

async function load() {
  const config = await import("../src/config.ts");
  const prefs = await import("../src/preferences.ts");
  return { config, prefs };
}

const settings = (over: Partial<ReturnType<typeof parseAccountSettings> & object> = {}) => ({
  model: null,
  efforts: {},
  name: null,
  instructions: null,
  sponsorLine: null,
  ...over,
});

describe("syncing preferences when the REPL opens", () => {
  it("takes the account's model and efforts over the local ones", async () => {
    write({ model: "gpt-5-nano", effort: { "kimi-k3": "low" } });
    const { config, prefs } = await load();
    const c = config.loadConfig();
    const sent: unknown[] = [];
    await prefs.syncPreferences({ saveSettings: async (x) => sent.push(x) }, c, settings({ model: "kimi-k3", efforts: { "kimi-k3": "high" } }));
    expect(c.model).toBe("kimi-k3");
    expect(stored()).toMatchObject({ model: "kimi-k3", effort: { "kimi-k3": "high" } });
    expect(sent).toEqual([]);
  });

  it("sends what only this machine knows, once", async () => {
    write({ model: "claude-haiku-4.5", effort: { "gpt-6-sol": "high" } });
    const { config, prefs } = await load();
    const sent: unknown[] = [];
    await prefs.syncPreferences({ saveSettings: async (x) => sent.push(x) }, config.loadConfig(), settings());
    expect(sent).toEqual([{ model: "claude-haiku-4.5", efforts: { "gpt-6-sol": "high" } }]);
  });

  it("does not send the fallback model nobody chose", async () => {
    write({});
    const { config, prefs } = await load();
    const sent: unknown[] = [];
    await prefs.syncPreferences({ saveSettings: async (x) => sent.push(x) }, config.loadConfig(), settings());
    expect(sent).toEqual([]);
  });

  it("leaves everything as it was when the account cannot be read", async () => {
    write({ model: "gpt-5-nano" });
    const { config, prefs } = await load();
    const c = config.loadConfig();
    const out = await prefs.syncPreferences({ saveSettings: async () => { throw new Error("down"); } }, c, null);
    expect(out).toEqual({ name: null, instructions: null, sponsorLine: null });
    expect(c.model).toBe("gpt-5-nano");
  });

  it("never fails because the upload did", async () => {
    write({ model: "claude-haiku-4.5" });
    const { config, prefs } = await load();
    await expect(
      prefs.syncPreferences({ saveSettings: async () => { throw new Error("down"); } }, config.loadConfig(), settings()),
    ).resolves.toMatchObject({ name: null });
  });
});

describe("what a turn is told, and the sponsored line", () => {
  it("says the name and the instructions, or nothing", async () => {
    const { prefs } = await load();
    expect(prefs.preferencesInstruction(undefined)).toBe("");
    expect(prefs.preferencesInstruction({ name: null, instructions: null, sponsorLine: null })).toBe("");
    expect(prefs.preferencesInstruction({ name: "Flo", instructions: "Answer in German.", sponsorLine: null })).toBe(
      "The person's name is Flo.\n\nWhat the person wants you to keep in mind in every answer:\nAnswer in German.",
    );
  });

  it("turns the sponsored line off for the session without saving it", async () => {
    write({});
    const { config, prefs } = await load();
    const c = config.loadConfig();
    expect(prefs.sponsorPreference(c, { name: null, instructions: null, sponsorLine: false })).toBe(false);
    expect(prefs.sponsorPreference(c, { name: null, instructions: null, sponsorLine: null })).toBe(c.sponsor);
    expect(stored().sponsor).toBeUndefined();
  });
});

describe("reading the settings body", () => {
  it("takes what is well formed and drops the rest", () => {
    expect(
      parseAccountSettings({
        model: "kimi-k3",
        efforts: { "kimi-k3": "high", bad: 3 },
        name: "  ",
        instructions: "Be brief.",
        sponsor_line: false,
        limits: {},
      }),
    ).toEqual({ model: "kimi-k3", efforts: { "kimi-k3": "high" }, name: null, instructions: "Be brief.", sponsorLine: false });
    expect(parseAccountSettings(null)).toBeNull();
    expect(parseAccountSettings({ sponsor_line: "no" })?.sponsorLine).toBeNull();
  });
});
