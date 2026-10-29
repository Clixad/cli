/**
 * The permission gate for side-effecting tools. Pure decision logic here; the
 * TUI only renders the question and feeds the answer back.
 *
 * Four modes, cycled with Shift+Tab in the REPL:
 *   normal      ask before every write/command, with "always" remembered for
 *               the rest of the session
 *   acceptEdits file edits go through silently; shell commands still ask
 *   plan        read-only — writes and commands are refused and the refusal is
 *               reported to the model, so it plans instead of acting
 *   auto        nothing is asked: edits go through, commands are sorted by
 *               `auto-mode.ts`, and what it cannot sort is put to a reviewer
 *
 * Auto comes last in the cycle, after plan, as in Claude Code: two presses
 * still land on plan mode, which every published habit and test relies on, and
 * the most permissive mode is never one accidental press away from the default.
 */
import { classifyCommand, sensitiveEdit } from "./auto-mode.ts";

export type PermissionMode = "plan" | "normal" | "acceptEdits" | "auto";

export const MODES: PermissionMode[] = ["normal", "acceptEdits", "plan", "auto"];

export const MODE_LABEL: Record<PermissionMode, string> = {
  plan: "plan mode (read-only)",
  normal: "ask before edits",
  acceptEdits: "auto-accept edits",
  auto: "auto mode",
};

/**
 * How many refusals in a row, and in a session, before auto mode stops
 * refusing on its own and asks instead. Claude Code's numbers. A model that is
 * blocked three times running is usually trying to do something the user did
 * ask for in words the reviewer did not read that way, and the person at the
 * keyboard is the one who can settle it.
 */
export const AUTO_BLOCKS_IN_A_ROW = 3;
export const AUTO_BLOCKS_PER_SESSION = 20;

/**
 * What the model is told about the mode it is running under, appended to the
 * system prompt on **every** turn.
 *
 * It used to be told nothing, while the base prompt said "You can read, search,
 * write and edit files and run shell commands" — which is simply false in plan
 * mode. So the model's first move there was to act, get refused, and spend a
 * second paid round-trip discovering a rule that was known locally before the
 * request was ever sent. Recomputed per turn because shift+tab, `/mode` and an
 * approved plan can all change it mid-conversation.
 */
export function modeInstruction(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return [
        "# Permission mode: plan (read-only)",
        "You cannot write files or run commands right now — those tools are not available to you",
        "in this mode. Investigate with read_file, list_dir, glob and grep, then call exit_plan_mode",
        "with a short plan. The user approves or rejects it there; on approval you carry straight on",
        "in the same turn with the write tools available. Do not ask for approval in prose — the user",
        "has no way to answer that.",
      ].join("\n");
    case "acceptEdits":
      return [
        "# Permission mode: auto-accept edits",
        "File edits apply without asking. Shell commands are still put to the user first.",
      ].join("\n");
    case "auto":
      return [
        "# Permission mode: auto",
        "Edits and commands run without asking the user. Each command is checked first, and one that",
        "looks risky is blocked: deleting more than the task needs, reaching outside the project,",
        "reading credentials, sending data off this machine, downloading and running code, or pushing,",
        "publishing and deploying without being asked. A block means the action did not happen. Do not",
        "retry it or try the same thing another way; take a safer route, or tell the user what they",
        "would need to run themselves (they can type !command at the prompt).",
      ].join("\n");
    default:
      return [
        "# Permission mode: ask before edits",
        "Each write and each shell command is put to the user before it runs. A refusal is their",
        "decision: the call did not happen, so do not report it as done and do not retry it.",
      ].join("\n");
  }
}

export interface PermissionRequest {
  tool: string;
  /** Stable key for "always allow", e.g. `write:src/x.ts` or `run:npm`. */
  signature: string;
  /** One-line header for the dialog, e.g. `edit src/tui/app.tsx`. */
  summary: string;
  /** Rendered diff or the command line — what the user actually approves. */
  preview?: string;
  /**
   * What auto mode judges, carried as data rather than parsed back out of the
   * summary: the whole command line, the workspace-relative path of an edit,
   * and the workspace both are confined to.
   */
  command?: string;
  path?: string;
  root?: string;
}

export type PermissionAnswer = "once" | "always" | "deny";

/**
 * What the user does with a plan the model put up for approval.
 *
 * Plan mode used to have no way out. The refusal told the model to "describe
 * the plan instead and let the user approve it", the model dutifully asked for
 * approval, and there was nothing to approve with: the only exit was shift+tab
 * followed by retyping the whole request — which then landed on a conversation
 * where the model's own announced plan was already sitting, so it followed
 * through on that rather than re-reading the new message. Approving in the same
 * turn removes both halves of that.
 *
 * The two "yes" answers are the two modes worth landing in, named the way the
 * permission dialog already names them, so the same keys mean the same things.
 */
