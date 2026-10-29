/**
 * Runs once per test file, before any test in it: clears every environment
 * variable the CLI reads to decide how it behaves, so a test sees the same
 * world on a laptop, in a terminal inside an editor, and on a CI runner.
 *
 * It exists because that was not true. The sponsored line, its colour and a
 * booked line's link all switch themselves off under `CI`, deliberately, since
 * an advertisement does not belong in a build log. `App` reads `process.env`
 * for those switches, so every test that drew a sponsored row passed on a
 * developer's machine, where `CI` is unset, and failed on GitHub's runner,
 * where it is `true`: 17 of them, the first time the public mirror's sync ran
 * the suite on Linux. A laptop leaks the other way: `TERM_PROGRAM=vscode`
 * makes a booked line a link here and plain text there.
 *
 * A test that is about one of these variables sets it itself, and restores it.
 * `CLI_ENV` is the whole list, and `test/env-isolation.test.ts` fails when the
 * CLI starts reading a variable that is not on it, so a new one cannot bring
 * the same failure back. `NODE_ENV` is deliberately not on it: `tui/load.ts`
 * decides what it is while React loads, and its tests set it themselves; `HOME`
 * and `USERPROFILE` are `setup-home.ts`'s.
 *
 * The monorepo's root setup imports this file and `vitest.config.ts` runs it
 * in the public mirror, so both runs clear the same list.
 */
export const CLI_ENV = [
  // Whether output is decorated at all: colour, the sponsored line, links, the title.
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "FORCE_HYPERLINK",
  "TERM",
  // Which terminal this is, for links and emoji.
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WT_SESSION",
  "VTE_VERSION",
  "KITTY_WINDOW_ID",
  "KONSOLE_VERSION",
  // The CLI's own switches and overrides.
  "CLIXAD_SPONSOR",
  "CLIXAD_TITLE",
  "CLIXAD_GATEWAY_URL",
  "CLIXAD_DASHBOARD_URL",
  "CLIXAD_MCP_TIMEOUT",
  "CLIXAD_KIMI_BIN",
] as const;

for (const name of CLI_ENV) delete process.env[name];
