/**
 * How the TUI, and with it ink and React, is loaded.
 *
 * A session crashed with "JavaScript heap out of memory" at about 4 GB after
 * 13.7 hours. Measured with the real `App` against a fake terminal, streaming
 * at the speed `DELTA_FLUSH_MS` paints, the heap grew by about 1.75 MB per
 * answer and never came back. Two things held it, and both are fixed here,
 * because both are decided at the moment ink and React are first evaluated:
 *
 *   - **React's development build.** React and react-reconciler pick their
 *     build from `NODE_ENV` when they are loaded, and nothing sets it in
 *     somebody's shell, so every installed CLI ran the development builds.
 *     Those call `performance.measure()` for every render whose props changed,
 *     with the changed props attached, and Node keeps every measure until
 *     somebody clears them. Here that is the streamed answer each time it is
 *     painted and the clock under it every 120 ms. With the production build
 *     the growth fell to about 0.6 MB per answer.
 *   - **ink 7's text caches.** `measure-text.js` and `wrap-text.js` memoise by
 *     the text itself in module-level maps that are never cleared, so every
 *     frame of a streamed answer, a screenful long, is kept twice over. ink
 *     8.0.0 bounds both with an LRU; ink 8 also changes how a frame is cleared,
 *     which the frame rules in `app.tsx` and their tests are measured against,
 *     so it is an upgrade of its own rather than part of this.
 *
 * Neither may leak into anything else. `NODE_ENV` is set only while the import
 * runs: `run_command`, background shells and MCP servers inherit this process's
 * environment, and `npm install` under `NODE_ENV=production` skips
 * devDependencies. And the cache patch rewrites exactly the two declarations it
 * names, in exactly two files, and leaves a source it does not recognise alone.
 *
 * This only works because the import is the first thing to load ink or React,
 * which `build.mjs` keeps true by splitting the bundle: an import of a package
 * in a bundled module is hoisted to the top of its file and evaluated before
 * any code in it runs.
 */
import * as nodeModule from "node:module";

/**
 * How many texts each of ink's two caches keeps.
 *
 * A frame here has well under a hundred text nodes, so this is room for every
 * one of them plus the last frames' worth of a changing answer. ink 8 keeps
 * 4,096; this is smaller because the node that changes is a streamed answer up
 * to a screen long, kept as text and as wrapped text, and a quarter of the
 * entries still never re-measures a node that is on screen.
 */
export const INK_TEXT_CACHE_LIMIT = 1024;

/** A Map that forgets the least recently used entry past its limit. */
export class BoundedCache<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    if (super.has(key)) super.delete(key);
    else if (this.size >= this.limit) super.delete(this.keys().next().value as K);
    return super.set(key, value);
  }
}

/** Where the patched ink source finds its cache; a symbol, so nothing else collides with it. */
const CACHE_FACTORY = Symbol.for("clixad.inkTextCache");
const CACHE_EXPR = `(globalThis[Symbol.for("clixad.inkTextCache")]?.() ?? new Map())`;

/**
 * The caches ink has made through the factory, for a test to measure. There
 * are exactly two in a session, one per patched file.
 */
const created: BoundedCache<unknown, unknown>[] = [];
export function inkTextCaches(): readonly ReadonlyMap<unknown, unknown>[] {
  return created;
}

/** Each patched file, with the exact text it must contain and what replaces it. */
const PATCHES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "/ink/build/measure-text.js": [["const cache = new Map();", `const cache = ${CACHE_EXPR};`]],
  "/ink/build/wrap-text.js": [
    ["const cache = {};", `const cache = ${CACHE_EXPR};`],
    ["const cachedText = cache[cacheKey];", "const cachedText = cache.get(cacheKey);"],
    ["cache[cacheKey] = wrappedText;", "cache.set(cacheKey, wrappedText);"],
  ],
};

/**
 * ink's source with its cache bounded, or `undefined` to leave it as it is.
 *
 * All of a file's replacements must match exactly once, or none is made: half
 * a patch on a version that moved the code would be a broken module rather
 * than an unbounded cache. `ink-load.test.ts` holds the installed ink to these
 * strings, so an upgrade that moves them fails a test instead of the bound.
 */
export function boundInkSource(url: string, source: string): string | undefined {
  const file = Object.keys(PATCHES).find((suffix) => url.endsWith(suffix));
  if (!file) return undefined;
  let out = source;
  for (const [from, to] of PATCHES[file]!) {
    if (out.split(from).length !== 2) return undefined;
    out = out.replace(from, to);
  }
  return out;
}

let hooked = false;

/**
 * Put the bound on ink's caches for every load of ink from now on.
 *
 * `module.registerHooks` runs in this thread and before the module is
 * evaluated, so the patched text is what ink runs. It arrived in Node 22.15;
 * on an older 22 this is a no-op and the caches grow as they always did,
 * which is the one thing left unfixed there.
 */
export function boundInkCaches(): boolean {
  if (hooked) return true;
  const registerHooks = (nodeModule as { registerHooks?: typeof nodeModule.registerHooks }).registerHooks;
  if (typeof registerHooks !== "function") return false;
  (globalThis as Record<symbol, unknown>)[CACHE_FACTORY] = () => {
    const cache = new BoundedCache<unknown, unknown>(INK_TEXT_CACHE_LIMIT);
    created.push(cache);
    return cache;
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.includes("/ink/build/") || result.source == null) return result;
      const text =
        typeof result.source === "string" ? result.source : Buffer.from(result.source as Uint8Array).toString("utf8");
      const patched = boundInkSource(url, text);
      return patched === undefined ? result : { ...result, source: patched };
    },
  });
  hooked = true;
  return true;
}

/**
 * Run `load` with React's production build, and give the environment back.
 *
 * Whatever `NODE_ENV` the user had is restored as soon as the import settles,
 * success or not, so nothing started later inherits a value they never set.
 */
export async function withProductionReact<T>(load: () => Promise<T>): Promise<T> {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await load();
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/** The TUI, loaded the way a session of any length needs it. */
export function loadTui(): Promise<typeof import("./index.tsx")> {
  boundInkCaches();
  return withProductionReact(() => import("./index.tsx"));
}