export type PlanDecision = "normal" | "acceptEdits" | "auto" | "keepPlanning";

/**
 * A refusal says two different things to two different audiences.
 *
 * `reason` goes to the model and is an instruction — what not to do next. It
 * used to be the only string, and the TUI rendered it verbatim as a red tool
 * error, so the user read "Do not attempt further writes or commands — describe
 * the plan instead and let the user approve it", which is addressed to the
 * model, looks like a malfunction, and is then repeated back by the model's own
 * next sentence. `notice` is the same event said to the person watching.
 */
export type Verdict =
  | { kind: "allow" }
  /** `note` says why auto mode, which otherwise asks nothing, is asking. */
  | { kind: "ask"; note?: string }
  | { kind: "deny"; reason: string; notice: string }
  /** Auto mode refused this on its own, without a model call. Counts toward the pause. */
  | { kind: "block"; reason: string }
  /** Auto mode cannot tell; the reviewer decides. */
  | { kind: "review" };

export type PermitResult = { allowed: true } | { allowed: false; reason: string; notice: string };

/**
 * What the reviewer made of one action. `unavailable` is not a refusal: the
 * check could not be had (no credits, no network, an answer nobody could
 * read), and the user is asked instead. `stopped` is esc during the review.
 */
export type ReviewVerdict =
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "unavailable"; why: string }
  | { decision: "stopped" };

export type Reviewer = (req: PermissionRequest) => Promise<ReviewVerdict>;

/** What a tool call is asked to do; decides which mode rules apply. */
export function isEdit(tool: string): boolean {
  return tool === "write_file" || tool === "edit_file";
}

export interface PermissionState {
  mode: PermissionMode;
  /** Signatures the user answered "always" to, for this session only. */
  allowed: Set<string>;
  /**
   * Signatures the reviewer allowed this session. Kept apart from `allowed`,
   * which is the user's own word, and consulted only in auto mode: a review is
   * billed, and the same command a minute later is the same command.
   */
  reviewed: Set<string>;
  /** Auto mode's refusals, toward the point where it asks instead (`AUTO_BLOCKS_*`). */
  autoBlocks: { inARow: number; total: number };
}

export function createState(mode: PermissionMode = "normal"): PermissionState {
  return { mode, allowed: new Set(), reviewed: new Set(), autoBlocks: { inARow: 0, total: 0 } };
}

/**
 * The mode shift+tab moves to. Auto mode is left out of the cycle on a model
 * it is not offered on (`autoModeOffered`), the way Claude Code leaves it out
 * where it is unavailable, rather than being a stop that refuses.
 */
export function nextMode(mode: PermissionMode, autoAvailable = true): PermissionMode {
  const modes = autoAvailable ? MODES : MODES.filter((m) => m !== "auto");
  const i = modes.indexOf(mode);
  return modes[(i + 1) % modes.length]!;
}

/**
 * Change the mode. Entering auto mode starts its refusal count again: a pause
 * is about one stretch of work, and switching back in is somebody saying to
 * carry on.
 */
export function switchMode(state: PermissionState, mode: PermissionMode): void {
  if (mode === "auto" && state.mode !== "auto") state.autoBlocks = { inARow: 0, total: 0 };
  state.mode = mode;
}

/** Whether auto mode has refused enough that it now asks rather than refusing again. */
export function autoPaused(state: PermissionState): boolean {
  return state.autoBlocks.inARow >= AUTO_BLOCKS_IN_A_ROW || state.autoBlocks.total >= AUTO_BLOCKS_PER_SESSION;
}

export function decide(state: PermissionState, req: PermissionRequest): Verdict {
  if (state.mode === "plan") {
    return {
      kind: "deny",
      reason:
        `plan mode is on, so ${req.summary} was not executed. ` +
        "Do not attempt further writes or commands — describe the plan instead and let the user approve it.",
      notice: `plan mode — ${req.summary} was not run`,
    };
  }
  if (state.allowed.has(req.signature)) return { kind: "allow" };
  if (state.mode === "acceptEdits" && isEdit(req.tool)) return { kind: "allow" };
  if (state.mode === "auto") return decideAuto(state, req);
  return { kind: "ask" };
}

function decideAuto(state: PermissionState, req: PermissionRequest): Verdict {
  if (isEdit(req.tool)) {
    const why = req.path ? sensitiveEdit(req.path) : null;
    return why ? { kind: "ask", note: `asks before changing ${req.path}: ${why}` } : { kind: "allow" };
  }
  // Only ever one of this session's own background commands.
  if (req.tool === "kill_shell") return { kind: "allow" };
  if (state.reviewed.has(req.signature)) return { kind: "allow" };
  if (req.tool === "run_command" && req.command !== undefined && req.root !== undefined) {
    const verdict = classifyCommand(req.command, req.root);
    if (verdict.kind === "safe") return { kind: "allow" };
    if (verdict.kind === "dangerous") return { kind: "block", reason: verdict.reason };
  }
  // A command it could not sort, and every MCP tool: what those do is not
  // something a list can know.
  return { kind: "review" };
}

