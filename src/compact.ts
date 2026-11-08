/**
 * Context compaction. Every turn re-sends the whole conversation, so an
 * unmanaged context doesn't just eventually break the model — on a metered
 * product it quietly burns credits on tokens the user already paid for. When the
 * conversation approaches the model's window we replace the older turns with a
 * summary produced by the model itself.
 *
 * The cut is always where no tool call is left open: an assistant message
 * carrying `tool_calls` must keep its `tool` results, or the next request is
 * malformed. Normally that is a user message, keeping the last two turns as
 * they were. A conversation over the budget can also be cut inside a turn,
 * after a round's results, because one long task (a prompt and a run of large
 * file reads) has a single user message and nothing before it to summarise.
 *
 * **The budget** is three quarters of the window the gateway serves for the
 * model, measured by `requestTokens`: what each message weighs on the wire, at
 * four bytes a token. The gateway sizes that window so a conversation under it
 * is taken whatever is in it, so a compaction that lands under the budget is
 * one the next request is sure to fit, and so is every request compaction
 * itself sends: the part to be summarised goes out in pieces each under the
 * budget, never in one request that could be refused for the very length it is
 * meant to fix.
 */
import type { AgentClient } from "./agent.ts";
import { messageText, type ChatMessage, type ContentPart, type Spendable } from "./client.ts";

/** Rough token estimate — ~4 chars per token is close enough to decide *when*. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What one attached image costs, in tokens.
 *
 * A guess, and it has to be one: providers price images by tiled dimensions we
 * never decode, and the only exact figure arrives with the bill. It is used for
 * *when to compact*, so being wrong is a window that fills a little early or
 * late — and it is deliberately on the high side, because the failure on the
 * other side is a request the provider rejects for length.
 *
 * The gateway keeps its own copy of this idea for pre-authorisation. They are
 * separate on purpose: this program may import nothing but npm packages.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_400;

export function conversationTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(messageText(m));
    // An image is a few characters of text and a few thousand tokens of cost;
    // counting only its label is how a conversation with three screenshots in
    // it sails past the context window without ever triggering compaction.
    if (Array.isArray(m.content)) {
      total += m.content.filter((part) => part.type === "image_url").length * IMAGE_TOKEN_ESTIMATE;
    }
    for (const call of m.tool_calls ?? []) total += estimateTokens(call.function.arguments) + 8;
    total += 4; // role/metadata overhead
  }
  return total;
}

export const COMPACT_THRESHOLD = 0.75;

export function shouldCompact(messages: ChatMessage[], contextTokens: number, threshold = COMPACT_THRESHOLD): boolean {
  return conversationTokens(messages) > contextTokens * threshold;
}

/** The most a conversation may weigh, by `requestTokens`, after compaction, and the most any request compaction sends. */
export function compactBudget(contextTokens: number): number {
  return Math.floor(contextTokens * COMPACT_THRESHOLD);
}

/**
 * What one message weighs in a request: the UTF-8 bytes of its JSON at four a
 * token, which counts what `estimateTokens` leaves out (escaping, the field
 * names, text outside ASCII), and each image at `IMAGE_TOKEN_ESTIMATE` rather
 * than by the length of its base64.
 */
export function messageWeight(message: ChatMessage): number {
  let images = 0;
  const content = Array.isArray(message.content)
    ? message.content.map((part) => {
        if (part.type !== "image_url") return part;
        images++;
        return { ...part, image_url: { url: "" } };
      })
    : message.content;
  const bytes = Buffer.byteLength(JSON.stringify({ ...message, content }));
  return Math.ceil(bytes / 4) + images * IMAGE_TOKEN_ESTIMATE;
}

/** What a request carrying `messages` weighs; compared with `compactBudget`. */
export function requestTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageWeight(m);
  return total;
}

/**
 * Index of the first message to keep verbatim: walks back over at least
 * `keepTurns` user messages and stops on a user-message boundary. Returns 0 when
 * there is nothing worth summarising.
 */
export function cutPoint(messages: ChatMessage[], keepTurns = 2): number {
  let seen = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]!.role !== "user") continue;
    seen++;
    if (seen >= keepTurns) return i;
  }
  return 0;
}

