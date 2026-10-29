/**
 * Context compaction. Every turn re-sends the whole conversation, so an
 * unmanaged context doesn't just eventually break the model — on a metered
 * product it quietly burns credits on tokens the user already paid for. When the
 * conversation approaches the model's window we replace the older turns with a
 * summary produced by the model itself.
 *
 * The cut is always at a user-message boundary: an assistant message carrying
 * `tool_calls` must keep its `tool` results, or the next request is malformed.
 */
import type { AgentClient } from "./agent.ts";
import { messageText, type ChatMessage, type Spendable } from "./client.ts";

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

const SUMMARY_PROMPT =
  "Summarise the conversation above for your future self, which will continue " +
  "the work without seeing it. Cover: what the user asked for, what was already " +
  "changed (files and the reasoning), what was learned about the codebase, and " +
  "what is still open. Be specific about file paths and names. No preamble.";

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
}

/**
 * Replace everything before the cut with one summary message. `messages[0]` (the
 * system prompt) is always kept; the summary is injected as a user message so
 * providers that allow only a leading system message stay happy.
 */
export async function compact(
  client: AgentClient,
  model: string,
  messages: ChatMessage[],
  opts: { keepTurns?: number; signal?: AbortSignal; effort?: string } = {},
): Promise<CompactResult | undefined> {
  const cut = cutPoint(messages, opts.keepTurns ?? 2);
  if (cut <= 1) return undefined;

  const before = conversationTokens(messages);
  const turn = await client.chatStream(
    [...messages.slice(0, cut), { role: "user", content: SUMMARY_PROMPT }],
    model,
    // The `/effort` setting applies to every call on the model, a summary
    // included: somebody who turned it down to save credits saves them here too.
    { signal: opts.signal, effort: opts.effort },
  );
  const summary = messageText(turn.message).trim() || "(no summary returned)";

  const compacted: ChatMessage[] = [
    messages[0]!,
    { role: "user", content: `Summary of the earlier conversation:\n\n${summary}` },
    { role: "assistant", content: "Understood — continuing from that summary." },
    ...messages.slice(cut),
  ];

  return {
    messages: compacted,
    summary,
    creditsCharged: turn.creditsCharged,
    balance: turn.balance,
    ...(turn.spendable ? { spendable: turn.spendable } : {}),
    before,
    after: conversationTokens(compacted),
  };
}
