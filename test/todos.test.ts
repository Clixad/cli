/**
 * The task list.
 *
 * Two audiences, one artefact: the string the tool returns is both what the
 * model reads back and what the user sees in the transcript, so the tests are
 * about that string rather than about the array behind it.
 */
import { describe, expect, it } from "vitest";
import { MAX_TODOS, TodoError, TodoList, parseTodos, renderTodos, todoResult, todoSummary } from "../src/todos.ts";

const todo = (content: string, status = "pending") => ({ content, status });

describe("parseTodos", () => {
  it("accepts a well-formed list and normalises the whitespace", () => {
    const items = parseTodos([todo("  read   the config  "), todo("write tests", "completed")]);
    expect(items).toEqual([
      { content: "read the config", status: "pending" },
      { content: "write tests", status: "completed" },
    ]);
  });

  it("refuses a status it would have to guess at", () => {
    // Rendering a misspelled status as "pending" would silently un-finish
    // completed work, which is worse than the round-trip a refusal costs.
    expect(() => parseTodos([todo("x", "done")])).toThrow(TodoError);
    expect(() => parseTodos([todo("x", "done")])).toThrow(/pending, in_progress, completed/);
  });

  it("refuses items with no content, and anything that is not a list", () => {
    expect(() => parseTodos([{ status: "pending" }])).toThrow(/no content/);
    expect(() => parseTodos([todo("   ")])).toThrow(/no content/);
    expect(() => parseTodos("not a list")).toThrow(/must be an array/);
    expect(() => parseTodos([null])).toThrow(/not an object/);
  });

  it("caps the length of the list and of one item", () => {
    expect(() => parseTodos(Array.from({ length: MAX_TODOS + 1 }, () => todo("x")))).toThrow(/too many/);
    expect(parseTodos([todo("y".repeat(500))])[0]!.content.length).toBe(200);
  });

  it("accepts an empty list, which is how a finished plan is cleared", () => {
    expect(parseTodos([])).toEqual([]);
  });
});

describe("rendering", () => {
  it("shows what is done, what is running and what is left", () => {
    const items = parseTodos([
      todo("read the config", "completed"),
      todo("add the flag", "in_progress"),
      todo("update the docs"),
    ]);
    const text = renderTodos(items);
    expect(text).toContain("✔ read the config");
    expect(text).toContain("▶ add the flag");
    expect(text).toContain("○ update the docs");
    expect(text).toContain("1/3 done · now: add the flag");
  });

  it("summarises a list with nothing in progress without inventing one", () => {
    expect(todoSummary(parseTodos([todo("a", "completed"), todo("b")]))).toBe("1/2 done");
  });

  it("says so when the list is empty", () => {
    expect(renderTodos([])).toBe("(the task list is empty)");
  });

  it("repeats the whole list back to the model, not just an acknowledgement", () => {
    // The alternative — "ok, 3 todos" — leaves the only copy of the plan in a
    // tool *call* several rounds back, which is what compaction drops first.
    const result = todoResult(parseTodos([todo("first", "in_progress"), todo("second")]));
    expect(result).toContain("first");
    expect(result).toContain("second");
  });

  it("warns when more than one item claims to be in progress", () => {
    const result = todoResult(parseTodos([todo("a", "in_progress"), todo("b", "in_progress")]));
    expect(result).toContain("Work on one at a time");
  });
});

describe("TodoList", () => {
  it("replaces wholesale and counts what is finished", () => {
    const list = new TodoList();
    expect(list.done).toBe(0);
    list.replace(parseTodos([todo("a", "completed"), todo("b")]));
    expect(list.done).toBe(1);
    list.replace(parseTodos([todo("c")]));
    expect(list.items).toHaveLength(1);
  });
});
