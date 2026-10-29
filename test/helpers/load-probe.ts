/**
 * Loads React and ink in a fresh process and reports what a long session would
 * keep. Run by `tui-load.test.ts` as a child: a vitest worker has already
 * loaded both, and which build React is decides itself only once, on load.
 *
 * `fixed` loads them the way `loadTui` does; anything else, the way the CLI
 * did before. Then it repaints one changing text 1,500 times, which is what a
 * streamed answer does to the frame, and prints one line of JSON.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { boundInkCaches, inkTextCaches, withProductionReact } from "../../src/tui/load.ts";

const fixed = process.argv[2] === "fixed";
const nodeEnvBefore = process.env.NODE_ENV ?? null;
if (fixed) boundInkCaches();
const load = () => Promise.all([import("react"), import("ink")]);
const [react, ink] = fixed ? await withProductionReact(load) : await load();
const React = react.default;

const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });
const stdin = Object.assign(new EventEmitter(), {
  isTTY: false,
  setEncoding() {},
  setRawMode() {},
  resume() {},
  pause() {},
  ref() {},
  unref() {},
  read: () => null,
});
const frame = (i: number) =>
  React.createElement(ink.Box, null, React.createElement(ink.Text, null, `answer so far ${i}: ${"word ".repeat(i % 60)}`));
const app = ink.render(frame(0), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  patchConsole: false,
  exitOnCtrlC: false,
});
for (let i = 1; i <= 1500; i++) {
  app.rerender(frame(i));
  await new Promise((resolve) => setImmediate(resolve));
}
app.unmount();

// Only what ran. Importing CommonJS from ESM makes Node read both branches of
// React's `index.js` to find its exports, and leaves an unexecuted cache entry
// for each, so the cache alone lists both builds whichever one is in use.
const builds = Object.entries(createRequire(import.meta.url).cache)
  .filter(([, mod]) => mod?.loaded)
  .map(([path]) => path.split(/[\\/]/).pop()!)
  .filter((name) => /^react(-reconciler)?\.(production|development)\.js$/.test(name))
  .sort();
console.log(
  JSON.stringify({
    measures: performance.getEntriesByType("measure").length,
    caches: inkTextCaches().map((cache) => cache.size),
    builds,
    nodeEnvBefore,
    nodeEnvAfter: process.env.NODE_ENV ?? null,
  }),
);
process.exit(0);
