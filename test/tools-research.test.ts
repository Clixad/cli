/**
 * The tools that reach outside the workspace, and the two that talk to the
 * person at the keyboard.
 *
 * The property that runs through all of them: a capability the run does not
 * have is an *error the model can act on*, never a silent nothing. "web search
 * is not available, use web_fetch instead" costs one round-trip and gets the
 * answer; an empty result list costs the same round-trip and teaches the model
 * something false about the world.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TOOLS,
  ToolError,
  subagentToolSchema,
  toolSchemaFor,
  type AskUserRequest,
  type ToolContext,
} from "../src/tools.ts";
import { NO_SEARCH_INSTRUCTION } from "../src/agent.ts";
import { TodoList } from "../src/todos.ts";
import type { PermissionRequest } from "../src/permissions.ts";

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-research-"));
  ctx = { root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Records what was put to the gate, and answers with `allowed`. */
function recordingPermit(allowed: boolean) {
  const seen: PermissionRequest[] = [];
  return {
    seen,
    permit: async (req: PermissionRequest) => {
      seen.push(req);
      return allowed
        ? ({ allowed: true } as const)
        : ({ allowed: false, reason: "the user denied it", notice: "denied by you" } as const);
    },
  };
}

const result = (title: string, url: string) => ({ title, url, snippet: `about ${title}` });

describe("web_search", () => {
  it("renders titles, urls and snippets, and points at web_fetch", async () => {
    const ctxWithSearch: ToolContext = {
      ...ctx,
      webSearch: async () => [result("Vitest docs", "https://vitest.dev/"), result("Guide", "https://vitest.dev/guide")],
    };
    const out = await TOOLS.web_search(ctxWithSearch, { query: "vitest mocking" });
    expect(out).toContain("Vitest docs");
    expect(out).toContain("https://vitest.dev/guide");
    expect(out).toContain("web_fetch");
  });

  it("clamps the number of results a model asks for", async () => {
    let asked = 0;
    const ctxWithSearch: ToolContext = {
      ...ctx,
      webSearch: async (_q, opts) => {
        asked = opts.count ?? 0;
        return [];
      },
    };
    await TOOLS.web_search(ctxWithSearch, { query: "x", count: 999 });
    expect(asked).toBe(10);
    await TOOLS.web_search(ctxWithSearch, { query: "x", count: 0 });
    expect(asked).toBe(1);
  });

  it("says nothing matched, which is not the same as a failure", async () => {
    const out = await TOOLS.web_search({ ...ctx, webSearch: async () => [] }, { query: "asdkjhasd" });
    expect(out).toContain('no results for "asdkjhasd"');
  });

  it("points at web_fetch when no gateway is wired, rather than returning nothing", async () => {
    await expect(TOOLS.web_search(ctx, { query: "anything" })).rejects.toThrow(/use web_fetch/);
  });

  it("turns the gateway's refusal into something the model can read", async () => {
    // A 503 from the search route is "this gateway has no key", which the model
    // should hear once and then work around — not a fault that ends the turn.
    const failing: ToolContext = {
      ...ctx,
      webSearch: async () => {
        throw new Error("Web search isn't enabled on this gateway");
      },
    };
    await expect(TOOLS.web_search(failing, { query: "x" })).rejects.toThrow(ToolError);
  });

  it("needs a query", async () => {
    await expect(TOOLS.web_search(ctx, { query: "  " })).rejects.toThrow(/needs a query/);
  });
});

describe("web_fetch", () => {
  it("is not gated, because plan mode is when you read the documentation", async () => {
    // A read-only mode that could not look anything up would be the mode in
    // which the agent guesses.
    const { seen, permit } = recordingPermit(false);
    await TOOLS.web_fetch({ ...ctx, permit }, { url: "file:///etc/passwd" }).catch(() => undefined);
    expect(seen).toEqual([]);
  });

  it("refuses a scheme that is not http(s)", async () => {
    await expect(TOOLS.web_fetch(ctx, { url: "file:///etc/passwd" })).rejects.toThrow(ToolError);
    await expect(TOOLS.web_fetch(ctx, { url: "file:///etc/passwd" })).rejects.toThrow(/only http and https/);
  });
});

describe("todo_write", () => {
  it("writes the list and reads it back to the model", async () => {
    const todos = new TodoList();
    const out = TOOLS.todo_write({ ...ctx, todos }, { todos: [{ content: "one", status: "in_progress" }] });
    expect(todos.items).toEqual([{ content: "one", status: "in_progress" }]);
    expect(out).toContain("▶ one");
  });

  it("turns a bad list into a tool error rather than a crash", () => {
    const todos = new TodoList();
    expect(() => TOOLS.todo_write({ ...ctx, todos }, { todos: [{ content: "x", status: "nope" }] })).toThrow(ToolError);
  });

  it("says so when the run has no list", () => {
    expect(() => TOOLS.todo_write(ctx, { todos: [] })).toThrow(/no task list/);
  });
});

