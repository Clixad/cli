/**
 * The limit valve: carrying on without Clixad's credits.
 *
 * When the free allowance and the credits run out, the agent can keep working
 * on the user's own OpenRouter key or on a model running on their own machine
 * (Ollama, LM Studio, or any OpenAI-compatible server). In both cases the
 * requests go from this machine straight to that provider. They never pass
 * through the gateway, so nothing is metered or charged there, and the
 * conversation never reaches us.
 *
 * The one thing that does reach the gateway is a count: after such a turn the
 * CLI reports how many calls and tokens it took and the model's name, and the
 * gateway adds it to a daily total that names no account (`reportExternal`).
 *
 * The key lives in `~/.clixad/config.json` (mode 0600), saved with `/key`, and
 * is sent to OpenRouter and nowhere else. Only a key saved there is used: a key
 * that happens to be in the environment belongs to whatever put it there.
 */
import { safeDetail } from "./edge.ts";
import {
  accumulateToolCall,
  mergeReasoningDetails,
  parseSSE,
  type ChatMessage,
  type ChatOptions,
  type ChatTurn,
  type ReasoningDetail,
  type ToolCall,
  type ToolCallDelta,
} from "./client.ts";

export type DirectKind = "own_key" | "local";

/** Where a turn goes when it does not go through Clixad. */
export interface DirectBackend {
  kind: DirectKind;
  /** OpenAI-compatible base URL, without `/chat/completions`. */
  baseUrl: string;
  /** Sent as a bearer token; absent for a local server that asks for none. */
  apiKey?: string;
  /** The model as that provider names it. */
  model: string;
  /** What the status line and the notices call it. */
  label: string;
  /** The window the conversation is compacted under. */
  contextTokens: number;
}

