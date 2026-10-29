/**
 * The agentic tool loop — what turns Clixad from a chatbot into a coding
 * agent. It streams the conversation plus the tool schema through the gateway,
 * executes whatever tool_calls come back (via the sandboxed `TOOLS` in
 * `tools.ts`), feeds the results in, and repeats until the model stops calling
 * tools or a step budget is hit.
 *
 * Everything the UI needs arrives as `AgentEvent`s — text deltas, tool calls,
 * live command output, per-round metering — so the TUI can render a turn as it
 * happens and this file stays free of rendering concerns.
 *
 * The loop depends only on the small `AgentClient` interface (one `chatStream`
 * method), so it can be unit-tested with a scripted fake — see
 * `test/agent.test.ts`. Side-effecting tools are gated by `opts.permit`
 * (`permissions.ts`); a denied call is reported back to the model as an error
 * string so it can adapt rather than crash.
 */
import {
  PermissionDeniedError,
  TOOLS,
  TOOL_SCHEMA,
  ToolError,
  runMcpTool,
  subagentToolSchema,
  type AskUserRequest,
  type ToolContext,
} from "./tools.ts";
import { isMcpToolName, type McpHub } from "./mcp.ts";
import type { ShellRegistry } from "./shells.ts";
import type { TodoList } from "./todos.ts";
import type { PermissionRequest, PlanDecision, Permit, ReviewVerdict } from "./permissions.ts";
import { parseReview, reviewFailure, reviewMessages, userTexts } from "./auto-mode.ts";
import {
  imagePart,
  messageText,
  type ChatMessage,
  type ChatTurn,
  type ChatOptions,
  type ContentPart,
  type ImageAttachment,
  type Spendable,
  type ToolCall,
  type WebSearchResult,
  withoutReasoning,
} from "./client.ts";

/** The slice of GatewayClient the loop needs; keeps it testable in isolation. */
export interface AgentClient {
  chatStream(messages: ChatMessage[], model: string, opts: ChatOptions): Promise<ChatTurn>;
}

