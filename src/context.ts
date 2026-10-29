/**
 * Project context for the agent — the equivalent of Claude Code's CLAUDE.md.
 * Before the first turn we collect the user's instruction files plus a short
 * environment block (cwd, platform, git branch, top-level layout) and append
 * them to the system prompt, so the model doesn't have to spend a round-trip
 * (= credits) rediscovering where it is.
 *
 * Files are read in increasing specificity; later files win by simply appearing
 * later in the prompt:
 *   ~/.clixad/CLIXAD.md   personal, applies everywhere
 *   ./AGENTS.md               the cross-tool convention, if the repo has one
 *   ./CLIXAD.md             this project, ours
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, parse, resolve } from "node:path";
import { SYSTEM_PROMPT } from "./agent.ts";

const MAX_CONTEXT_FILE_CHARS = 20_000;

export interface ProjectContext {
  systemPrompt: string;
  /** Instruction files that were found, for the "loaded" notice in the TUI. */
  files: string[];
}

export function contextFileCandidates(root: string): string[] {
  return [join(homedir(), ".clixad", "CLIXAD.md"), join(root, "AGENTS.md"), join(root, "CLIXAD.md")];
}

export function collectContext(root: string, base: string = SYSTEM_PROMPT): ProjectContext {
  const parts = [base, environmentBlock(root)];
  const files: string[] = [];

  for (const path of contextFileCandidates(root)) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (!text) continue;
    files.push(path);
    parts.push(
      `# Project instructions (${path.replace(homedir(), "~")})\n` +
        "These come from the user and take precedence over your defaults.\n\n" +
        text.slice(0, MAX_CONTEXT_FILE_CHARS),
    );
  }

  return { systemPrompt: parts.join("\n\n"), files };
}

/** cwd, platform, git state and a shallow listing — cheap orientation. */
function environmentBlock(root: string): string {
  const lines = [
    "# Environment",
    `working directory: ${root}`,
    `platform: ${platform()}`,
    `shell: ${platform() === "win32" ? "cmd/powershell (Windows)" : "sh"}`,
  ];

  const branch = gitBranch(root);
  if (branch) lines.push(`git branch: ${branch}`);

  const top = topLevel(root);
  if (top) lines.push(`top level: ${top}`);

  return lines.join("\n");
}

function gitBranch(root: string): string | undefined {
  try {
    const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    if (res.status !== 0) return undefined;
    return res.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function topLevel(root: string): string | undefined {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return entries.length ? entries.join(" ") : undefined;
  } catch {
    return undefined;
  }
}

/** The task `/init` hands to the agent. */
export const INIT_PROMPT =
  "Create a CLIXAD.md file in the workspace root that tells a future coding " +
  "agent how to work in this project. Explore the repository first (glob, grep, " +
  "read the README and package manifests). Keep it under 60 lines and cover: " +
  "what the project is, the layout, how to build/test/run it, and the " +
  "conventions a newcomer would otherwise get wrong. If CLIXAD.md already " +
  "exists, improve it instead of replacing it wholesale.";

/**
 * The line that suggests `/init`, and where it may be said.
 *
 * `CLIXAD.md` is the one thing that carries a project from one session to the
 * next: it is read into the system prompt on every start, so a session that
 * opens with it does not spend its first paid calls rediscovering the layout.
 * Most people never ran `/init`, because nothing ever said it existed except
 * `/help`. This is the small half of remembering a codebase across sessions;
 * the rest waits for the retention data to say it is worth its token cost.
 */
export const INIT_HINT =
  "No CLIXAD.md in this project yet. /init writes one, and every later session here starts out knowing the layout.";

/** Files whose presence says a directory is a project somebody works in. */
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "Gemfile"];

/**
 * Whether `root` is a project with no instruction file yet.
 *
 * An `AGENTS.md` counts as one: it is loaded the same way, and asking somebody
 * to write a second file saying the same thing is noise. The home directory and
 * a filesystem root never qualify, and neither does a directory with nothing in
 * it that looks like a project, since a `CLIXAD.md` in `~/Downloads` is not
 * something anybody wants suggested to them.
 */
export function shouldSuggestInit(root: string): boolean {
  const dir = resolve(root);
  if (dir === resolve(homedir()) || dir === parse(dir).root) return false;
  if (existsSync(join(dir, "CLIXAD.md")) || existsSync(join(dir, "AGENTS.md"))) return false;
  return PROJECT_MARKERS.some((name) => existsSync(join(dir, name)));
}
