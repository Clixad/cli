/**
 * Where things are, found by looking rather than by assuming one layout.
 *
 * The same tests run in two places: the monorepo, where npm hoists this
 * package's dependencies to the repository root, and the public mirror, where
 * this package is the root and they sit in its own `node_modules`. A path
 * spelled from the repository root works in the first and not the second.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root: the directory holding its package.json. */
export const CLI_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The nearest `node_modules` at or above this package that holds `name`. */
export function nodeModulesWith(name: string): string {
  for (let dir = CLI_DIR; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, name, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`no node_modules at or above ${CLI_DIR} holds ${name}`);
  }
}

/** The `tsx` command npm linked for this checkout. */
export const TSX = join(nodeModulesWith("tsx"), ".bin", "tsx");