export type AgentEvent =
  /** A chunk of assistant text as it streams in. */
  | { type: "delta"; text: string }
  /** A completed assistant message (a round may have both text and tool calls). */
  | { type: "message"; content: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  /** Live stdout/stderr from a running command. */
  | { type: "tool_output"; id: string; chunk: string }
  /**
   * `result` is what the model is told; `display` — when present — is the
   * shorter thing to show the user instead. Only a permission refusal sets it,
   * because only there do the two audiences need different sentences.
   */
  | { type: "tool_result"; id: string; name: string; result: string; ok: boolean; display?: string }
  /** Images a tool put into the conversation, for a notice in the transcript. */
  | { type: "attachment"; labels: string[] }
  /**
   * Metering for one model round-trip.
   *
   * `creditsCharged` is what left the wallet, so on a free call it is 0 and the
   * status line's spend correctly does not move. `creditsWaived` is what the
   * free tier absorbed instead, and `freeCreditsLeft` is what this account has
   * left of today's allowance — both absent on a paid call and on any gateway
   * that has no free tier, which is what makes "is this free" a single truthy
   * test rather than two fields to reconcile.
   */
  | {
      type: "usage";
      creditsCharged: number;
      balance: number;
      free?: boolean;
      creditsWaived?: number;
      freeCreditsLeft?: number;
      /** What may be spent next, worked out from `balance` (`Spendable`); absent on a free call. */
      spendable?: Spendable;
    }
  | { type: "final"; content: string; creditsCharged: number; balance: number }
  | { type: "aborted" }
  | { type: "max_steps" };

export interface RunAgentOptions {
  model: string;
  /**
   * The `/effort` setting for `model`, sent with every call of the run,
   * sub-agents included. Absent sends none and the model runs at its default.
   */
  effort?: string;
  /** Workspace root the tools are confined to (usually process.cwd()). */
  root: string;
  /** Conversation so far, without the system prompt. The task is appended to it. */
  history?: ChatMessage[];
  /**
   * Images the user attached to this message (`@screenshot.png`).
   *
   * Separate from `task` rather than folded into it so everything that titles,
   * logs or queues a turn still has a plain string to work with — a session
   * whose title is a base64 blob is a session nobody can find again.
   */
  attachments?: ImageAttachment[];
  systemPrompt?: string;
  /** Gate for side-effecting tools; see permissions.ts. Absent = allow. */
  permit?: Permit;
  /**
   * The model auto mode's reviewer runs on (`pickReviewModel`), at the setting
   * given. Absent = nothing to review with, and an action auto mode cannot sort
   * on its own is put to the user instead.
   */
  review?: { model: string; effort?: string };
  /**
   * What the model may call, asked **per model call** rather than once per run:
   * an approved plan changes the permission mode in the middle of a turn, and
   * the write tools have to come back with it. Absent = everything.
   */
  tools?: () => readonly unknown[];
  /** Puts a plan to the user; wired to the TUI dialog. See `exit_plan_mode`. */
  approvePlan?: (plan: string) => Promise<PlanDecision>;
  /** Cancels the run (Esc in the REPL) — kills the request and any child process. */
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Loop guard: max model round-trips before giving up. */
  maxSteps?: number;
  /** Backs `web_search`; absent = the tool says so rather than returning nothing. */
  webSearch?: (query: string, opts: { count?: number; signal?: AbortSignal }) => Promise<WebSearchResult[]>;
  /**
   * Whether this gateway actually has a search key.
   *
   * Separate from `webSearch` above, which is only the wiring: the function is
   * always there, and whether it can answer is the gateway's business. It
   * decides what a *sub-agent* is offered and told — the parent's own schema and
   * prompt are the caller's to assemble.
   */
  webSearchAvailable?: boolean;
  /** Backs `ask_user`; wired to the TUI's picker. */
  askUser?: (req: AskUserRequest) => Promise<string>;
  /** The session's task list, so `todo_write` survives across turns. */
  todos?: TodoList;
  /** Connected MCP servers, whose tools are dispatched by qualified name. */
  mcp?: McpHub;
  /** Background command registry; defaults to the process-wide one. */
  shells?: ShellRegistry;
  /**
   * How deep in the sub-agent tree this run is. 0 is the real turn; a sub-agent
   * runs at 1 and gets no `spawn`, which is the whole of the recursion guard.
   */
  depth?: number;
}

/** Model round-trips one sub-agent may spend before it has to report back. */
export const SUBAGENT_MAX_STEPS = 12;

export interface AgentResult {
  content: string;
  /** Full conversation incl. system prompt, assistant turns and tool results. */
  messages: ChatMessage[];
  creditsCharged: number;
  balance: number;
  /**
   * Credits the free tier absorbed across the whole turn, and what is left of
   * today's allowance after it.
   *
   * Summed the way `creditsCharged` is, over every round *and* every sub-agent,
   * because a turn is what the user sees a meta line for and a sub-agent's free
   * calls spend the same allowance. `freeCreditsLeft` is the **last** figure
   * seen rather than a sum: it is a remaining balance, and adding two of them
   * together would be meaningless.
   *
   * `creditsWaived > 0` is the test for "this turn was free", which is why there
   * is no separate boolean here: a turn that mixed free and paid rounds — the
   * allowance running out halfway through — is honestly described by both
   * numbers being non-zero, and a flag would have to pick one.
   */
  creditsWaived: number;
  freeCreditsLeft?: number;
  steps: number;
  stopped?: "aborted" | "max_steps";
}

export const SYSTEM_PROMPT =
  "You are Clixad, a terminal coding agent. You can read, search, write and " +
  "edit files and run shell commands, all confined to the user's workspace. " +
  // The name is said twice on purpose. Once was not enough for every model in
  // the catalog: asked "Wer bist du?", Gemini 2.5 Flash-Lite answered "Ich bin
  // ein großes Sprachmodell, das von Google trainiert wurde" with this prompt
  // in front of it, and the user reading that is running a product called
  // Clixad. The model underneath is real and may be named when asked for; it is
  // just not who is talking.
  "When someone asks who or what you are, answer that you are Clixad, in their " +
  "language; do not introduce yourself as the underlying language model or as a " +
  "product of the company that trained it. If asked which model you run on, say " +
  "it is the one selected with /model, shown under the input box. " +
  "Find your way around with glob and grep before reading whole files. Prefer " +
  "edit_file over write_file for existing files. Make minimal correct edits, " +
  "verify them when a test or build command is available, and stop when the " +
  "task is complete. Keep your final message short: say what you did and why.\n\n" +
  // Answering is a valid outcome. Without this the prompt was entirely
  // action-shaped — it ended on "say what you changed", which presupposes that
  // every turn changes something — and "write back test successful if you can
  // read this" was read as an instruction to create a file.
  "Not every message is a task. If the user asks a question, or asks you to say " +
  "something, answer in plain text and call no tools at all. Reach for a file or " +
  "a command only when the request is actually about one, and when a message is " +
  "ambiguous, prefer the reading of it that changes nothing.\n\n" +
  // The other half of the same problem: a call that was refused is not a call
  // that is pending. The model used to carry its own announced-but-refused plan
  // forward and act on it the next time the user said anything.
  "A tool call that was refused did not happen. Never describe it as done, and " +
  "do not repeat it on a later message unless the user asks for it again.\n\n" +
  // Each of these exists because the model otherwise reaches for the wrong
  // thing: it guesses at an API instead of reading the docs, waits two minutes
  // for a dev server that was never going to exit, or opens forty files in a
  // context the user is paying for.
  "Reach outside the workspace when the answer is outside it: web_search for " +
  "current documentation, releases and error messages, then web_fetch to read " +
  "the page. Do not guess at an API you could look up.\n\n"
  // See NO_SEARCH_INSTRUCTION: the sentence above is amended, not replaced,
  // when the gateway has no search key.
 +
  "Start anything that does not exit on its own — dev servers, watchers, tailed " +
  "logs — with run_command background: true, and read it with read_output. A " +
  "foreground command is killed after its timeout.\n\n" +
  "When finding something out means opening many files, give it to task instead: " +
  "the sub-agent reads them in its own context and reports back, which keeps this " +
  "conversation short. Use todo_write for work with several distinct steps, and " +
  "keep it current as you go.";

/**
 * What the model is told when this gateway has no search key.
 *
 * The tool is gone from the schema by then, so this is not a refusal — it is the
 * difference between an agent that gives up on anything outside the workspace
 * and one that still gets the answer. Every URL named here is public, keyless
 * and stable, and each stands in for a question a model would otherwise have
 * searched for: which version is current, what does this library actually do,
 * what does the documentation say.
 *
 * Appended per turn like `modeInstruction`, and only when it applies: a
 * deployment that *does* have search must not pay for this paragraph.
 */
export const NO_SEARCH_INSTRUCTION = [
  "# Web search is not available on this gateway",
  "There is no web_search tool. web_fetch works normally and needs no key, so fetch a URL directly",
  "rather than giving up on anything outside the workspace. Reliable keyless sources:",
  "- https://registry.npmjs.org/<package> — versions, dependencies, repository (JSON)",
  "- https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> — a file as text, e.g. README.md",
  "- https://api.github.com/repos/<owner>/<repo>/releases/latest — the current release and its notes",
  "- https://pypi.org/pypi/<package>/json, https://crates.io/api/v1/crates/<crate> — the same for those",
  "- a project's own documentation site, when you know or can infer the address",
  "Follow the links web_fetch returns; it keeps them. If you genuinely cannot find an address, say so",
  "and ask the user for the link rather than inventing an answer.",
].join("\n");

/**
 * What a sub-agent is told instead.
 *
 * It gets its own prompt rather than the main one plus a note, because the main
 * one is about editing a workspace and a sub-agent cannot edit anything. The
 * last paragraph is the load-bearing one: its context is thrown away the moment
 * it finishes, so anything it does not put in its final message is lost, and a
 * sub-agent that answers "I found it in three files" has cost credits to say
 * nothing.
 */
export const SUBAGENT_PROMPT =
  "You are a research sub-agent inside Clixad, a terminal coding agent. Another " +
  "agent has handed you one self-contained question and is waiting for the answer.\n\n" +
  "You can read, search and glob within the workspace, and search and fetch the " +
  "web. You cannot write files, run commands, or ask anyone anything — if the " +
  "task seems to need one of those, report what you found and say what is " +
  "missing.\n\n" +
  "Work efficiently: glob and grep before reading whole files. Then answer in " +
  "one message. Nothing you saw survives except what you write there, so quote " +
  "the exact snippets, name the files with line numbers, and state what you could " +
  "not establish. Do not describe your process; report what you found.";

export async function runAgent(
  client: AgentClient,
  task: string,
  opts: RunAgentOptions,
): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? 16;
  const depth = opts.depth ?? 0;
  const emit = (e: AgentEvent) => opts.onEvent?.(e);

  let creditsCharged = 0;
  let creditsWaived = 0;
  let freeCreditsLeft: number | undefined;
  let balance = 0;
  let lastText = "";

  /**
   * Images a tool asked to put in front of the model this round.
   *
   * They cannot ride in the tool result — an OpenAI-compatible `tool` message is
   * a string — so they are collected here and sent as a user message once every
   * tool_call has been answered. Doing it any earlier would put a message
   * between an assistant's tool_calls and their results, which is malformed.
   */
  let pendingImages: ImageAttachment[] = [];

  /**
   * Auto mode's reviewer, run here rather than in the UI for two reasons that
   * are both about honesty. Here is where the conversation is, including the
   * message that started this turn, and the reviewer has to read what the user
   * asked for. And here is the meter: a review is a model call, it is billed,
   * and it lands on this turn's total and in its `usage` events like a
   * sub-agent's, so no turn ever costs more than its meta line says.
   *
   * It reads only what the user typed (`userTexts`) and the action. Never a
   * tool result: a file that says "the user approved this" is the injection a
   * reviewer exists to resist, and the cheapest way to resist it is not to
   * show it.
   */
  const review = opts.review;
  const reviewer = review
    ? async (req: PermissionRequest): Promise<ReviewVerdict> => {
        if (opts.signal?.aborted) return { decision: "stopped" };
        let turn: ChatTurn;
        try {
          turn = await client.chatStream(
            reviewMessages({ request: req, userMessages: userTexts(messages), root: opts.root }),
            review.model,
            { ...(review.effort ? { effort: review.effort } : {}), signal: opts.signal },
          );
        } catch (err) {
          if (isAbort(err) || opts.signal?.aborted) return { decision: "stopped" };
          return { decision: "unavailable", why: reviewFailure(err) };
        }
        creditsCharged += turn.creditsCharged;
        creditsWaived += turn.creditsWaived ?? 0;
        if (turn.freeCreditsLeft !== undefined) freeCreditsLeft = turn.freeCreditsLeft;
        balance = turn.balance;
        emitUsage(turn);
        return parseReview(messageText(turn.message)) ?? { decision: "unavailable", why: "its answer could not be read" };
      }
    : undefined;
  const permit: Permit | undefined = opts.permit ? (req) => opts.permit!(req, reviewer) : undefined;

  const ctx: ToolContext = {
    root: opts.root,
    permit,
    signal: opts.signal,
    approvePlan: opts.approvePlan,
    webSearch: opts.webSearch,
    askUser: opts.askUser,
    todos: opts.todos,
    mcp: opts.mcp,
    shells: opts.shells,
    attach: (image) => pendingImages.push(image),
    // The recursion guard, and the whole of it: a sub-agent runs at depth 1 and
    // is handed no way to start another.
    ...(depth === 0 ? { spawn: runSubAgent } : {}),
  };

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? SYSTEM_PROMPT },
    ...(opts.history ?? []),
    {
      role: "user",
      content: opts.attachments?.length
        ? ([{ type: "text", text: task }, ...opts.attachments.map(imagePart)] as ContentPart[])
        : task,
    },
  ];

  /**
   * Run one sub-agent and return its answer as a string.
   *
   * Only its `usage` reaches the caller's event stream: its tool calls belong to
   * its own conversation, and committing them to the parent's transcript would
   * undo the one thing a sub-agent is for. Progress goes to `onProgress`, which
   * the tool has already bound to its own call, so the user sees it working
   * without any of it being kept.
   *
   * Its credits are added to this run's total. They were really spent, and a
   * turn that quietly billed for a sub-agent it never mentioned would be the
   * kind of surprise this product can least afford.
   */
  async function runSubAgent(
    description: string,
    prompt: string,
    onProgress?: (line: string) => void,
  ): Promise<string> {
    onProgress?.(`${description}: starting`);
    const sub = await runAgent(client, prompt, {
      model: opts.model,
      // The setting somebody chose for this model, the same as the parent's
      // calls: a sub-agent's credits land on the same turn.
      effort: opts.effort,
      root: opts.root,
      // A sub-agent that was told it can search the web, on a gateway that
      // cannot, spends its whole step budget discovering that.
      systemPrompt: opts.webSearchAvailable
        ? SUBAGENT_PROMPT
        : `${SUBAGENT_PROMPT}\n\n${NO_SEARCH_INSTRUCTION}`,
      // Gated like everything else as a backstop. It has only read-only tools,
      // so nothing it can call reaches the gate on the ordinary path.
      permit: opts.permit,
      tools: () => subagentToolSchema({ webSearch: opts.webSearchAvailable === true }),
      signal: opts.signal,
      maxSteps: SUBAGENT_MAX_STEPS,
      webSearch: opts.webSearch,
      webSearchAvailable: opts.webSearchAvailable,
      shells: opts.shells,
      depth: depth + 1,
      onEvent: (event) => {
        if (event.type === "usage") {
          // Forwarded so the balance and the session's spend keep up. The
          // running total below is what the *turn* reports; these two must not
          // both add to the same counter, and they do not: this one moves the
          // TUI's `spent`, the other one fills in the turn's meta line.
          balance = event.balance;
          emit(event);
          return;
        }
        if (event.type === "tool_call") onProgress?.(`  ${event.name} ${firstArg(event.args)}`);
      },
    });
    creditsCharged += sub.creditsCharged;
    // A sub-agent spends the same wallet and the same allowance, so both
    // counters follow it. Its `usage` events are forwarded separately, which is
    // the other half of the same rule: the events move the status line, these
    // totals fill in the turn's meta line, and a turn that quietly billed — or
    // quietly spent an allowance — for work it never mentioned would be the
    // worst kind of surprise here.
    creditsWaived += sub.creditsWaived;
    if (sub.freeCreditsLeft !== undefined) freeCreditsLeft = sub.freeCreditsLeft;
    if (sub.stopped === "aborted") return "the sub-agent was stopped before it finished";
    const answer = sub.content.trim();
    if (!answer) return "the sub-agent finished without reporting anything";
    return sub.stopped === "max_steps"
      ? `${answer}\n\n(the sub-agent hit its step limit — this answer may be incomplete)`
      : answer;
  }

  /** Every model call is metered and reported, the ones that come back empty included. */
  function emitUsage(turn: ChatTurn): void {
    emit({
      type: "usage",
      creditsCharged: turn.creditsCharged,
      balance: turn.balance,
      ...(turn.free
        ? {
            free: true,
            creditsWaived: turn.creditsWaived ?? 0,
            freeCreditsLeft: turn.freeCreditsLeft ?? 0,
          }
        : {}),
      ...(turn.spendable ? { spendable: turn.spendable } : {}),
    });
  }

  let retriedEmpty = false;
  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return stop("aborted");

    let turn: ChatTurn;
    try {
      turn = await client.chatStream(messages, opts.model, {
        effort: opts.effort,
        tools: opts.tools ? opts.tools() : TOOL_SCHEMA,
        signal: opts.signal,
        onDelta: (text) => emit({ type: "delta", text }),
      });
    } catch (err) {
      if (isAbort(err) || opts.signal?.aborted) return stop("aborted");
      throw err;
    }

    creditsCharged += turn.creditsCharged;
    creditsWaived += turn.creditsWaived ?? 0;
    if (turn.freeCreditsLeft !== undefined) freeCreditsLeft = turn.freeCreditsLeft;
    balance = turn.balance;
    emitUsage(turn);

    const content = messageText(turn.message);
    const calls = turn.message.tool_calls ?? [];

    // An answer with nothing in it — no text and no tool call — is never what
    // was asked for, and it is a thing models do: Gemini 2.5 Flash-Lite spends
    // its tokens thinking and emits nothing on roughly one call in twenty with
    // this prompt, and a thinking model can leave its whole reply in the
    // reasoning. The TUI then commits nothing and the turn simply ends in
    // silence. Asked again, unchanged, the same model answers; so it is asked
    // once more, and the empty reply is not kept. Once, not in a loop: the call
    // is billed like any other (it was, by the provider), and a model that is
    // empty twice running is not going to be rescued by a third.
    if (calls.length === 0 && !content.trim() && !retriedEmpty) {
      retriedEmpty = true;
      continue;
    }
    retriedEmpty = false;
    messages.push(turn.message);
    if (content) lastText = content;

    if (calls.length === 0) {
      emit({ type: "final", content, creditsCharged, balance });
      return {
        content,
        messages: withoutReasoning(messages),
        creditsCharged,
        balance,
        creditsWaived,
        freeCreditsLeft,
        steps: step + 1,
      };
    }

    // A round can carry both a sentence and tool calls; show the sentence first.
    if (content) emit({ type: "message", content });

    pendingImages = [];
    for (const [i, call] of calls.entries()) {
      if (opts.signal?.aborted) {
        // Every announced tool_call needs a matching tool message, or the next
        // request is malformed — fill the rest in as cancelled.
        for (const rest of calls.slice(i)) messages.push(toolMessage(rest, "cancelled by the user"));
        return stop("aborted");
      }
      const result = await executeToolCall(ctx, call, emit);
      messages.push(toolMessage(call, result));
    }

    // Images last, once every tool_call has its answer: a user message in
    // between an assistant's tool_calls and their results is malformed, and
    // providers reject the whole request rather than the one message.
    if (pendingImages.length) {
      messages.push(imageMessage(pendingImages));
      emit({
        type: "attachment",
        labels: pendingImages.map((image) => image.label),
      });
      pendingImages = [];
    }
  }

  emit({ type: "max_steps" });
  return {
    content: lastText || "(stopped: reached max steps)",
    messages: withoutReasoning(messages),
    creditsCharged,
    balance,
    creditsWaived,
    freeCreditsLeft,
    steps: maxSteps,
    stopped: "max_steps",
  };

  function stop(reason: "aborted"): AgentResult {
    emit({ type: reason });
    return {
      content: lastText,
      messages: withoutReasoning(messages),
      creditsCharged,
      balance,
      creditsWaived,
      freeCreditsLeft,
      steps: 0,
      stopped: reason,
    };
  }
}

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: "tool", tool_call_id: call.id, name: call.function.name, content };
}

