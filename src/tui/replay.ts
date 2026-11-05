/**
 * A saved conversation, back into the rows the transcript draws.
 *
 * `/resume` and `clixad --continue` used to load a conversation into the
 * model's context and print one line about it: an id, a message count and the
 * first message. Everything the conversation had said stayed off the screen, so
 * a resumed session looked like an empty one and read as if nothing had been
 * restored. This turns the stored messages into the same rows a live turn
 * commits: what was typed, each answer, and each tool call with its result.
 *
 * Pure, so the shape is tested without a terminal. The REPL draws the items
 * with the functions that draw a live turn (`commitTool` for a tool), which
 * keeps a resumed row and a live one the same row.
 *
 * What a session file does not keep is not invented: an edit's diff (shown
 * live through a side channel, never in a message), the credits a turn cost,
 * and why a call was refused beyond what the model was told.
 */
import { INTERRUPTED_CALL } from "../agent.ts";
import { messageText, type ChatMessage } from "../client.ts";
import { SUMMARY_ACK, SUMMARY_LEAD } from "../compact.ts";
import { MENTIONS_HEADING } from "../mentions.ts";

export type ReplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; result: string; ok: boolean }
  | { kind: "notice"; text: string };

/** How the REPL tells the model about a `!command` the user ran. */
export function shellNote(command: string, output: string): string {
  return `I ran \`${command}\` in the workspace myself. Its output:\n\n${output}`;
}

const SHELL_NOTE = /^I ran `([^\n]*)` in the workspace myself\. Its output:\n\n([\s\S]*)$/;
/** The message `runAgent` adds after a tool read an image; the read is already a row. */
const IMAGE_NOTE = /^Here (?:is the image|are the images) you read \(/;

/** A tool result the agent loop wrote for a call that did not succeed. */
function failed(result: string): boolean {
  return result.startsWith("error: ") || result === INTERRUPTED_CALL;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The rows a stored conversation draws, in order. The system prompt is never stored. */
export function replayItems(messages: readonly ChatMessage[]): ReplayItem[] {
  const answers = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) answers.set(m.tool_call_id, messageText(m));
  }

  const out: ReplayItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = messageText(m);
      if (text.startsWith(SUMMARY_LEAD)) {
        out.push({ kind: "notice", text: "earlier messages were summarised to save context; the summary is what the model has" });
        continue;
      }
      if (IMAGE_NOTE.test(text)) continue;
      const shell = SHELL_NOTE.exec(text);
      if (shell) {
        out.push({ kind: "user", text: `!${shell[1]}` });
        out.push({ kind: "tool", name: "!", args: { command: shell[1] }, result: shell[2] ?? "", ok: true });
        continue;
      }
      // What was typed, without the files an `@path` attached after it.
      const cut = text.indexOf(MENTIONS_HEADING);
      const typed = (cut >= 0 ? text.slice(0, cut) : text).trim();
      if (typed) out.push({ kind: "user", text: typed });
      continue;
    }
    if (m.role === "assistant") {
      const text = messageText(m).trim();
      if (text && text !== SUMMARY_ACK) out.push({ kind: "assistant", text });
      for (const call of m.tool_calls ?? []) {
        const result = answers.get(call.id) ?? INTERRUPTED_CALL;
        out.push({
          kind: "tool",
          name: call.function.name,
          args: parseArgs(call.function.arguments),
          result,
          ok: !failed(result),
        });
      }
    }
    // Tool messages are drawn with the call they answer; system messages are
    // not stored, and one that is would be the prompt, not the conversation.
  }
  return out;
}
