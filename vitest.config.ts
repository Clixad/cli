/**
 * The CLI's tests on their own: `npm test` here, and in the public mirror.
 *
 * The monorepo's root run does not read this file. It has its own config, which
 * globs every workspace and runs `test/setup-home.ts` through the root setup,
 * so both runs isolate the home directory the same way.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.{ts,tsx,mts}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./test/setup-home.ts"],
  },
});