/**
 * Every index the conversation can be cut at, ascending, from 1 up to and
 * including its length: where no tool call made before it is still waiting
 * for its result, and the message there is not a result itself.
 */
export function safeCuts(messages: ChatMessage[]): number[] {
  const open = new Set<string>();
  const cuts: number[] = [];
  for (let i = 1; i <= messages.length; i++) {
    const prev = messages[i - 1]!;
    if (prev.role === "assistant") for (const call of prev.tool_calls ?? []) open.add(call.id);
    if (prev.role === "tool" && prev.tool_call_id) open.delete(prev.tool_call_id);
    if (open.size === 0 && (i === messages.length || messages[i]!.role !== "tool")) cuts.push(i);
  }
  return cuts;
}

/** How the summary opens, so a resumed transcript can tell it from a message somebody typed. */
export const SUMMARY_LEAD = "Summary of the earlier conversation:\n\n";
/** The answer the summary is paired with, which a resumed transcript does not draw. */
export const SUMMARY_ACK = "Understood — continuing from that summary.";

/**
 * The summary as the conversation carries it, ahead of `rest`. The
 * acknowledgement goes between the two unless `rest` opens with an assistant
 * message, which is a cut inside a turn: the model carries on with its own
 * next step, and two assistant messages in a row are not a conversation every
 * provider takes.
 */
export function withSummary(summary: string, rest: ChatMessage[]): ChatMessage[] {
  const lead: ChatMessage = { role: "user", content: `${SUMMARY_LEAD}${summary}` };
  return rest[0]?.role === "assistant" ? [lead, ...rest] : [lead, { role: "assistant", content: SUMMARY_ACK }, ...rest];
}

/**
 * The room a summary is given in the compacted conversation, by
 * `requestTokens`. The prompt asks for half as many words, since a word of
 * prose weighs about one and a half.
 */
function summaryReserve(budget: number): number {
  return Math.min(10_000, Math.max(1_000, Math.floor(budget / 6)));
}

function summaryPrompt(words: number): string {
  return (
    "Summarise the conversation above for your future self, which will continue " +
    "the work without seeing it. Cover: what the user asked for, what was already " +
    "changed (files and the reasoning), what was learned about the codebase, and " +
    "what is still open. Be specific about file paths and names. If it opens with " +
    "a summary of earlier messages, carry what that summary says forward. " +
    `At most ${words.toLocaleString("en-US")} words. No preamble.`
  );
}

export interface CompactPlan {
  /** The first message kept as it is: everything from 1 up to it is summarised. */
  cut: number;
  /** Whether the compacted conversation is sure to weigh no more than `compactBudget`. */
  fits: boolean;
  /** Whether the conversation weighs more than the budget now. */
  over: boolean;
}

/**
 * Where to cut, or undefined when there is nothing to summarise.
 *
 * Under the budget, the rule it always was: keep the last `keepTurns` turns,
 * and nothing to do without turns before them. Over it, the same cut when the
 * turns it keeps leave room, else the earliest later place that does, inside a
 * turn if need be, else everything. What is kept is held to half the budget,
 * so the next message starts well under the line rather than on it.
 */
export function planCompaction(
  messages: ChatMessage[],
  contextTokens: number,
  keepTurns = 2,
): CompactPlan | undefined {
  if (messages.length < 2) return undefined;
  const budget = compactBudget(contextTokens);
  // suffix[i]: what messages i onwards weigh, the part a cut at i keeps.
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + messageWeight(messages[i]!);
  const total = suffix[0]!;
  const tail = (from: number) => suffix[from]!;
  const fixed = total - suffix[1]! + summaryReserve(budget) + messageWeight({ role: "assistant", content: SUMMARY_ACK });
  const preferred = cutPoint(messages, keepTurns);
  const over = total > budget;

  if (!over) return preferred > 1 ? { cut: preferred, fits: fixed + tail(preferred) <= budget, over } : undefined;

  const cuts = safeCuts(messages).filter((c) => c >= Math.max(preferred, 2));
  if (cuts.length === 0) return undefined;
  const keep = Math.min(budget - fixed, Math.floor(budget / 2));
  const cut = cuts.find((c) => tail(c) <= keep) ?? cuts.at(-1)!;
  return { cut, fits: fixed + tail(cut) <= budget, over };
}

