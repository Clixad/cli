/**
 * "Clixad Code" — run the Kimi CLI (MoonshotAI, Apache-2.0) as Clixad's
 * full coding agent, pointed at the Clixad metering gateway.
 *
 * Kimi CLI already speaks the OpenAI Chat Completions dialect (its `kosong`
 * client has an `openai_legacy` provider), which is exactly what our gateway
 * exposes. So "adapting it for Clixad" is a thin layer, not a fork of its
 * internals: we generate a Kimi config whose sole provider points at the gateway
 * (`{gatewayUrl}/v1`) authenticated with the user's Clixad token, then launch
 * `kimi` with it. Credits are metered/debited by the gateway exactly as for our
 * own CLI — the coding agent, tools, and TUI all come from Kimi CLI.
 *
 * We do NOT vendor Kimi CLI's source; the user installs it once
 * (`uv tool install kimi-cli` / `pipx install kimi-cli`) and this launcher
 * drives it. Set CLIXAD_KIMI_BIN to override the executable name/path.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig } from "./config.ts";

/**
 * Context window (tokens) per Clixad model id. Mirrors the window the gateway
 * serves as `context_window` on /v1/models; the CLI keeps its own copy because
 * it ships standalone via npx and may import nothing but npm packages (see
 * build.mjs). Used by Kimi's config and as the REPL's compaction fallback. For
 * Claude Haiku 5.5 and GPT-6 Sol that is less than the model takes, because
 * their providers bill a longer prompt above the catalogue price and the
 * gateway refuses one that could reach it; a test that can see both holds the
 * copy to the gateway's figure.
 */
export const CONTEXT_TOKENS: Record<string, number> = {
  "gpt-5-nano": 400_000,
  "gemini-2.5-flash-lite": 1_048_576,
  "claude-haiku-5.5": 24_000,
  "deepseek-v4-flash": 1_048_576,
  "gemini-3.5-flash-lite": 1_048_576,
  "kimi-k2.5": 262_144,
  "gemini-3.8-flash": 1_048_576,
  "kimi-k2.7-code": 262_144,
  "claude-sonnet-5.5": 1_000_000,
  "gpt-6-sol": 78_000,
  "kimi-k3": 1_048_576,
  "claude-opus-5.5": 1_000_000,
  "claude-fable-5.1": 1_000_000,
  // Retired on 2026-09-27 and served by their successor (the gateway's
  // `retired_models`), so an install still configured with one compacts
  // against the window of the model that actually answers.
  "gemini-3.1-flash-lite": 1_048_576,
  // Served by Claude Haiku 5.5 since 2026-10-12, when Kimi K2.5 left the free set.
  "kimi-k2": 24_000,
  "gemini-3.6-flash": 1_048_576,
  "gpt-5.2": 78_000,
  "claude-opus-5": 1_000_000,
  "gpt-5.5": 78_000,
  "gpt-5.2-pro": 78_000,
  // Retired on 2026-09-29 for Claude Sonnet 5.5, same window.
  "claude-sonnet-5": 1_000_000,
  // Retired on 2026-10-12 for Claude Haiku 5.5.
  "claude-haiku-4.5": 24_000,
};
export const DEFAULT_CONTEXT_TOKENS = 256_000;

export function contextTokensFor(modelId: string): number {
  return CONTEXT_TOKENS[modelId] ?? DEFAULT_CONTEXT_TOKENS;
}

/** TOML basic-string quoting for the small set of values we emit. */
function toml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface KimiConfigInput {
  gatewayUrl: string;
  token: string;
  modelId: string;
}

/**
 * Build a Kimi CLI config (TOML) with a single Clixad provider. Pure and
 * deterministic so it can be unit-tested. `base_url` includes `/v1` because the
 * OpenAI-compatible client appends `/chat/completions`, matching our gateway route.
 */
export function buildKimiConfig({ gatewayUrl, token, modelId }: KimiConfigInput): string {
  const baseUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1`;
  const context = contextTokensFor(modelId);
  return [
    "# Clixad Code — auto-generated. Points Kimi CLI at the Clixad gateway",
    "# (OpenAI-compatible). Regenerated on every `clixad code` run.",
    `default_model = ${toml(modelId)}`,
    "default_yolo = false",
    "telemetry = false",
    "",
    "[providers.clixad]",
    'type = "openai_legacy"',
    `base_url = ${toml(baseUrl)}`,
    `api_key = ${toml(token)}`,
    "",
    `[models.${toml(modelId)}]`,
    'provider = "clixad"',
    `model = ${toml(modelId)}`,
    `max_context_size = ${context}`,
    "",
  ].join("\n");
}

/** Where the generated Kimi config lives (next to the Clixad CLI config). */
export function kimiConfigPath(): string {
  return join(homedir(), ".clixad", "kimi.config.toml");
}

const INSTALL_HELP = `Kimi CLI is not installed (or not on PATH).

Clixad Code runs the open-source Kimi CLI (MoonshotAI, Apache-2.0) against your
Clixad gateway. Install it once, then re-run \`clixad code\`:

  uv tool install kimi-cli        # recommended (https://docs.astral.sh/uv/)
  # or:
  pipx install kimi-cli

If it's installed under a different name/path, set CLIXAD_KIMI_BIN.`;

export interface RunKimiOptions {
  /** Extra args appended verbatim after the managed ones (power users). */
  passthrough?: string[];
}

/**
 * Generate the config and launch Kimi CLI, inheriting the terminal so its TUI
 * works. `task`, when given, seeds the agent's first prompt (`-p`). Resolves
 * with the child's exit code (or a non-zero code if the binary is missing).
 */
export function runKimiCode(
  config: CliConfig,
  task: string | undefined,
  opts: RunKimiOptions = {},
): Promise<number> {
  if (!config.token) {
    console.log("Not logged in. Run `clixad login` first.");
    return Promise.resolve(1);
  }

  const path = kimiConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildKimiConfig({ gatewayUrl: config.gatewayUrl, token: config.token, modelId: config.model }), "utf8");

  const bin = process.env.CLIXAD_KIMI_BIN || "kimi";
  if (!binExists(bin)) {
    console.log("\n" + INSTALL_HELP);
    return Promise.resolve(127);
  }

  const args = ["--config-file", path];
  if (task) args.push("-p", task);
  if (opts.passthrough?.length) args.push(...opts.passthrough);

  // Env override is a belt-and-suspenders duplicate of the file's provider so
  // Kimi's `openai_legacy` env path also resolves to the gateway + token.
  const env = {
    ...process.env,
    OPENAI_BASE_URL: `${config.gatewayUrl.replace(/\/+$/, "")}/v1`,
    OPENAI_API_KEY: config.token,
  };

  return new Promise((resolve) => {
    // On Windows, PATH shims (kimi.cmd/kimi.exe) resolve only via the shell.
    const child =
      process.platform === "win32"
        ? spawn([bin, ...args].map(quoteWin).join(" "), { stdio: "inherit", env, shell: true })
        : spawn(bin, args, { stdio: "inherit", env });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") console.log("\n" + INSTALL_HELP);
      else console.error(`failed to launch Kimi CLI: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function quoteWin(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** True if `bin` is runnable — an existing path, or resolvable on PATH. */
function binExists(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) {
    return existsSync(bin) || existsSync(`${bin}.exe`) || existsSync(`${bin}.cmd`);
  }
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [bin], { stdio: "ignore" })
      : spawnSync("sh", ["-c", `command -v "${bin}"`], { stdio: "ignore" });
  return probe.status === 0;
}
