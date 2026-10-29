/**
 * The task list a long turn is worked through.
 *
 * On a five-step task nobody needs one. On the kind of task people actually
 * bring an agent — "add the endpoint, wire it up, write the tests, update the
 * docs" — two things go wrong without it: the person watching cannot tell
 * whether the agent is on step two or has quietly forgotten step four, and the
 * model, twelve tool calls deep in step two, has nothing in front of it that
 * says step four exists.
 *
 * Both are fixed by the same thing, which is why the list is *rewritten whole*
 * on every update rather than patched. The tool result is the rendered list, so
 * the current state is in the conversation at the point the model last touched
 * it, and the same string is what the user reads in the transcript. One
 * artefact, two audiences, no way for them to disagree.
 *
 * It is state, not persistence: the list belongs to the session and dies with
 * it. A todo list that outlived the conversation would be a plan for work
 * nobody remembers agreeing to.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

/** Most items in one list. A plan longer than this is not a plan. */
export const MAX_TODOS = 40;
/** Most characters per item; a todo is a label, not a paragraph. */
export const MAX_TODO_CHARS = 200;

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

const GLYPH: Record<TodoStatus, string> = {
  completed: "✔",
  in_progress: "▶",
  pending: "○",
};

export class TodoError extends Error {}

/** Mutable list, held for the length of a session by whoever runs the agent. */
export class TodoList {
  items: Todo[] = [];

  replace(items: Todo[]): void {
    this.items = items;
  }

  get done(): number {
    return this.items.filter((t) => t.status === "completed").length;
  }
}

/**
 * Validate what the model sent.
 *
 * Strict about shape and forgiving about everything else: a rejected call costs
 * a paid round-trip, so anything recoverable is recovered here. What is not
 * recoverable is a status we would have to guess at, because rendering a
 * misspelled one as "pending" would silently un-finish completed work.
 */
export function parseTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) throw new TodoError("todos must be an array");
  if (input.length > MAX_TODOS) throw new TodoError(`too many todos (${input.length}); keep the list under ${MAX_TODOS}`);

  const out: Todo[] = [];
  for (const [i, raw] of input.entries()) {
    if (typeof raw !== "object" || raw === null) throw new TodoError(`todo ${i + 1} is not an object`);
    const item = raw as { content?: unknown; status?: unknown };
    const content = typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "";
    if (!content) throw new TodoError(`todo ${i + 1} has no content`);
    const status = item.status;
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      throw new TodoError(`todo ${i + 1} has status ${JSON.stringify(status)} — use one of ${STATUSES.join(", ")}`);
    }
    out.push({ content: content.slice(0, MAX_TODO_CHARS), status: status as TodoStatus });
  }
  return out;
}

/**
 * The list as both audiences read it.
 *
 * Completed items are struck through with a tick rather than removed: what is
 * already done is the part that stops the model redoing it, and the part that
 * lets the user see the turn is making progress rather than circling.
 */
export function renderTodos(items: Todo[]): string {
  if (items.length === 0) return "(the task list is empty)";
  const lines = items.map((t) => `${GLYPH[t.status]} ${t.content}`);
  return `${lines.join("\n")}\n${todoSummary(items)}`;
}

/** "2/5 done · now: write the tests" — one line, for a status readout. */
export function todoSummary(items: Todo[]): string {
  const done = items.filter((t) => t.status === "completed").length;
  const active = items.find((t) => t.status === "in_progress");
  return `${done}/${items.length} done${active ? ` · now: ${active.content}` : ""}`;
}

/**
 * What the model is told after an update.
 *
 * It repeats the whole list back on purpose. The alternative — "ok, 5 todos" —
 * leaves the only copy of the plan in a tool *call* several rounds back, which
 * is exactly the message a long turn compacts away first.
 */
export function todoResult(items: Todo[]): string {
  const more = items.filter((t) => t.status === "in_progress").length;
  const warning =
    more > 1
      ? "\nNote: more than one item is in progress. Work on one at a time so the list says where you actually are."
      : "";
  return `Task list updated.\n${renderTodos(items)}${warning}`;
}