/**
 * The gate a tool calls. `review` is how auto mode reaches its reviewer; the
 * agent loop supplies it, because the loop holds the conversation the reviewer
 * reads and the meter its call is billed on. Absent, a review is a question
 * for the user.
 */
export type Permit = (req: PermissionRequest, review?: Reviewer) => Promise<PermitResult>;

/**
 * Wire the decision logic to a UI. `ask` is only called when the mode and the
 * allowlist can't answer on their own; "always" is remembered by signature.
 * `note`, when auto mode passes one, says why it is asking at all.
 */
export function createPermit(
  getState: () => PermissionState,
  ask: (req: PermissionRequest, note?: string) => Promise<PermissionAnswer>,
): Permit {
  return async (req, review) => {
    const state = getState();
    const verdict = decide(state, req);
    if (verdict.kind === "allow") {
      state.autoBlocks.inARow = 0;
      return { allowed: true };
    }
    if (verdict.kind === "deny") return { allowed: false, reason: verdict.reason, notice: verdict.notice };
    if (verdict.kind === "block") return refuse(state, req, verdict.reason, ask);
    if (verdict.kind === "review") {
      if (!review) return askUser(state, req, "nothing is set up to check this action, so it is up to you", ask);
      const result = await review(req);
      switch (result.decision) {
        case "allow":
          state.reviewed.add(req.signature);
          state.autoBlocks.inARow = 0;
          return { allowed: true };
        case "block":
          return refuse(state, req, result.reason, ask);
        case "stopped":
          return {
            allowed: false,
            reason: `${req.summary} was not run: the user stopped the turn. It did not happen.`,
            notice: "stopped",
          };
        default:
          return askUser(state, req, `the safety check could not run (${result.why}), so this one is up to you`, ask);
      }
    }
    return askUser(state, req, verdict.note, ask);
  };
}

/**
 * Auto mode refusing an action, or — once it has refused enough to be paused —
 * putting it to the user with the reason it would have refused.
 */
async function refuse(
  state: PermissionState,
  req: PermissionRequest,
  reason: string,
  ask: (req: PermissionRequest, note?: string) => Promise<PermissionAnswer>,
): Promise<PermitResult> {
  if (autoPaused(state)) {
    const count =
      state.autoBlocks.inARow >= AUTO_BLOCKS_IN_A_ROW
        ? `${state.autoBlocks.inARow} actions in a row`
        : `${state.autoBlocks.total} actions this session`;
    return askUser(state, req, `would block this (${reason}), but it has blocked ${count}, so it asks you instead`, ask);
  }
  state.autoBlocks.inARow++;
  state.autoBlocks.total++;
  return {
    allowed: false,
    reason:
      `auto mode blocked ${req.summary}: ${reason}. It did not happen. Do not retry it or try the same thing ` +
      "another way. Take a safer route, or tell the user what they would need to run themselves " +
      "(they can type !command at the prompt).",
    notice: `auto mode blocked this: ${reason}`,
  };
}

async function askUser(
  state: PermissionState,
  req: PermissionRequest,
  note: string | undefined,
  ask: (req: PermissionRequest, note?: string) => Promise<PermissionAnswer>,
): Promise<PermitResult> {
  const answer = await ask(req, note);
  if (answer === "always") {
    state.allowed.add(req.signature);
    state.autoBlocks.inARow = 0;
    return { allowed: true };
  }
  if (answer === "once") {
    state.autoBlocks.inARow = 0;
    return { allowed: true };
  }
  return {
    allowed: false,
    // Stated as a fact about the world, not just as a verdict. A refused call
    // that reads like a pending one is how the model ends up describing work
    // it never did — or repeating the call on the next message.
    reason:
      `the user denied ${req.summary}. It did not happen. Do not retry it — ` +
      "ask what they would prefer, or carry on with the rest of the task.",
    // The TUI has already said "denied: <summary>" the moment the key was
    // pressed, so repeating it in red under the tool call is noise.
    notice: `denied by you`,
  };
}

/** Non-interactive permit for scripted runs: reads only, everything else denied. */
export const denyAll: Permit = async (req) => ({
  allowed: false,
  reason: `${req.summary} needs approval, but this run is non-interactive (use the REPL to approve it)`,
  notice: `${req.summary} needs approval — this run is non-interactive`,
});