/**
 * The user message that carries images a tool produced.
 *
 * The sentence in front of them is not decoration: without it a model that
 * receives an image with no text reads it as the user having sent a picture and
 * nothing else, and answers "what would you like me to do with this?".
 */
function imageMessage(images: ImageAttachment[]): ChatMessage {
  const names = images.map((image) => image.label).join(", ");
  const parts: ContentPart[] = [
    {
      type: "text",
      text: `Here ${images.length === 1 ? "is the image" : "are the images"} you read (${names}). Continue the task.`,
    },
    ...images.map(imagePart),
  ];
  return { role: "user", content: parts };
}

/** A short "what is it doing" line for a sub-agent's tool call. */
function firstArg(args: Record<string, unknown>): string {
  for (const key of ["path", "pattern", "query", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value.slice(0, 60);
  }
  return "";
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Run one tool_call. Errors become strings fed back to the model, not throws. */
async function executeToolCall(
  ctx: ToolContext,
  call: ToolCall,
  emit: (event: AgentEvent) => void,
): Promise<string> {
  const name = call.function.name;
  const id = call.id;
  let args: Record<string, unknown>;
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
  } catch {
    return `error: invalid JSON arguments for ${name}`;
  }
  emit({ type: "tool_call", id, name, args });

  const scoped: ToolContext = { ...ctx, onOutput: (chunk) => emit({ type: "tool_output", id, chunk }) };
  try {
    const result = await dispatch(scoped, name, args);
    emit({ type: "tool_result", id, name, result, ok: true });
    return result;
  } catch (err) {
    if (err instanceof ToolError) {
      const msg = `error: ${err.message}`;
      emit({
        type: "tool_result",
        id,
        name,
        result: msg,
        ok: false,
        ...(err instanceof PermissionDeniedError ? { display: err.notice } : {}),
      });
      return msg;
    }
    throw err;
  }
}

async function dispatch(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return TOOLS.read_file(ctx, args as { path: string; offset?: number; limit?: number });
    case "list_dir":
      return TOOLS.list_dir(ctx, args as { path?: string });
    case "glob":
      return TOOLS.glob(ctx, args as { pattern: string; path?: string });
    case "grep":
      return TOOLS.grep(ctx, args as { pattern: string; path?: string; glob?: string });
    case "edit_file":
      return TOOLS.edit_file(ctx, args as { path: string; old_string: string; new_string: string; replace_all?: boolean });
    case "write_file":
      return TOOLS.write_file(ctx, args as { path: string; content: string });
    case "run_command":
      return TOOLS.run_command(ctx, args as { command: string; timeout?: number; background?: boolean });
    case "read_output":
      return TOOLS.read_output(ctx, args as { shell_id: string; filter?: string });
    case "kill_shell":
      return TOOLS.kill_shell(ctx, args as { shell_id: string });
    case "web_search":
      return TOOLS.web_search(ctx, args as { query: string; count?: number });
    case "web_fetch":
      return TOOLS.web_fetch(ctx, args as { url: string; max_chars?: number });
    case "task":
      return TOOLS.task(ctx, args as { description: string; prompt: string });
    case "todo_write":
      return TOOLS.todo_write(ctx, args as { todos: unknown });
    case "ask_user":
      return TOOLS.ask_user(ctx, args as { question: string; options?: unknown });
    case "exit_plan_mode":
      return TOOLS.exit_plan_mode(ctx, args as { plan: string });
    default:
      // Everything an MCP server provides arrives here, because its names are
      // not known until a server has been asked what it has.
      if (isMcpToolName(name)) return runMcpTool(ctx, name, args);
      return `error: unknown tool ${name}`;
  }
}