describe("ask_user", () => {
  it("puts the question up and reports the answer as a fact", async () => {
    let asked: AskUserRequest | undefined;
    const out = await TOOLS.ask_user(
      {
        ...ctx,
        askUser: async (req) => {
          asked = req;
          return "Postgres";
        },
      },
      { question: "Which database?", options: [{ label: "Postgres", description: "already in the repo" }, { label: "SQLite" }] },
    );
    expect(asked?.question).toBe("Which database?");
    expect(asked?.options[0]).toEqual({ label: "Postgres", description: "already in the repo" });
    expect(out).toBe("The user chose: Postgres");
  });

  it("accepts bare strings as options, which is what a model reaches for first", async () => {
    const out = await TOOLS.ask_user({ ...ctx, askUser: async () => "b" }, { question: "a or b?", options: ["a", "b"] });
    expect(out).toBe("The user chose: b");
  });

  it("needs at least two options — one option is not a question", async () => {
    await expect(
      TOOLS.ask_user({ ...ctx, askUser: async () => "x" }, { question: "?", options: [{ label: "only" }] }),
    ).rejects.toThrow(/at least two options/);
  });

  it("tells the model to state an assumption when nobody is watching", async () => {
    // `clixad -p`. A default here would be an answer the user never gave.
    await expect(TOOLS.ask_user(ctx, { question: "?", options: ["a", "b"] })).rejects.toThrow(/nobody to ask/);
  });
});

describe("task", () => {
  it("hands the prompt to the runner and returns its report", async () => {
    const seen: string[] = [];
    const out = await TOOLS.task(
      { ...ctx, spawn: async (description, prompt) => `${description}|${prompt}` },
      { description: "find the config", prompt: "Where is the retry count set?" },
    );
    expect(out).toBe("find the config|Where is the retry count set?");
    expect(seen).toEqual([]);
  });

  it("refuses inside a sub-agent, and says what to do instead", async () => {
    // The recursion guard is the absence of `spawn`, so this is the message a
    // sub-agent gets when it tries to fan out.
    await expect(TOOLS.task(ctx, { description: "x", prompt: "y" })).rejects.toThrow(
      /sub-agents cannot start sub-agents/,
    );
  });

  it("needs a prompt that stands on its own", async () => {
    await expect(TOOLS.task({ ...ctx, spawn: async () => "" }, { description: "x", prompt: " " })).rejects.toThrow(
      /needs a prompt/,
    );
  });
});

describe("a gateway with no search key", () => {
  it("drops web_search from the schema instead of advertising an error", () => {
    // 106 input tokens on every model call, for a tool that cannot answer.
    const names = (schema: readonly unknown[]) =>
      schema.map((t) => (t as { function: { name: string } }).function.name);

    expect(names(toolSchemaFor("normal", [], { webSearch: false }))).not.toContain("web_search");
    expect(names(toolSchemaFor("normal", [], {}))).not.toContain("web_search");
    expect(names(toolSchemaFor("plan", [], { webSearch: false }))).not.toContain("web_search");
    expect(names(subagentToolSchema({ webSearch: false }))).not.toContain("web_search");
  });

  it("keeps web_fetch, which needs no key and is the way out", () => {
    const names = (schema: readonly unknown[]) =>
      schema.map((t) => (t as { function: { name: string } }).function.name);
    for (const schema of [
      toolSchemaFor("normal", [], { webSearch: false }),
      toolSchemaFor("plan", [], { webSearch: false }),
      subagentToolSchema({ webSearch: false }),
    ]) {
      expect(names(schema)).toContain("web_fetch");
    }
  });

  it("brings web_search back when the gateway has a key", () => {
    const names = (schema: readonly unknown[]) =>
      schema.map((t) => (t as { function: { name: string } }).function.name);
    expect(names(toolSchemaFor("normal", [], { webSearch: true }))).toContain("web_search");
    expect(names(toolSchemaFor("plan", [], { webSearch: true }))).toContain("web_search");
    expect(names(subagentToolSchema({ webSearch: true }))).toContain("web_search");
  });

  it("tells the model what it can still reach, with real keyless addresses", () => {
    // Otherwise an agent with no search tool concludes that anything outside
    // the workspace is unknowable, which is a worse failure than a slow lookup.
    expect(NO_SEARCH_INSTRUCTION).toContain("web_fetch works normally");
    expect(NO_SEARCH_INSTRUCTION).toContain("https://registry.npmjs.org/");
    expect(NO_SEARCH_INSTRUCTION).toContain("https://raw.githubusercontent.com/");
    // And not to invent an answer when it cannot find an address.
    expect(NO_SEARCH_INSTRUCTION).toContain("ask the user for the link");
  });
});