/** What the config keeps of a direct backend between sessions; the key is kept apart. */
export interface SavedDirect {
  kind: DirectKind;
  model: string;
  baseUrl?: string;
  contextTokens?: number;
}

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Local servers looked for when nothing else is configured. */
export const LOCAL_SERVERS: readonly { name: string; baseUrl: string }[] = [
  { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
];

/**
 * The window a local model is compacted under unless its server is set up for
 * more: most coding models take 32k, and a server that cuts the prompt
 * shorter (Ollama's own default is smaller; `OLLAMA_CONTEXT_LENGTH` raises it)
 * does so silently, which is why the notice says so.
 */
export const LOCAL_CONTEXT_TOKENS = 32_768;

/** How long a probe of a local server may take before it counts as not running. */
const PROBE_MS = 700;

/** The user's own OpenRouter key, as saved with `/key`. */
export function ownKeyOf(config: { ownKey?: string }): string | undefined {
  return config.ownKey?.trim() || undefined;
}

/** Whether a string looks like an OpenRouter key, for `/key`'s first check. */
export function looksLikeOpenRouterKey(value: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

/** A key shown back to its owner: enough to recognise it, never enough to use it. */
export function maskKey(key: string): string {
  const k = key.trim();
  return k.length <= 12 ? "sk-or-…" : `${k.slice(0, 9)}…${k.slice(-4)}`;
}

/** The own-key backend for a model of the catalogue, when its OpenRouter name is known. */
export function ownKeyBackend(
  key: string,
  model: { id: string; openrouter_slug?: string; context_window?: number },
): DirectBackend | undefined {
  if (!model.openrouter_slug) return undefined;
  return {
    kind: "own_key",
    baseUrl: OPENROUTER_BASE,
    apiKey: key,
    model: model.openrouter_slug,
    label: `${model.id} on your key`,
    // The window Clixad serves the model under: it keeps a long prompt below
    // the size some providers bill at a higher price, on your bill as on ours.
    contextTokens: model.context_window ?? LOCAL_CONTEXT_TOKENS,
  };
}

export function localBackend(baseUrl: string, model: string, contextTokens = LOCAL_CONTEXT_TOKENS): DirectBackend {
  return { kind: "local", baseUrl, model, label: `${model} (local)`, contextTokens };
}

/** The servers in `LOCAL_SERVERS`, plus `CLIXAD_LOCAL_URL` when set, first. */
export function localServers(env: Record<string, string | undefined> = process.env): { name: string; baseUrl: string }[] {
  const custom = env.CLIXAD_LOCAL_URL?.trim().replace(/\/+$/, "");
  return custom && /^https?:\/\//.test(custom) ? [{ name: "your server", baseUrl: custom }, ...LOCAL_SERVERS] : [...LOCAL_SERVERS];
}

/**
 * The local servers that answer, with their models. Each is asked for
 * `/models` with a short timeout, all at once; one that is not running costs a
 * refused connection and nothing else.
 */
export async function probeLocal(
  servers = localServers(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; baseUrl: string; models: string[] }[]> {
  const found = await Promise.all(
    servers.map(async (s) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_MS);
      try {
        const res = await fetchImpl(`${s.baseUrl}/models`, { signal: ac.signal });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
        return models.length ? { ...s, models } : undefined;
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return found.filter((f): f is { name: string; baseUrl: string; models: string[] } => f !== undefined);
}

/** What a direct backend used during one turn, for the meta line and the report. */
export interface DirectUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface DirectFrame {
  choices?: { delta?: { content?: string | null; tool_calls?: ToolCallDelta[]; reasoning_details?: unknown }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: unknown; code?: unknown };
}

/**
 * The agent's model client for a direct backend: the same `chatStream` the
 * gateway client has, so the agent loop, compaction, sub-agents and the
 * reviewer all run unchanged. It charges nothing and reports the balance it
 * was given, because the wallet does not move.
 */
export class DirectClient {
  private used: DirectUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(
    readonly backend: DirectBackend,
    private readonly balance: () => number,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** What this client used since the last call to this, and start counting again. */
  takeUsage(): DirectUsage {
    const u = this.used;
    this.used = { calls: 0, inputTokens: 0, outputTokens: 0 };
    return u;
  }

  async chatStream(messages: ChatMessage[], _model: string, opts: ChatOptions = {}): Promise<ChatTurn> {
    const b = this.backend;
    let res: Response;
    try {
      res = await this.fetchImpl(`${b.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {}),
          ...(b.kind === "own_key" ? { "X-Title": "Clixad" } : {}),
        },
        body: JSON.stringify({
          model: b.model,
          messages,
          ...(opts.tools ? { tools: opts.tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...(b.kind === "own_key" ? { usage: { include: true } } : {}),
        }),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted || (err as { name?: unknown })?.name === "AbortError") throw err;
      throw new Error(
        b.kind === "local"
          ? `The local model server at ${b.baseUrl} is not answering. Start it again, or /local off to go back to Clixad.`
          : `OpenRouter could not be reached (${(err as Error).message}). Nothing was charged by Clixad.`,
      );
    }
    if (!res.ok || !res.body) throw new Error(await failure(b, res));

    let content = "";
    let finishReason = "stop";
    const calls = new Map<number, ToolCall>();
    const reasoning: ReasoningDetail[] = [];
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let streamError: string | undefined;

    for await (const evt of parseSSE(res.body)) {
      if (evt === "[DONE]") break;
      let json: DirectFrame;
      try {
        json = JSON.parse(evt) as DirectFrame;
      } catch {
        continue;
      }
      if (json.error) streamError = typeof json.error.message === "string" ? safeDetail(json.error.message) : "the model stream failed";
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        content += delta;
        opts.onDelta?.(delta);
      }
      for (const [index, part] of (choice?.delta?.tool_calls ?? []).entries()) accumulateToolCall(calls, part, index);
      mergeReasoningDetails(reasoning, choice?.delta?.reasoning_details);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) usage = json.usage;
    }
    if (streamError) throw new Error(`${b.label}: ${streamError}`);

    this.used.calls += 1;
    this.used.inputTokens += usage?.prompt_tokens ?? 0;
    this.used.outputTokens += usage?.completion_tokens ?? 0;

    const message: ChatMessage = { role: "assistant", content: content || null };
    if (calls.size > 0) {
      message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (reasoning.length) message.reasoning_details = reasoning;
    }
    return { message, finishReason, creditsCharged: 0, balance: this.balance() };
  }
}

/** One sentence for a refusal, never the body as it came: a provider's HTML stays out of the terminal. */
async function failure(b: DirectBackend, res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown } | string };
      const m = typeof j.error === "string" ? j.error : j.error?.message;
      detail = typeof m === "string" ? safeDetail(m) : safeDetail(text);
    } catch {
      detail = safeDetail(text);
    }
  } catch {
    detail = "";
  }
  const tail = detail ? `: ${detail}` : "";
  if (b.kind === "own_key") {
    if (res.status === 401 || res.status === 403)
      return `OpenRouter refused your key (${res.status})${tail}. Check it with /key, or /key off to go back to Clixad.`;
    if (res.status === 402)
      return `Your OpenRouter account is out of credits (402)${tail}. Top it up at openrouter.ai, or /key off to go back to Clixad.`;
    return `OpenRouter answered ${res.status}${tail}. Nothing was charged by Clixad; /key off goes back to Clixad.`;
  }
  return `The local model server answered ${res.status}${tail}. /local off goes back to Clixad.`;
}

/** The meta line of a turn that ran without Clixad. */
export function directMeta(kind: DirectKind, used: DirectUsage): string {
  const tokens = used.inputTokens + used.outputTokens;
  const where = kind === "own_key" ? "your OpenRouter key" : "local model";
  return `[${where}${tokens > 0 ? ` · ${tokens.toLocaleString("en-US")} tokens` : ""} · no Clixad credits]`;
}

/** The backend config.json says the REPL was on, when it can still be built. */
export function savedDirectBackend(
  config: { ownKey?: string; direct?: SavedDirect },
  env: Record<string, string | undefined> = process.env,
): DirectBackend | null {
  const d = config.direct;
  if (!d || !d.model) return null;
  if (d.kind === "own_key") {
    const key = ownKeyOf(config);
    if (!key) return null;
    return { kind: "own_key", baseUrl: OPENROUTER_BASE, apiKey: key, model: d.model, label: `${d.model} on your key`, contextTokens: d.contextTokens ?? LOCAL_CONTEXT_TOKENS };
  }
  if (!d.baseUrl || !/^https?:\/\//.test(d.baseUrl)) return null;
  return localBackend(d.baseUrl, d.model, d.contextTokens ?? LOCAL_CONTEXT_TOKENS);
}

/** Said under every out-of-credits notice: the way on that needs no credits. */
export function valveLine(hasKey: boolean): string {
  return hasKey
    ? "No credits needed either: carry on with your own OpenRouter key or a local model (press enter)."
    : "No credits needed either: /key <your OpenRouter key> or a local model (Ollama, LM Studio) keeps you going.";
}

/** What the chooser's help row says. */
export const VALVE_HELP =
  "  Two ways on that use no Clixad credits:\n" +
  "  · your own OpenRouter key: /key sk-or-… saves it and carries on with the same model, billed to your OpenRouter account.\n" +
  "  · a model on your machine: start Ollama or LM Studio, then /local picks one of its models.\n" +
  "  Either way the requests go from your machine to that provider, not through us. /key off or /local off goes back to Clixad.";

/** Said when a turn starts going somewhere else. */
export function directSwitchLine(b: DirectBackend): string {
  return b.kind === "own_key"
    ? `now on your OpenRouter key: ${b.model}, billed to your OpenRouter account`
    : `now on a local model: ${b.model} at ${b.baseUrl}${
        b.contextTokens === LOCAL_CONTEXT_TOKENS ? ` (kept under ${LOCAL_CONTEXT_TOKENS.toLocaleString("en-US")} tokens; a server set to less cuts prompts short)` : ""
      }`;
}

/** Said when the REPL opens on a direct backend, so nobody runs up a bill without knowing. */
export function directStartLine(b: DirectBackend): string {
  return `${directSwitchLine(b)}. ${b.kind === "own_key" ? "/key off" : "/local off"} goes back to Clixad.`;
}
