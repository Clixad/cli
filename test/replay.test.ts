/**
 * A saved conversation drawn back as the rows it was drawn as (`replay.ts`).
 *
 * Reported after 0.0.1-beta.44: resuming showed the session id, the message
 * count and the first message, and nothing of what the conversation had said.
 */
import { describe, expect, it } from "vitest";
import { INTERRUPTED_CALL } from "../src/agent.ts";
import type { ChatMessage } from "../src/client.ts";
import { SUMMARY_ACK, SUMMARY_LEAD } from "../src/compact.ts";
import { MENTIONS_HEADING } from "../src/mentions.ts";
import { replayItems, shellNote } from "../src/tui/replay.ts";

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("replayItems", () => {
  it("draws what was typed, every answer and every tool call with its result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "rename the helper" },
      { role: "assistant", content: "Looking first.", tool_calls: [call("c1", "read_file", { path: "a.ts" })] },
      { role: "tool", tool_call_id: "c1", content: "1\talpha" },
      { role: "assistant", content: null, tool_calls: [call("c2", "edit_file", { path: "a.ts" })] },
      { role: "tool", tool_call_id: "c2", content: "error: old_string not found in a.ts" },
      { role: "assistant", content: "Renamed it." },
    ];
    expect(replayItems(messages)).toEqual([
      { kind: "user", text: "rename the helper" },
      { kind: "assistant", text: "Looking first." },
      { kind: "tool", name: "read_file", args: { path: "a.ts" }, result: "1\talpha", ok: true },
      { kind: "tool", name: "edit_file", args: { path: "a.ts" }, result: "error: old_string not found in a.ts", ok: false },
      { kind: "assistant", text: "Renamed it." },
    ]);
  });

  it("shows a message with @files as it was typed, without the files", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: `explain @a.ts${MENTIONS_HEADING}Their contents are below.\n\n--- a.ts ---\n1\talpha` },
    ];
    expect(replayItems(messages)).toEqual([{ kind: "user", text: "explain @a.ts" }]);
  });

  it("shows a !command as the command and its output", () => {
    const messages: ChatMessage[] = [{ role: "user", content: shellNote("npm test", "12 passed\n") }];
    expect(replayItems(messages)).toEqual([
      { kind: "user", text: "!npm test" },
      { kind: "tool", name: "!", args: { command: "npm test" }, result: "12 passed\n", ok: true },
    ]);
  });

  it("says where earlier messages were summarised, without drawing the summary as typed", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: `${SUMMARY_LEAD}We renamed the helper.` },
      { role: "assistant", content: SUMMARY_ACK },
      { role: "user", content: "and now the tests" },
    ];
    const items = replayItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["notice", "user"]);
    expect(items[1]).toEqual({ kind: "user", text: "and now the tests" });
  });

  it("leaves out the message that carried an image a tool read, and a call a server error left open reads as failed", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "look at the screenshot" },
      { role: "assistant", content: null, tool_calls: [call("c1", "read_file", { path: "shot.png" })] },
      { role: "tool", tool_call_id: "c1", content: "Image shot.png attached." },
      { role: "user", content: [{ type: "text", text: "Here is the image you read (shot.png). Continue the task." }] },
      { role: "assistant", content: null, tool_calls: [call("c2", "list_dir", {})] },
      { role: "tool", tool_call_id: "c2", content: INTERRUPTED_CALL },
    ];
    const items = replayItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "tool"]);
    expect(items[2]).toMatchObject({ name: "list_dir", ok: false });
  });

  it("survives arguments that are not JSON", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: "{oops" } }] },
      { role: "tool", tool_call_id: "c1", content: "error: invalid JSON arguments for glob" },
    ];
    expect(replayItems(messages)).toEqual([
      { kind: "tool", name: "glob", args: {}, result: "error: invalid JSON arguments for glob", ok: false },
    ]);
  });
});