/** What `capText` adds where it cut. */
function cutNote(left: number): string {
  return `\n… [${left.toLocaleString("en-US")} more characters left out here]`;
}

function capText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}${cutNote(text.length - limit)}` : text;
}

/** Tool call arguments with every long string in them cut, still valid JSON. */
function capArguments(json: string, limit: number): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return capText(v, limit);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  try {
    return JSON.stringify(walk(JSON.parse(json)));
  } catch {
    return json.length > limit ? JSON.stringify({ arguments: capText(json, limit) }) : json;
  }
}

function capMessage(message: ChatMessage, limit: number): ChatMessage {
  const content: ChatMessage["content"] =
    typeof message.content === "string"
      ? capText(message.content, limit)
      : Array.isArray(message.content)
        ? message.content.map((part): ContentPart => (part.type === "text" ? { ...part, text: capText(part.text, limit) } : part))
        : message.content;
  const out: ChatMessage = { ...message, content };
  if (message.tool_calls) {
    out.tool_calls = message.tool_calls.map((c) => ({
      ...c,
      function: { ...c.function, arguments: capArguments(c.function.arguments, limit) },
    }));
  }
  return out;
}

/** An image left out of what is summarised, said in words so the summary can mention it. */
function withoutImages(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part): ContentPart =>
      part.type === "image_url" ? { type: "text", text: "[an image, not shown here]" } : part,
    ),
  };
}

function longestText(messages: ChatMessage[]): number {
  let longest = 0;
  for (const m of messages) {
    longest = Math.max(longest, messageText(m).length);
    for (const c of m.tool_calls ?? []) longest = Math.max(longest, c.function.arguments.length);
  }
  return longest;
}

/**
 * Messages too heavy for one summary request, cut down until they fit `room`:
 * images become a line saying one was there, then every long text is cut to
 * the same length, the longest that fits. What is cut is said where it was.
 * The conversation itself is not touched; this is only what the summary is
 * made from, and a file left out of it can be read again.
 */
export function shrinkToFit(messages: ChatMessage[], room: number): ChatMessage[] {
  if (requestTokens(messages) <= room) return messages;
  const plain = messages.map(withoutImages);
  if (requestTokens(plain) <= room) return plain;
  const capped = (limit: number) => plain.map((m) => capMessage(m, limit));
  let lo = 0;
  let hi = longestText(plain);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (requestTokens(capped(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return capped(lo);
}

export interface CompactResult {
  messages: ChatMessage[];
  summary: string;
  creditsCharged: number;
  balance: number;
  /** What may be spent next, worked out from `balance`; absent on a free call. */
  spendable?: Spendable;
  /** Estimated tokens before/after, for the notice in the TUI. */
  before: number;
  after: number;
  /** Model calls the summary took: more than one when the part summarised did not fit one request. */
  calls: number;
}

/**
 * Replace everything before the cut with one summary message. `messages[0]` (the
 * system prompt) is always kept; the summary is injected as a user message so
 * providers that allow only a leading system message stay happy.
 *
 * `contextTokens` is the model's window as the gateway serves it. What is
 * summarised goes out in as many requests as it takes for each to stay under
 * the budget, each one carrying the summary so far, so the last one's summary
 * covers all of it.
 */
export async function compact(
  client: AgentClient,
  model: string,
  messages: ChatMessage[],
  contextTokens: number,
  opts: { keepTurns?: number; signal?: AbortSignal; effort?: string } = {},
): Promise<CompactResult | undefined> {
  const plan = planCompaction(messages, contextTokens, opts.keepTurns ?? 2);
  if (!plan) return undefined;
  const { cut } = plan;
  const budget = compactBudget(contextTokens);
  const system = messages[0]!;
  const prompt: ChatMessage = { role: "user", content: summaryPrompt(Math.floor(summaryReserve(budget) / 2)) };

  // What is summarised, in rounds: the stretches between two places the
  // conversation can be cut, which never part a tool call from its result.
  const bounds = [1, ...safeCuts(messages).filter((c) => c > 1 && c < cut), cut];
  const rounds: ChatMessage[][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) rounds.push(messages.slice(bounds[i]!, bounds[i + 1]!));

  const before = conversationTokens(messages);
  let summary: string | undefined;
  let creditsCharged = 0;
  let balance = 0;
  let spendable: Spendable | undefined;
  let calls = 0;
  let next = 0;
  while (next < rounds.length) {
    // What this request has left for the messages once the system prompt,
    // the summary so far and the instruction are in it. The floor only
    // matters when the system prompt alone nearly fills the budget, which is
    // a conversation `planCompaction` already says will not fit.
    const room = Math.max(
      1_000,
      budget - requestTokens([system, prompt]) - (summary === undefined ? 0 : requestTokens(withSummary(summary, []))),
    );
    // Rounds in order while they fit. A round too large for any request is
    // cut down: alone when it comes first, else into what is left of this
    // one when that is at least half of it, so a one-line task is not given a
    // call of its own ahead of the file read that followed it.
    let chunk = shrinkToFit(rounds[next++]!, room);
    while (next < rounds.length) {
      const round = rounds[next]!;
      const left = room - requestTokens(chunk);
      if (requestTokens(round) <= left) {
        chunk = [...chunk, ...round];
        next++;
        continue;
      }
      if (requestTokens(round) > room && left >= room / 2) {
        chunk = [...chunk, ...shrinkToFit(round, left)];
        next++;
      }
      break;
    }

    const request = [system, ...(summary === undefined ? chunk : withSummary(summary, chunk)), prompt];
    let text = "";
    // An empty reply is not a summary: asked once more, and if it is empty
    // again the conversation stays as it was rather than being replaced with
    // nothing. Both calls are metered, so both are counted.
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      const turn = await client.chatStream(request, model, { signal: opts.signal, effort: opts.effort });
      calls++;
      creditsCharged += turn.creditsCharged;
      balance = turn.balance;
      spendable = turn.spendable;
      text = messageText(turn.message).trim();
    }
    if (!text) throw new Error("the model returned an empty summary, so the conversation was left as it was");
    summary = text;
  }

  // The summary is asked to stay inside its room and almost always does. When
  // it does not, it is cut rather than the conversation left over the budget
  // the compaction was for.
  const tailMessages = messages.slice(cut);
  let final = summary ?? "";
  const excess = requestTokens([system, ...withSummary(final, tailMessages)]) - budget;
  if (excess > 0) {
    const lead: ChatMessage = { role: "user", content: final };
    // One token over the excess, for the rounding between this message and
    // the one the summary lead is part of.
    final = messageText(shrinkToFit([lead], Math.max(0, messageWeight(lead) - excess - 1))[0]!);
  }
  const compacted: ChatMessage[] = [system, ...withSummary(final, tailMessages)];

  return {
    messages: compacted,
    summary: final,
    creditsCharged,
    balance,
    ...(spendable ? { spendable } : {}),
    before,
    after: conversationTokens(compacted),
    calls,
  };
}

/**
 * The line that replaces the gateway's advice when it refuses a conversation
 * as too long for the model and this program's `/compact` can bring it under
 * the line: the gateway does not know what a client's compaction can do, so
 * it does not name the command.
 */
export const COMPACT_ADVICE =
  "The work done so far is kept. Run /compact to summarise the conversation, this task's steps included, " +
  "then send a message to carry on. /clear starts over, and /model switches to a model that takes longer conversations.";

/**
 * The gateway's refusal with its advice line (the middle one of three)
 * replaced by `COMPACT_ADVICE`. A refusal of another shape keeps every line it
 * has and gets the advice after them.
 */
export function withCompactAdvice(refusal: string): string {
  const lines = refusal.split("\n");
  if (lines.length === 3) return [lines[0]!, COMPACT_ADVICE, lines[2]!].join("\n");
  return [...lines, COMPACT_ADVICE].join("\n");
}

/**
 * Whether `/compact` is sure to bring `messages` (system prompt first) under
 * the budget: there is more than the budget to compact, and what it would keep
 * plus a summary fits. A conversation the gateway refused while under the
 * budget is one compaction cannot help, and is not told to try it.
 */
export function compactionHelps(messages: ChatMessage[], contextTokens: number): boolean {
  const plan = planCompaction(messages, contextTokens);
  return plan !== undefined && plan.over && plan.fits;
}
