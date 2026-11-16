/**
 * `/undo`: take back the last message you typed, so it can be edited and sent
 * again.
 *
 * The conversation is cut just before that message, which is the one place it
 * is sure to be well formed: the message followed a finished round, so nothing
 * before it waits for a tool result. The cut conversation replaces the session
 * file at once, so `--continue` and `/resume` pick up exactly what the model
 * will see next, and nothing of the undone turn comes back with them.
 *
 * Two things it does not take back, and says so every time, because both are
 * real and neither can be reached from here: the credits the turn used (the
 * gateway charged them when the calls ran), and whatever the agent did on disk
 * (an edited file stays edited, a command that ran has run). The notice names
 * the files and counts the commands, read from the undone tool calls that
 * succeeded, so nobody has to guess what is still there.
 *
 * Pure: the REPL does the drawing, the editor and the file.
 */
import { messageText, type ChatMessage } from "./client.ts";
import { failed, isSummary, parseToolArgs, shellCommand, typedText } from "./tui/replay.ts";

export interface UndoPlan {
  /** The conversation before the message, which is what the model sees next. */
  kept: ChatMessage[];
  /** What was typed, without the files an `@path` attached, for the input box. */
  text: string;
  /** Files the agent wrote or edited after it, in the order first touched. */
  files: string[];
  /** Commands that ran after it: the agent's, and `!command`s typed after it. */
  commands: number;
  /** MCP tool calls that ran after it, which may have changed something elsewhere. */
  toolCalls: number;
}

export type UndoResult = { ok: true; plan: UndoPlan } | { ok: false; reason: "empty" | "summarised" };

const WRITES = new Set(["write_file", "edit_file"]);
const COMMANDS = new Set(["run_command", "kill_shell"]);

export function planUndo(messages: readonly ChatMessage[]): UndoResult {
  let at = -1;
  let summarised = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = messageText(m);
    if (isSummary(text)) {
      summarised = true;
      break;
    }
    if (typedText(text) !== undefined) {
      at = i;
      break;
    }
  }
  if (at < 0) return { ok: false, reason: summarised ? "summarised" : "empty" };

  const undone = messages.slice(at);
  const results = new Map<string, string>();
  for (const m of undone) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, messageText(m));

  const files: string[] = [];
  let commands = 0;
  let toolCalls = 0;
  for (const m of undone.slice(1)) {
    if (m.role === "user" && shellCommand(messageText(m)) !== undefined) commands++;
    if (m.role !== "assistant") continue;
    for (const call of m.tool_calls ?? []) {
      const result = results.get(call.id);
      // A call that failed, was refused or never finished did nothing.
      if (result === undefined || failed(result)) continue;
      const name = call.function.name;
      if (WRITES.has(name)) {
        const path = parseToolArgs(call.function.arguments).path;
        if (typeof path === "string" && path && !files.includes(path)) files.push(path);
      } else if (COMMANDS.has(name)) commands++;
      else if (name.startsWith("mcp__")) toolCalls++;
    }
  }
  return {
    ok: true,
    plan: { kept: messages.slice(0, at), text: typedText(messageText(messages[at]!))!, files, commands, toolCalls },
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What `/undo` says, as two lines: what happened, and what did not. The second
 * is the one that matters and is said whether or not anything changed, since
 * "nothing on disk changed" is worth knowing too.
 */
export function undoLines(plan: UndoPlan): { done: string; kept: string } {
  const done =
    "Took back your last message. It is in the input box to edit and send again; " +
    "the model no longer sees it or anything after it.";
  const what: string[] = [];
  if (plan.files.length) {
    const shown = plan.files.slice(0, 5).join(", ");
    what.push(`edited ${shown}${plan.files.length > 5 ? ` and ${plan.files.length - 5} more` : ""}`);
  }
  if (plan.commands) what.push(`ran ${count(plan.commands, "command", "commands")}`);
  if (plan.toolCalls) what.push(`made ${count(plan.toolCalls, "MCP tool call", "MCP tool calls")}`);
  const kept = what.length
    ? `Not undone: the credits it used, and the changes on disk. The agent ${what.join(", ")}; those stay as they are.`
    : "Not undone: the credits it used. The agent changed no files for it.";
  return { done, kept };
}

/** Why there is nothing to take back. */
export function nothingToUndo(reason: "empty" | "summarised"): string {
  return reason === "summarised"
    ? "Nothing to undo: your earlier messages were summarised to save context, and the summary cannot be taken apart."
    : "Nothing to undo: you have not sent a message in this conversation yet.";
}

/** A message the conversation never kept (refused, or failed before any work) is simply given back. */
export const UNSENT_UNDO =
  "Your last message was refused or failed before the agent did anything, so it is not in the conversation " +
  "and there was nothing to take back. It is in the input box again.";
