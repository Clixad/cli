/**
 * Bundle the Clixad CLI for `npx clixad` / a global install: our own source
 * is bundled with a shebang, while npm dependencies (ink, react)
 * stay external and are installed normally from package.json.
 *
 * The bundle is split at its dynamic imports, and that is load-bearing. An
 * import of a package is hoisted to the top of the file it lands in and
 * evaluated before any code there runs, so in one file ink and React loaded
 * before `main()` did: for every command, `clixad --version` included, and
 * before `loadTui` (src/tui/load.ts) could choose React's production build or
 * bound ink's text caches. Split, they live in the TUI's own chunk and load
 * when the REPL opens.
 *
 * `dist/clixad.mjs` stays the entry `bin` points at, and the chunks sit beside
 * it in `dist/`: `version.ts` finds package.json one directory up from
 * whichever chunk it ends up in.
 *
 * The entry is written executable, because nothing else reliably makes it so.
 * esbuild writes every file 0644. A package manager chmods a bin when it links
 * one and never again, so a build in a checkout whose bin was already linked
 * (the workspace's node_modules/.bin, `npm link -w apps/cli`) left `clixad`
 * answering "permission denied". And `npm pack` marks a bin executable only at
 * the top of a package (pacote's is-package-bin.js drops the first path
 * segment, so `dist/clixad.mjs` never matches), so every tarball we published
 * carried 0644, and anything that installs one without a chmod of its own got
 * the same. A packer records the mode the file has on disk.
 *
 * Run: npm run build  (from apps/cli, or `npm run build --workspaces`).
 * `node build.mjs <dir>` builds into another directory, for a test.
 */
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const outdir = process.argv[2] ?? "dist";
// `files` publishes all of dist, so a chunk left from an earlier build would ship.
rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: { clixad: "src/main.ts" },
  outdir,
  outExtension: { ".js": ".mjs" },
  splitting: true,
  chunkNames: "[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  jsx: "automatic", // .tsx via the React 19 automatic runtime
  packages: "external", // ink/react resolved at runtime from node_modules
});

chmodSync(join(outdir, "clixad.mjs"), 0o755);

console.log(`built ${outdir}/clixad.mjs`);
