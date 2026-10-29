/**
 * The Clixad TUI — an Ink (React-for-terminals) coding agent in the shape of
 * Claude Code: the welcome banner and finished turns are committed to <Static>
 * (they scroll away naturally), while the current turn, the input box and its
 * completion menu re-render at the bottom, so the box stays visually pinned.
 *
 * This component orchestrates and renders; the thinking lives elsewhere:
 * `agent.ts` runs the tool loop, `editor.ts` is the input's text model,
 * `permissions.ts` decides what needs approval, `compact.ts` keeps the context
 * (and the credit bill) in check, `session.ts` persists it all.
 */
// React must be in scope: `tsx`/esbuild falls back to the classic JSX transform
// (React.createElement) when it can't see a tsconfig with jsx: "react-jsx".
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, usePaste, useStdout } from "ink";
import {
  AuthError,
  LimitRefusalError,
  MaintenanceError,
  PaywallError,
  PremiumLockedError,
  accessColumn,
  parseSpendable,
  adsPerTaskLabel,
  premiumHeadline,
  premiumLocked,
  premiumUnlockHint,
  packsFromClause,
  usd,
  grantLabel,
  shortfallHeadline,
  redeemMessage,
  referLines,
  streakLabel,
  type FeedbackReport,
  type ChatMessage,
  type FreeAlternative,
  type CreditPackInfo,
  type GatewayClient,
  type ImageAttachment,
  type ImpressionReport,
  type ModelInfo,
  type PremiumAccess,
  type Spendable,
  type SponsorConfigInfo,
  type StreakInfo,
  type WalletInfo,
} from "../client.ts";
import { loadMcpConfig, McpHub } from "../mcp.ts";
import { TodoList } from "../todos.ts";
import { shells } from "../shells.ts";
import { saveConfig, saveEffort, type CliConfig } from "../config.ts";
import { preferencesInstruction, sponsorPreference, type TurnPreferences } from "../preferences.ts";
import { effortLabel, effortRaised, effortsOf, parseEffortArg, resolveEffort, savedEffort } from "../effort.ts";
import { TERMS_NOTICE, TERMS_URL, parseLoginArgs, performLogin } from "../login.ts";
import {
  compactBanner,
  MIN_BANNER_WIDTH,
  spinnerFrames,
  SPINNER_TICKS_PER_FRAME,
  visibleLength,
  welcomeBanner,
} from "../banner.ts";
import { NO_SEARCH_INSTRUCTION, runAgent, type AgentEvent } from "../agent.ts";
import { collectContext, INIT_HINT, INIT_PROMPT, shouldSuggestInit } from "../context.ts";
import { expandMentions } from "../mentions.ts";
import { compact, conversationTokens, estimateTokens, shouldCompact } from "../compact.ts";
import { estimateClause, estimateTask, taskVerdict } from "../estimate.ts";
import { freeHelpLine, freeTierNotice } from "../free-tier.ts";
import { contextTokensFor } from "../kimi.ts";
import { openBrowser } from "../browser.ts";
import { VERSION, VERSION_LABEL, isNewerVersion } from "../version.ts";
import { listWorkspaceFiles, TOOLS, type AskUserRequest } from "../tools.ts";
import {
  createPermit,
  createState,
  MODE_LABEL,
  modeInstruction,
  MODES,
  nextMode,
  switchMode,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type PlanDecision,
} from "../permissions.ts";
import { toolSchemaFor } from "../tools.ts";
import { autoModeOffered, autoModeUnavailable, pickReviewModel } from "../auto-mode.ts";
import {
  latestSession,
  listSessions,
  loadHistory,
  loadSession,
  newSessionId,
  saveHistory,
  saveSession,
  type StoredSession,
} from "../session.ts";
import { createTally, recordImpression } from "../sponsor/counter.ts";
import { adtentionSource, sponsorSource, type RemotePick, type SponsorFacts } from "../sponsor/provider.ts";
import { createSponsorSlot, type ServedLine } from "../sponsor/network.ts";
import { AD_FORMATS, EXTRA_AD_FORMATS, type AdFormat, type ExtraAdFormat } from "../sponsor/formats.ts";
import { DIRECT_ASK_TIMEOUT_MS, type DirectAnswer, type DirectLine } from "../sponsor/direct.ts";
import { hyperlinksEnabled, osc8 } from "../sponsor/hyperlink.ts";
import {
  adColorEnabled,
  adFitsFormat,
  SIDEBAR_CARD_COLS,
  sidebarCard,
  sponsorEnabled,
  sponsorRow,
  type SponsorOrigin,
  type SponsorRow,
} from "../sponsor/render.ts";
import { helpText } from "./commands.ts";
import * as ed from "./editor.ts";
import { applySuggestion, findToken, suggest, type Suggestion } from "./suggest.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  dialogInner,
  EntryView,
  entryHeight,
  errorNotice,
  fitRow,
  headRows,
  lineCount,
  MANGO,
  MANGO_BRIGHT,
  AD_MARK,
  AD_TEXT,
  MODE_STYLE,
  padColumns,
  pickHint,
  tailRows,
  type Entry,
  type NewEntry,
} from "./views.tsx";

/** The subset of Ink's `Key` the editor cares about. */
type InkKey = {
  leftArrow: boolean;
  rightArrow: boolean;
  upArrow: boolean;
  downArrow: boolean;
  backspace: boolean;
  delete: boolean;
  escape: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
};

/** What the input box says while it is locked. A model call is not the only one. */
const WORKING = "working…";
const WAITING_FOR_REWARD = "waiting for the offer…";
const LOADING = "loading…";
const COMPACTING = "compacting…";
const SIGNING_IN = "signing in…";
const RUNNING = "running…";
const SENDING_FEEDBACK = "sending…";
const WAITING_FOR_PAYMENT = "waiting for the payment…";

/**
 * How many turns pass between two feedback prompts.
 *
 * Fifty is chosen against interruption rather than against sample size. A prompt
 * is a modal that stops somebody mid-thought, and the way this feature fails is
 * not "too little data" — it is being ignored, then resented, then switched off.
 * At fifty a heavy day is asked once and a light week is not asked at all.
 *
 * The count lives in `~/.clixad/config.json` and is per **install**, not per
 * session: a session rarely reaches fifty turns while an install reaches it in a
 * week, so counted per session the prompt would exist only in the source.
 *
 * It is a plain constant rather than a figure from the gateway because
 * it is not a credit figure — it is a cadence, and the rule that keeps amounts
 * out of this program does not reach it.
 */
const FEEDBACK_TURN_INTERVAL = 50;

/**
 * What a 401 says *inside the REPL*.
 *
 * `AuthError.message` names `clixad login`, which is right for a shell and
 * wrong here: at this prompt anything without a leading slash is a prompt, so
 * typing it reached the model, hit the same 401 and printed the same
 * instruction again. Every path that can surface a 401 — a turn, and every
 * slash command routed through `runBusy` — uses this one instead.
 *
 * It also stops claiming the token is absent. It is usually present and simply
 * not valid for this gateway, which is what the config migration produces when
 * an install that was pointed at a local gateway gets moved to the hosted one.
 */
const NOT_SIGNED_IN =
  "  Not signed in, or the stored token isn't valid for this gateway.\n  Run /login to sign in.";
/** Lines of a running command's output kept on screen while it runs. */
const LIVE_OUTPUT_LINES = 5;
/** Lines of a finished tool's output committed to the scrollback. */
const COMMITTED_OUTPUT_LINES = 4;
/**
 * How long streamed text is allowed to pool before it is painted.
 *
 * A provider sends a delta per token, and every one of them used to be its own
 * `setLive` — a React render, a full layout pass and a terminal write each. The
 * frames could not keep up, so the answer arrived in lurches with several tool
 * calls already behind it. Pooling for one frame's worth turns a hundred writes
 * a second into twenty and the text moves at a readable, even pace.
 *
 * Anything that is *not* a delta flushes the buffer first (`handleEvent`), so
 * pooling can never reorder a sentence behind the tool call that followed it.
 */
const DELTA_FLUSH_MS = 50;
/**
 * An Enter this soon after other typed input is a newline inside a paste, not
 * a send.
 *
 * Bracketed paste (`usePaste`) only works where the terminal brackets the
 * paste and the bytes reach Node intact. Where they do not (Node's raw mode on
 * the Windows console, some ssh and tmux setups) a paste is raw keystrokes in
 * whatever chunks the OS reads, and every `\r` that lands in a chunk of its
 * own reads as Enter: a 25-line prompt went out as 21 separate billed turns,
 * or, delivered in one read, as nothing at all. No person presses Enter within
 * 30 ms of the key before it, and a paste does it on every line. Gemini CLI
 * settled on the same figure for the same problem.
 */
const PASTE_ENTER_MS = 30;
/**
 * Characters of collapsed tool output kept for ctrl+o, the newest first.
 *
 * Each output is the conversation's own string only until compaction drops it
 * from the conversation; from then on `outputsRef` was the one thing holding
 * it, for the rest of the session, so an agent reading files all day kept
 * every file it had read. ctrl+o walks back from the newest, so what is let go
 * is the far end, and reaching it says so.
 */
const KEPT_OUTPUT_CHARS = 2_000_000;
/** Most rows the input box itself may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 10;
/** Most picker rows shown at once; the rest scroll under the selection. */
const MAX_PICKER_ROWS = 12;
/** Queued messages shown above the box before the rest become a count. */
const MAX_QUEUE_ROWS = 3;
/** Marks a queued message. Two columns wide, which the row budget has to know. */
const QUEUE_MARKER = "⏳";
/** Marks the model already in use, in the `/model` picker. */
const PICKER_CURRENT = "  ← current";
/** A picker row keeps at least this much label before the marker is dropped. */
const MIN_PICKER_LABEL_COLS = 8;
/** Rows a modal spends on itself. They bound the frame, so they live next to it. */
// border (2) + title + subtitle + two spacers + hint + marginTop
const PICKER_CHROME = 8;
// The same without the subtitle or the spacers, for a terminal that has no room.
const PICKER_CHROME_COMPACT = 5;
// marginTop + border (2) + the hint row.
const ASK_CHROME = 4;
// marginTop + border (2) + title + spacer + hint.
const PLAN_CHROME = 6;
// marginTop + border (2) + title + spacer + the typed field + hint. One row more
// than the plan dialog, and it is the field: the answer has to stay on screen
// however short the terminal is, so it is chrome rather than part of the block
// `headRows` clips.
const BUY_CHROME = 7;
// The same without the title or the spacer, for a terminal that has no room —
// the picker's compact form, for the picker's reason. The pack and its price
// are the block's first line, so dropping the title costs nothing.
const BUY_CHROME_COMPACT = 5;
/**
 * The hint rows of the two dialogs, widest phrasing first.
 *
 * `ASK_CHROME` and `PLAN_CHROME` each budget exactly one row for these, and the
 * plan's longest form is 97 columns — wider than an 80-column terminal, so it
 * wrapped onto a row nothing had counted. They cannot simply be cut to fit
 * either: every one of them ends on `esc`, which is the way out of the dialog,
 * so a truncated tail loses precisely the key somebody stuck there needs.
 * `pickHint` takes the widest form that fits instead.
 */
export const ASK_HINT = [
  "[y/⏎] once · [a] always · [n] no · esc stops the turn",
  "y once · a always · n no · esc stops",
  "y/a/n · esc",
] as const;
export const PLAN_HINT = [
  "[y/⏎] yes, ask before edits · [a] yes, auto-accept edits · [u] yes, auto mode · [n] keep planning · esc stops the turn",
  "y ask first · a auto-accept · u auto mode · n keep planning · esc stops",
  "y/a/u/n · esc",
] as const;
/** The same, on a model auto mode is not offered on. */
export const PLAN_HINT_NO_AUTO = [
  "[y/⏎] yes, ask before edits · [a] yes, auto-accept edits · [n] keep planning · esc stops the turn",
  "y ask first · a auto-accept · n keep planning · esc stops",
  "y/a/n · esc",
] as const;
/**
 * The purchase confirmation's hint, and the word it asks for is the point.
 *
 * Every other dialog in this REPL is answered with `y`, at this same position on
 * the screen, several times an hour — approving an edit is the single most
 * practised keystroke here. This dialog opens a payment page, so it must not be
 * reachable by that reflex: it takes the typed word `yes` and enter, and there
 * is no single key that says it. Enter on its own is a refusal, `esc` is the way
 * out, and neither charges anything. It is the shape `clixad buy` had at a
 * readline prompt, kept rather than traded for consistency with the dialogs
 * either side of it.
 */
export const BUY_HINT = [
  "type yes and press ⏎ to open Stripe Checkout · esc cancels — nothing is charged either way",
  "type yes + ⏎ to continue · esc cancels — nothing is charged",
  "yes + ⏎ · esc",
] as const;
/** What the confirmation dialog takes as consent. Compared lower-cased, trimmed. */
const BUY_CONFIRM_WORD = "yes";
/** Columns the typed answer may reach. One row, and the row budget knows it. */
const BUY_TYPED_MAX = 8;

/**
 * What the buyer reads before they confirm.
 *
 * The two bullets are the declarations § 356 (5) BGB requires before digital
 * content may be delivered inside the withdrawal period, and they are the
 * reason this is a dialog rather than a picker row: they have to be *read*
 * before they can be made. They lead, ahead of the housekeeping, because
 * `headRows` clips from the bottom on a short terminal.
 *
 * No figure here is ours. The pack comes from `/v1/billing/packs`, since
 * this program cannot import the pricing engine and a price typed into this file
 * would be a literal nothing forces to agree with what Stripe is about to
 * charge.
 */
export function buyDeclarationLines(pack: CreditPackInfo): string {
  return [
    `${pack.label} — ${pack.credits.toLocaleString("en-US")} credits for $${pack.price_usd.toFixed(2)}`,
    "",
    "Before you pay, please confirm:",
    "  · You request that we deliver the credits immediately, before the 14-day withdrawal period has expired.",
    "  · You acknowledge that your right of withdrawal lapses once they have been delivered.",
  ].join("\n");
}

/** The rest: true, useful, and clippable. */
export function buyConfirmLines(pack: CreditPackInfo): string {
  return [
    buyDeclarationLines(pack),
    "",
    "One purchase. No subscription, nothing to cancel.",
    `Terms: ${TERMS_URL}`,
  ].join("\n");
}

/**
 * What the dialog says instead, on a terminal too short to hold the
 * declarations — and it is a refusal rather than a smaller dialog.
 *
 * Everything else in this file clips: a diff loses its tail, a plan loses its
 * end, a streamed answer keeps only what fits. None of those change what the
 * user is agreeing to. These two sentences are the thing being agreed to, so a
 * confirmation that showed half of one would be a declaration taken from
 * somebody who was never shown it, which is the whole of what § 356 (5) asks
 * us to get right. `yes` is refused while this is on screen.
 */
const BUY_TOO_SHORT =
  "Make this terminal taller — the confirmation has to be readable before you can agree to it.";
/**
 * Ceiling on one ctrl+o expansion. `read_file` may return 400 kB, and dumping
 * ten thousand rows into <Static> is one yoga layout nobody asked for; the
 * remainder is counted on screen rather than silently dropped.
 */
const EXPAND_MAX_LINES = 400;

/** Fallbacks for a stdout that reports no size — a pipe, or a very odd terminal. */
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;

/** The UTC day, YYYY-MM-DD: the day every daily limit on credits is counted in. */
function utcDay(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The terminal size, read from **ink's own stdout** at render time.
 *
 * Three things here were each a bug on their own.
 *
 * It read `process.stdout` rather than the stream ink was handed. Those are the
 * same object in production, which is why it worked, but it is the wrong one on
 * principle and it makes the failure below untestable — a test that gives ink a
 * terminal of its own has two streams disagreeing about how big the screen is.
 *
 * It kept the size in `useState`. **Ink's resize handler does not re-run React
 * components**: it recalculates the yoga layout for the elements already in the
 * tree and paints them, synchronously and unthrottled, from a handler it
 * registered in its own constructor. So the `<Box height={spacer} />` this
 * component last returned was painted at its old height into the new terminal.
 * Shrinking in one step drew a frame ink then could not erase, so it cleared
 * the screen and replayed every static line of the session — at the width those
 * lines were written. That is the doubled rows and broken box borders you get
 * from dragging a VS Code panel.
 *
 * And it subscribed with `on`, which puts it after ink's handler; it uses
 * `prependListener` now so the re-render is at least scheduled before ink
 * paints. **That does not remove ink's stale paint**, and it is worth being
 * precise about why, because it bounds what any of this can achieve: React does
 * not flush a store-driven render inside a Node event handler before that
 * handler's other listeners run, so the first frame after a resize is still the
 * previous tree measured against the new terminal. It is corrected on the next
 * render, milliseconds later. What changed is that the *settled* frame is now
 * right, and that a gradual drag — where each step is small enough that the
 * previous frame still fits — never overflows at all. A single repaint after a
 * large jump is inherent: the frame that was on screen is taller than the
 * terminal that now exists, and ink has to start over whatever we draw next.
 *
 * The snapshot object is cached in a ref and replaced only when a dimension
 * actually changes: `useSyncExternalStore` compares snapshots with `Object.is`,
 * and a fresh object on every call is an infinite render loop.
 */
function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const snapshot = useRef({
    rows: stdout.rows ?? FALLBACK_ROWS,
    cols: stdout.columns ?? FALLBACK_COLS,
  });

  const subscribe = useCallback(
    (onChange: () => void) => {
      stdout.prependListener("resize", onChange);
      return () => {
        stdout.off("resize", onChange);
      };
    },
    [stdout],
  );

  const getSnapshot = useCallback(() => {
    const rows = stdout.rows ?? FALLBACK_ROWS;
    const cols = stdout.columns ?? FALLBACK_COLS;
    if (rows !== snapshot.current.rows || cols !== snapshot.current.cols) {
      snapshot.current = { rows, cols };
    }
    return snapshot.current;
  }, [stdout]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface AppProps {
  client: GatewayClient;
  config: CliConfig;
  /**
   * Anything `loadConfig` had to say about the config file, from
   * `takeConfigNotices`.
   *
   * A prop rather than a call here for `streak`'s reason: `main.ts` reads the
   * config long before this component exists, and the notices belong to that
   * read. They are drawn before the context and streak lines because they
   * explain a session that has started signed out, which is the first thing the
   * user is about to notice on their own.
   */
  notices?: string[] | undefined;
  wallet?: WalletInfo | undefined;
  /**
   * Today's login streak, already claimed by `main.ts` before the wallet was
   * read — so the balance in the banner includes it.
   *
   * A prop rather than a fetch on mount for that ordering alone: claiming here
   * would mean the banner draws a balance that is one grant out of date and then
   * a notice contradicting it two frames later.
   */
  streak?: StreakInfo | null | undefined;
  /** Conversation to pick up (`--continue` / `--resume`). */
  session?: StoredSession | undefined;
  /**
   * The account's preferences, already brought into line with
   * config.json by `syncPreferences` in `main.ts`: the name and instructions
   * every turn tells the model, and the account's "off" for the sponsored line.
   */
  preferences?: TurnPreferences | undefined;
  /**
   * The account was created by the sign-in that opened this REPL. The banner
   * greeted everybody with a name as "Welcome back", including somebody who
   * had signed up four seconds earlier.
   */
  newAccount?: boolean | undefined;
  /** Task to run immediately, e.g. `clixad agent "…"`. */
  initialTask?: string | undefined;
  /**
   * Serve a sponsored line, instead of building an ADtention slot from the
   * gateway's configuration.
   *
   * A seam, for one property that has no other alarm: an impression is recorded
   * when the line is painted and reported only once the turn is **over**, and
   * getting that backwards is invisible everywhere except in production. It
   * shipped backwards once: the report fired before the model call had been
   * settled, so no impression could ever credit. Driving it needs a served line,
   * and a served line needs a network, so the network is what a test replaces.
   */
  sponsorServe?:
    | ((cols: number, signal?: AbortSignal, format?: AdFormat) => Promise<ServedLine | null>)
    | undefined;
  /**
   * The extra formats a gateway would hand out, for a test driving
   * `sponsorServe`. Without it the seam serves the top bar alone — which is
   * what every test written before there were three formats means, and what a
   * gateway with the switch off answers.
   */
  sponsorFormats?: readonly ExtraAdFormat[] | undefined;
  /**
   * Ask for booked lines, instead of `client.directSponsor`. A seam for the
   * same reason as `sponsorServe`: the gateway answers "nothing booked" until
   * the first week is sold, so a booked line, a hold, and their reports are
   * only reachable from a test through here.
   */
  sponsorDirect?: ((formats: readonly AdFormat[], cols: number, signal?: AbortSignal) => Promise<DirectAnswer>) | undefined;
  /**
   * Whether to suggest `/init` in this session, decided by `main.ts`.
   *
   * Absent means never, which is what every test that does not pass it gets:
   * the question depends on the filesystem (is there a `CLIXAD.md`, has anyone
   * worked here before) and a test run's working directory and saved sessions
   * are not something a render should depend on. `returning` means a session
   * was saved in this directory before, and the hint is said as the REPL
   * opens. Otherwise it waits for `INIT_HINT_AFTER_TURNS` finished turns, so a
   * first session that turned into real work ends up with a file before the
   * second one begins.
   */
  initHint?: { returning: boolean } | undefined;
}

/** Finished turns in one session before `/init` is suggested to a newcomer. */
const INIT_HINT_AFTER_TURNS = 3;

/** What the current turn is showing below the committed scrollback. */
interface Live {
  text: string;
  tool?: { name: string; summary: string; output: string };
}

/** One row of a modal picker (today: `/model`). */
interface PickerItem {
  value: string;
  label: string;
  hint: string;
  /** Marked as the active choice, so switching back is obvious. */
  current?: boolean;
}

/**
 * The paywall chooser's "earn credits instead" row.
 *
 * A sentinel in `value` rather than a new field on `PickerItem`, because every
 * other row in that picker carries a model id and this one has to be told apart
 * from them by the same code that reads them. Prefixed with a character no
 * OpenAI-compatible model id may contain (`[A-Za-z0-9_.\/-]` in practice), and
 * the list is filtered against it anyway before the row is appended — a gateway
 * is free to name its models whatever it likes, and this must not become a way
 * for one of them to impersonate the wall.
 */
const EARN_ROW = "\u0000earn";

/** The premium chooser's "buy a pack" row, `EARN_ROW`'s rule for `EARN_ROW`'s reason. */
const BUY_ROW = "\u0000buy";

interface Picker {
  title: string;
  subtitle: string;
  items: PickerItem[];
  onPick: (item: PickerItem) => void;
  /**
   * Called when esc closes it without a choice.
   *
   * Optional because `/model` and `/resume` have nothing to tell: closing them
   * is the end of it. It is *required in practice* for `ask_user`, where a turn
   * is awaiting the answer — a picker that closed without settling that promise
   * would leave the agent waiting on something nobody will ever resolve.
   */
  onCancel?: () => void;
}

export function App({
  client,
  config,
  wallet,
  streak,
  session,
  newAccount,
  initialTask,
  notices,
  sponsorServe,
  sponsorFormats,
  sponsorDirect,
  initHint,
  preferences,
}: AppProps) {
  const { exit } = useApp();
  // The account's name and instructions, said to the model on every turn.
  const preferencesText = preferencesInstruction(preferences);
  // Ink's own writer: it erases the live frame, emits the string, and repaints.
  // Writing an escape straight to `process.stdout` instead would leave ink
  // erasing lines that are no longer where it thinks they are.
  const { stdout, write: writeToStdout } = useStdout();
  const idRef = useRef(1);
  const { rows, cols } = useTerminalSize();
  const root = process.cwd();

  const [entries, setEntries] = useState<Entry[]>(() => [
    {
      id: 0,
      kind: "banner",
      // The width ink is actually laying out against. Read once, because a
      // committed <Static> line is written to the scrollback and belongs to the
      // terminal from then on — but "once" now means the width at mount rather
      // than whatever `process.stdout` happened to say.
      text: (cols >= MIN_BANNER_WIDTH ? welcomeBanner : compactBanner)({
        width: cols,
        name: config.login ?? config.email?.split("@")[0],
        ...(newAccount ? { newAccount: true } : {}),
        model: config.model,
        // Undefined when the wallet could not be read: the banner says so
        // rather than drawing "0 credits", which reads as an empty account.
        balance: wallet?.balance,
        adsToday: wallet?.ads_today ?? 0,
        earnedUsdToday: wallet?.earned_usd_today ?? 0,
        maxRewardUsd: wallet?.max_reward_usd_per_day ?? 0,
        cwd: process.cwd(),
        version: VERSION_LABEL,
      }),
    },
  ]);

  // Bumping this remounts <Static>, which is how the scrollback is actually
  // discarded: ink keeps every static line it has emitted in `fullStaticOutput`
  // and replays it on a full repaint, so dropping the entries alone would leave
  // a cleared screen that refills itself on the next resize.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(session?.messages ?? []);
  const [editor, setEditorState] = useState<ed.EditorState>(ed.EMPTY);
  /**
   * The editor as the key handler must see it: every change so far, rendered
   * or not.
   *
   * ink hands `useInput` every event of one stdin read before React renders
   * once, so a handler reading the render's `editor` built each event on the
   * same stale state. A paste that arrived in two chunks kept only the second
   * (842 of 1,867 characters reached the model), and an Enter right behind
   * typed text sent what was on screen a frame ago. State is for what is
   * drawn, this ref for what the next keystroke edits: `modelRef`'s rule.
   */
  const editorRef = useRef<ed.EditorState>(ed.EMPTY);
  const setEditor = useCallback((next: ed.EditorState | ((state: ed.EditorState) => ed.EditorState)) => {
    const value = typeof next === "function" ? next(editorRef.current) : next;
    editorRef.current = value;
    setEditorState(value);
  }, []);
  /** When the editor last took typed or pasted text; see `PASTE_ENTER_MS`. */
  const lastTextAtRef = useRef(0);
  /**
   * An Enter that will send once `PASTE_ENTER_MS` passes with nothing behind
   * it. The gap *before* an Enter can outgrow the window when a render lands
   * between two reads of one paste; the gap after it cannot, because the rest
   * of a paste is already waiting in the input buffer. So any input in that
   * window turns it back into the newline it was.
   */
  const pendingSendRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingSendRef.current), []);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  /**
   * The balance, or undefined while it has not been read.
   *
   * Unknown is not zero. It was `wallet?.balance ?? 0`, so a REPL opened while
   * the gateway was unreachable said "0 cr" under the input box, which is the
   * one thing on that screen that looks like the account has been emptied.
   */
  const [balance, setBalance] = useState<number | undefined>(wallet?.balance);
  const [spent, setSpent] = useState(0);
  /**
   * What is left of today's free allowance, and what it buys per model.
   *
   * Seeded from the wallet read at startup and moved by every free call's
   * `usage` event, so the status line stays current without a request per turn.
   * `turns_left` is only refreshed by a wallet read, which is why `/model`
   * takes one before it opens the picker — that is the moment the estimates are
   * actually looked at.
   *
   * `undefined` means this gateway said nothing about a free tier, which is not
   * the same as an empty allowance: nothing free is advertised at all.
   */
  const [freeTier, setFreeTier] = useState(wallet?.free_tier);
  const [model, setModel] = useState(config.model);
  /**
   * The `/effort` setting per model, for what is drawn. A turn reads it from
   * `config` at the moment it starts (`savedEffort`), which `saveEffort` has
   * already updated in the same tick, so the ref dance `modelRef` needs is not
   * needed here.
   */
  const [effortBy, setEffortBy] = useState<Record<string, string>>(() => config.effort ?? {});
  /**
   * The model a turn about to start will use.
   *
   * A ref beside the state, and `switchModel` is the only thing that writes
   * either — `runSerially`'s rule for `runSerially`'s reason. A turn started in
   * the same tick as a `setModel` reads the render's `model`, which is still the
   * old one, because React has not re-rendered yet. That is exactly what the
   * paywall's "switch and carry on" does: it picks a free model and immediately
   * re-runs the interrupted request, and against the state it re-ran that
   * request on the model that had just been refused — a second 402, from the
   * keystroke whose whole purpose was to avoid one.
   *
   * State stays for what is *drawn* (the status line, the picker's current row);
   * the ref is what a turn reads.
   */
  const modelRef = useRef(config.model);
  const [mode, setMode] = useState<PermissionMode>("normal");
  /** Move the model: the ref first, so a turn started in this tick sees it. */
  const switchModel = useCallback((id: string) => {
    modelRef.current = id;
    setModel(id);
    // Auto mode belongs to the models it is offered on. Leaving it on across a
    // switch to one of the others would have that model judge its own
    // commands, which is the thing the catalog decided it should not do.
    if (permRef.current.mode === "auto" && !autoModeOffered(catalogRef.current, id)) {
      switchMode(permRef.current, "normal");
      setMode("normal");
      push({ kind: "notice", tone: "warn", text: `  ${autoModeUnavailable(catalogRef.current, id)} · mode → ${MODE_LABEL.normal}` });
    }
    // Kept with the account too, so the browser's chat starts on it. Not
    // awaited, and it never throws: config.json has it whatever the gateway says.
    void client.saveSettings?.({ model: id });
  }, [client]);
  const [hist, setHist] = useState<string[]>(() => loadHistory());
  const [histIdx, setHistIdx] = useState(-1);
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const [ask, setAsk] = useState<{ req: PermissionRequest; resolve: (a: PermissionAnswer) => void } | null>(null);
  // A plan the model has put up for approval. Its own modal rather than a
  // variant of `ask`: it approves a *mode*, not one call, and the answers are
  // different — the two ways to say yes are the two modes to land in.
  const [plan, setPlan] = useState<{ plan: string; resolve: (d: PlanDecision) => void } | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pickerSel, setPickerSel] = useState(0);
  /**
   * A credit pack waiting to be confirmed, and what has been typed at it.
   *
   * Its own modal rather than a third `Picker` row, because what it puts on
   * screen is two declarations that have to be *read* before they are made —
   * § 356 (5) BGB — and a picker row is a label and a hint. The typed answer
   * lives in the same state so closing the dialog cannot leave a half-typed
   * word behind for the next one.
   */
  const [buy, setBuy] = useState<{ pack: CreditPackInfo; typed: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [quitHint, setQuitHint] = useState(false);
  // What the input box says while `busy`. The ad-wall wait is not a model call
  // and can last five minutes, so it must not sit behind the word "working".
  const [busyLabel, setBusyLabel] = useState(WORKING);
  // The sponsored line for the call in flight — ours, or the network's once it
  // answers. Null whenever nothing is being shown: gated off, nothing
  // resolvable, or no model call running.
  // The line, **with where it came from**. The origin is carried rather than
  // inferred, because it is what decides whether the row is marked as an
  // advertisement, and nothing about the text itself can stand in for it: our
  // own copy that happens to read like an ad is still ours, and an ad written
  // to read like a usage tip is still an ad.
  //
  // A network line also carries its impression id, which is how the render
  // says it was actually drawn (`drawnRef`) — the only thing that makes it
  // reportable.
  const [sponsor, setSponsor] = useState<{ text: string; origin: SponsorOrigin; impressionId?: string; link?: string } | null>(
    null,
  );
  // The other two formats. Network only — there is no house card and no house
  // status bar, so an empty slot is simply not drawn — and, like the top bar,
  // only for the model call they were fetched for.
  const [adSlots, setAdSlots] = useState<Partial<Record<ExtraAdFormat, { text: string; impressionId: string; link?: string }>>>(
    {},
  );

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Whether the keyboard's owner is mid-turn. A ref, because `submit` decides
  // between running and queueing at the moment a key is pressed, and a captured
  // `busy` from an earlier render would decide it wrong.
  const busyRef = useRef(false);
  busyRef.current = busy;
  /**
   * Messages typed while a turn was running.
   *
   * The ref is the queue; the state is only what is drawn. Two copies because
   * the drain loop takes the next item and immediately needs the one after it,
   * and a state array does not update until the next render — reading it there
   * would hand out the same message twice.
   */
  const queueRef = useRef<string[]>([]);
  const [queueView, setQueueView] = useState<string[]>([]);
  const permRef = useRef(createState("normal"));
  const abortRef = useRef<AbortController | null>(null);
  // The controller for everything else that holds the keyboard: the /earn wait
  // and the slash commands that await the gateway. `busy` is set by more than the
  // agent loop, so esc has to reach whichever one is running — see `stopCurrent`.
  const busyAbortRef = useRef<AbortController | null>(null);
  const filesRef = useRef<string[] | null>(null);
  const ctrlCRef = useRef(0);
  /**
   * The conversation being written to disk: its id, when it started, and what
   * it is called.
   *
   * The **title belongs here** and not to the `session` prop, which is the
   * conversation the REPL happened to open with and never changes again.
   * Reading the prop meant three wrong titles at once. A fresh session had no
   * prop title, so every turn overwrote the file's title with the message just
   * typed — `/resume` listed conversations by their *last* line, where
   * `StoredSession.title` promises the first. And once there *was* a prop
   * title it outlived everything: `/clear` mints a new id here, so the brand
   * new conversation was filed under the resumed one's name, and `/resume`
   * showed two unrelated sessions called the same thing with no way to tell
   * them apart. Keeping the title next to the id is what makes it move when —
   * and only when — the id does.
   */
  const sessionRef = useRef<{ id: string; started: string; title?: string }>(
    session ?? { id: newSessionId(), started: new Date().toISOString() },
  );
  // When this run began, as opposed to when a resumed conversation first started.
  // The burn rate divides by elapsed minutes, so using the session's original
  // start made a conversation resumed a day later report ~0 cr/min forever.
  const runStartedAtRef = useRef(Date.now());
  const contextRef = useRef(collectContext(root));
  const catalogRef = useRef<ModelInfo[]>([]);
  /**
   * Bumped when the catalog first arrives. The ref is what callbacks read; this
   * is what makes the status line draw again, since which kind of model is in
   * use (budget or premium) decides which usable figure it shows.
   */
  const [, setCatalogArrived] = useState(0);
  /**
   * Whether this gateway can actually search, recorded when the catalog lands.
   *
   * Read here rather than at every turn so there is one place it can be absent:
   * a gateway that predates the flag, a catalog fetch that failed, or a client
   * that does not implement it at all. All three mean the same thing — no
   * search — and the default is off for the reason in `GatewayCapabilities`.
   */
  const searchRef = useRef(false);
  /**
   * Full output of every committed tool call that had more to show, in the
   * order they happened, so ctrl+o can keep the promise the "… +N lines
   * (ctrl+o)" label makes. It used to be a single string — the most recent
   * result — while *every* collapsed entry advertised the shortcut, so all but
   * one of those labels were unreachable. Storing the same string the
   * conversation already holds costs a pointer, not a copy, until compaction
   * drops it from the conversation: hence `KEPT_OUTPUT_CHARS`.
   */
  const outputsRef = useRef<{ id: number; label: string; output: string }[]>([]);
  const keptOutputCharsRef = useRef(0);
  /** Whether `KEPT_OUTPUT_CHARS` has let any output go, so ctrl+o can say why it stops. */
  const droppedOutputsRef = useRef(false);
  const expandedRef = useRef(new Set<number>());
  const keepOutput = useCallback((kept: { id: number; label: string; output: string }) => {
    const outputs = outputsRef.current;
    outputs.push(kept);
    keptOutputCharsRef.current += kept.output.length;
    // The newest stays whatever its size: it is the one ctrl+o opens first.
    while (keptOutputCharsRef.current > KEPT_OUTPUT_CHARS && outputs.length > 1) {
      const gone = outputs.shift()!;
      keptOutputCharsRef.current -= gone.output.length;
      expandedRef.current.delete(gone.id);
      droppedOutputsRef.current = true;
    }
  }, []);
  /** The picker's visible slice, for the 1-9 shortcut. Written during render. */
  const pickerWindowRef = useRef({ from: 0, count: 0 });
  /** Whether the purchase dialog got its declarations on screen. Written during render. */
  const buyFitsRef = useRef(false);
  // Resolved once: TERM does not change under a running process, and asking
  // per frame would be two string comparisons eight times a second.
  const spinnerRef = useRef(spinnerFrames());
  const runningToolRef = useRef<{ name: string; summary: string } | null>(null);
  // The task the paywall interrupted, with whatever was attached to it. The
  // images travel with it because a retry that silently dropped the screenshot
  // the question was about would answer a different question.
  const pendingTaskRef = useRef<{ task: string; images: ImageAttachment[] } | null>(null);
  /**
   * What the gateway said was free at the moment the paywall fired.
   *
   * Held beside the interrupted task and cleared with it, because it is only
   * true *of that refusal*: the allowance moves, the global budget moves, and a
   * list kept past the turn it arrived with would offer a switch the next 402
   * has already stopped offering. A ref rather than state for the same reason
   * `pendingTaskRef` is one — nothing on screen depends on it between the notice
   * that announces it and the key that spends it.
   */
  const pendingFreeRef = useRef<FreeAlternative[]>([]);
  /** What an offer paid according to the last refusal — the wall row's figure. */
  const pendingGrantRef = useRef(0);
  /** The balance the refusal reported, so the chooser can say "not enough" rather than "out". */
  const pendingBalanceRef = useRef<number | undefined>(undefined);
  /**
   * The premium refusal the interrupted task met, when that is what it met.
   *
   * Set beside `pendingTaskRef` and cleared with it, for `pendingFreeRef`'s
   * reason: its figures are true of that refusal only. While it is set, enter
   * opens the premium chooser rather than the paywall's, since the wallet may
   * be full of bonus credits and every sentence the paywall says would be
   * wrong about it.
   */
  const pendingPremiumRef = useRef<PremiumLockedError | null>(null);
  /**
   * Whether premium models are open to this account, and what a premium call
   * may spend: state, since the cost preview draws from it, with a ref beside
   * it for the callbacks that read it (`runSerially`'s rule). Read when the REPL
   * opens and whenever `/model` opens, moved down by every paid turn, and read
   * again once credits land from `/earn` or `/buy`. Undefined until read, and
   * after a read that failed: unknown is never shown as locked.
   */
  const [premium, setPremiumState] = useState<PremiumAccess | undefined>(wallet?.premium);
  const premiumRef = useRef<PremiumAccess | undefined>(wallet?.premium);
  const setPremium = useCallback((next: PremiumAccess | undefined) => {
    premiumRef.current = next;
    setPremiumState(next);
  }, []);
  /** Re-read premium access off the path of anything waiting, after credits landed. */
  const refreshPremium = useCallback(() => {
    void client
      .wallet(undefined, { premium: true })
      .then((w) => setPremium(w.premium))
      .catch(() => undefined);
  }, [client, setPremium]);
  /**
   * What one call may spend right now on a budget and on a premium model
   * (2026-10-12), with the balance the gateway worked it out from and the UTC
   * day it arrived on. The status line shows the figure for the model in use
   * in place of the bare balance whenever some of the balance is held back.
   *
   * **It is shown only while it belongs to the balance on screen**, and that is
   * what keeps it from ever being wrong: the figures arrive with the balance
   * they were computed from (the wallet, the end of every paid call, every
   * refusal), and the moment the balance moves without them (a free call after
   * a web search, credits from `/earn`, another session spending the same
   * wallet) or the UTC day turns, the row falls back to the bare balance and
   * one wallet read fetches figures that fit (`refreshSpendable`).
   */
  const initialSpendable = useMemo(() => {
    const figures = parseSpendable(wallet?.spendable);
    return figures && wallet ? { figures, balance: wallet.balance, day: utcDay() } : undefined;
    // The startup wallet only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [spendable, setSpendableState] = useState(initialSpendable);
  const spendableRef = useRef(initialSpendable);
  /**
   * Take figures that arrived with `balance`: the balance, the figures, and
   * premium access's credit count, which is the same figure the `/model` column
   * and the cost preview read. `premiumRef`'s own arithmetic (whatever a turn
   * charged came off it) is only the fallback for a gateway that sends none: a
   * budget call spends bonus credits that are not the streak allowance's, and
   * that arithmetic took them off premium all the same.
   */
  const takeSpendable = useCallback(
    (figures: Spendable, balance: number) => {
      const next = { figures, balance, day: utcDay() };
      spendableRef.current = next;
      setSpendableState(next);
      setBalance(balance);
      const p = premiumRef.current;
      if (p) setPremium({ ...p, credits: figures.premium });
    },
    [setPremium],
  );
  /**
   * Counts every balance a model call or a refusal reported, so a wallet read
   * that was already on its way when one arrived is dropped rather than
   * painting an older balance over it.
   */
  const balanceSeqRef = useRef(0);
  const spendableInFlightRef = useRef(false);
  /** The balance and day the last read for figures was asked for, so one that brings none is not asked again. */
  const spendableAskedRef = useRef<string | null>(null);
  const refreshSpendable = useCallback(() => {
    if (spendableInFlightRef.current) return;
    spendableInFlightRef.current = true;
    const seq = balanceSeqRef.current;
    void client
      .wallet(undefined, { premium: true })
      .then((w) => {
        if (balanceSeqRef.current !== seq) return;
        const figures = parseSpendable(w.spendable);
        if (figures) takeSpendable(figures, w.balance);
        else setBalance(w.balance);
        if (w.premium) setPremium(w.premium);
      })
      .catch(() => undefined)
      .finally(() => {
        spendableInFlightRef.current = false;
      });
  }, [client, setPremium, takeSpendable]);
  /**
   * Bumped at 00:00 UTC, when the personal limit and the streak allowance
   * reset, so figures from yesterday stop being shown and new ones are read.
   */
  const [dayTick, setDayTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const next = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1,
    );
    const timer = setTimeout(() => setDayTick((t) => t + 1), next - now + 1_000);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [dayTick]);
  /**
   * MCP servers, connected in the background after mount.
   *
   * A ref rather than state: it is read when a turn asks for the tool schema,
   * and nothing on screen depends on it changing. Starts empty so every path
   * works before (and without) a config.
   */
  const mcpRef = useRef<McpHub>(McpHub.empty());
  /** The session's task list. Survives turns; cleared with the context. */
  const todosRef = useRef(new TodoList());
  /**
   * The last turn that could be rated, and how many have run on this install.
   *
   * A ref rather than state because nothing on screen depends on either, and the
   * count is read the instant a turn finishes — a state value would still be the
   * previous render's. The exchange is kept whole (what was asked, what came
   * back) because a rating with nothing attached to it is a number nobody can act
   * on: the point of collecting this is an eval set, and an eval needs the input
   * and the output.
   *
   * Cleared on `/clear` along with the conversation: a rating is about an
   * exchange, and once the exchange is gone there is nothing to rate.
   */
  const lastTurnRef = useRef<Omit<FeedbackReport, "session" | "rating"> | null>(null);
  /** Once per session: the free allowance ran out and turns now cost credits. */
  const freeSpentNoticeRef = useRef(false);
  /** Once per session: a paid turn emptied the balance. */
  const emptyNoticeRef = useRef(false);
  /** Once per session: `/init` was suggested, or run. */
  const initHintedRef = useRef(false);
  /** Turns finished in this session, for when to suggest `/init`. */
  const sessionTurnsRef = useRef(0);
  const turnCountRef = useRef(config.turns ?? 0);
  // Streamed text waiting to be painted, and the timer that will paint it.
  // See DELTA_FLUSH_MS: a render per token is what made the output lurch.
  const deltaBufRef = useRef("");
  const deltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sponsored line state. The counter is the rotation — one step per model call,
  // never per render — and `prev` is the only rule it obeys.
  const sponsorRef = useRef(sponsorSource());
  const sponsorIdxRef = useRef(0);
  const sponsorPrevRef = useRef<string | undefined>(undefined);
  // Which model call the line on screen belongs to. A network line arrives a few
  // hundred milliseconds after the house line is painted, by which time the turn
  // may have ended or a queued one may have started — and a late answer painted
  // onto either is an ad appearing over a finished conversation. Every fill is
  // stamped with the counter it was asked for and dropped if that has moved.
  const sponsorCallRef = useRef(0);
  // The impression for each network line currently on screen, stamped with the
  // call it belongs to, waiting for that turn to finish. One per format, since
  // each slot is filled and reported on its own. See `reportSponsor`.
  const pendingImpressionRef = useRef(new Map<AdFormat, { call: number; impression: ImpressionReport }>());
  // The booked line drawn in each slot this turn, the same three moments as a
  // network line: held when painted, reported when the turn is over, and only
  // if `drawnRef` saw it. `drawnId` is what the frame records it under.
  const pendingDirectRef = useRef(new Map<AdFormat, { call: number; serveToken: string; drawnId: string }>());
  // False once a gateway has answered 404 to the ask: an older gateway that
  // will not know the route for the rest of this session either.
  const directSupportedRef = useRef(true);
  // The slots a successful ask said were booked (a line or a hold), most
  // recently. When an ask fails, ADtention is still asked for every other
  // slot but not for these: a slot somebody paid to have alone this week
  // must not show somebody else's ad because one request timed out.
  const knownBookedRef = useRef(new Set<AdFormat>());
  // The impression ids the render has actually put on screen this turn.
  //
  // Filled from an effect, i.e. after a commit, never from the fill: a line can
  // arrive and still not be drawn — a dialog opened, the rows ran out, the turn
  // ended in the same tick — and an impression that was never on a screen is
  // the one thing this slot must not report. With one slot the fill's own width
  // check was close enough; with three, each with its own conditions, the only
  // honest witness is the frame.
  const drawnRef = useRef(new Set<string>());
  // The network provider. Held in a ref for the reason the house source is:
  // `nextSponsor` is a callback with its own dependency list, and a source
  // rebuilt on every render would be a new object in it every time.
  //
  // The serve happens **here**, in this process, against ADtention directly,
  // because their SDK is built for client-side serving. What the gateway still
  // owns is the account (the
  // publisher id and the subject arrive from `/v1/sponsor/config`) and the money
  // (it decides what an impression is worth and whether to credit it). See
  // `sponsor/network.ts`.
  //
  // The slot is built lazily on the first model call rather than at mount, so a
  // session that never runs one — `/help`, `/wallet`, a mistyped command and an
  // exit — makes no request to an ad network at all.
  //
  // One slot per format: each is its own publisher id with its own dwell cache.
  const sponsorSlotRef = useRef(
    new Map<AdFormat, { serve(cols: number, signal?: AbortSignal): Promise<ServedLine | null> }>(),
  );
  /**
   * The terminal width, readable from a closure that was built at mount.
   *
   * The fetcher below lives in a `useRef` initialiser, so it captures the first
   * render's scope and keeps it for the session — a `cols` read there would be
   * the width the terminal had when the REPL opened, forever. The serve gate
   * and the fill check both have to see the width the terminal has *now*, so
   * they go through this.
   */
  const colsRef = useRef(cols);
  colsRef.current = cols;
  /**
   * Whether a dialog is on screen, for a fill that lands while one is.
   *
   * Written by the render, read by the fill — `buyFitsRef`'s shape. The two
   * newer slots are not drawn beside a dialog, so a line for one that arrives
   * while a dialog is up has nowhere to go, and is dropped exactly as a line
   * that arrives too wide is: not held, never drawn, never reported.
   */
  const modalOpenRef = useRef(false);
  const sponsorConfigRef = useRef<Promise<SponsorConfigInfo | null> | null>(null);
  /**
   * Serve one format, or `null` when this session does not serve it.
   *
   * A format is served only when the gateway handed out a publisher for it —
   * the top bar whenever there is a publisher at all, the other two only while
   * the gateway's switch lists them. Nothing here decides that a format is on:
   * a CLI that could switch one on would be a CLI that decides when an
   * advertisement appears, and that belongs to the deployment.
   */
  const serveFormat = async (format: AdFormat, signal?: AbortSignal): Promise<RemotePick | null> => {
    // One fetch per session, memoised as the *promise* rather than the result:
    // two model calls can start close enough together that the second would
    // otherwise ask again before the first has answered — and three formats
    // start together every time.
    let served: ServedLine | null;
    if (sponsorServe) {
      if (format !== "top_bar" && !sponsorFormats?.includes(format)) return null;
      served = await sponsorServe(colsRef.current, signal, format);
    } else {
      sponsorConfigRef.current ??= client.sponsorConfig(signal);
      const conf = await sponsorConfigRef.current;
      if (!conf) return null;
      const publisherId = format === "top_bar" ? conf.publisherId : conf.formats?.[format];
      if (!publisherId) return null;
      let slot = sponsorSlotRef.current.get(format);
      if (!slot) {
        // The format's own publisher, and everything else shared: one subject,
        // one category, one dwell. The subject is the gateway's, already
        // hashed — the same person behind all three, which is what ADtention
        // is supposed to see.
        slot = createSponsorSlot({ ...conf, publisherId }, format);
        sponsorSlotRef.current.set(format, slot);
      }
      served = await slot.serve(colsRef.current, signal);
    }
    if (!served) return null;
    return {
      id: served.id,
      text: served.text,
      impression: {
        impressionId: served.impressionId,
        ...(format === "top_bar" ? {} : { format }),
        adId: served.id,
        billable: served.billable,
        fromCache: served.fromCache,
        credit: served.credit,
      },
    };
  };
  // `adtentionSource` per format, for its one guarantee: a fetch that never
  // rejects. Built once, in a ref, for the house source's reason.
  const remoteSponsorRef = useRef(
    Object.fromEntries(
      (["top_bar", ...EXTRA_AD_FORMATS] as const).map((format) => [
        format,
        adtentionSource((signal) => serveFormat(format, signal)),
      ]),
    ) as Record<AdFormat, ReturnType<typeof adtentionSource>>,
  );
  const tallyRef = useRef(createTally());
  // Rendered height per committed entry at the current width. The layout
  // reduce walks every entry there has ever been, and `entryHeight` re-renders
  // markdown, so without this the cost of placing one new row grows with the
  // length of the conversation. Only one width is kept: keyed by id *and*
  // width, every column a resize drag passed through stayed in the map with a
  // height for every entry of the session.
  const heightCacheRef = useRef({ cols: 0, heights: new Map<number, number>() });
  // What the last painted frame left on screen, for the spacer: see `onScreen`.
  const screenRef = useRef<{ epoch: number; rows: number; cols: number; printed: number; onScreen: number } | null>(
    null,
  );

  /**
   * Commit one entry to the scrollback and hand back the id it was given.
   *
   * The id is taken **outside** the updater on purpose: React may call an
   * updater more than once for a single update, which would have handed the
   * same entry two different ids — and ctrl+o now looks entries up by id.
   */
  const push = useCallback((e: NewEntry): number => {
    const id = idRef.current++;
    setEntries((prev) => [...prev, { ...e, id } as Entry]);
    return id;
  }, []);

  const syncQueue = useCallback(() => setQueueView([...queueRef.current]), []);
  const enqueue = useCallback(
    (line: string) => {
      queueRef.current.push(line);
      syncQueue();
    },
    [syncQueue],
  );
  const dequeue = useCallback((): string | undefined => {
    const next = queueRef.current.shift();
    if (next !== undefined) syncQueue();
    return next;
  }, [syncQueue]);

  /** Paint whatever text has pooled since the last frame, and cancel the timer. */
  const flushDelta = useCallback(() => {
    if (deltaTimerRef.current) {
      clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
    const buffered = deltaBufRef.current;
    if (!buffered) return;
    deltaBufRef.current = "";
    setLive((l) => ({ ...(l ?? { text: "" }), text: (l?.text ?? "") + buffered }));
  }, []);

  /** Drop pooled text without painting it — a turn that ended owns none of it. */
  const dropDelta = useCallback(() => {
    if (deltaTimerRef.current) {
      clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
    deltaBufRef.current = "";
  }, []);

  // A pending flush outliving the component would setState on an unmounted tree.
  useEffect(() => dropDelta, [dropDelta]);

  // ---- a wallet the startup read did not get -------------------------------
  //
  // `main.ts` opens the REPL even when the gateway did not answer, and the
  // status row then says "? cr". One more read after mount, off the path of
  // everything else, turns that back into a figure as soon as the gateway is
  // there, instead of leaving it unknown until the first turn happens to
  // report a balance. Once, and silently: a notice about a read that failed
  // would say the same thing the row already says.
  useEffect(() => {
    if (wallet) return;
    const ctl = new AbortController();
    void client
      .wallet(ctl.signal, { premium: true })
      .then((w) => {
        setBalance((current) => current ?? w.balance);
        setFreeTier((current) => current ?? w.free_tier);
        if (premiumRef.current === undefined) setPremium(w.premium);
      })
      .catch(() => undefined);
    return () => ctl.abort();
    // Mount only: this fills in what the startup read missed and nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- startup notices ----------------------------------------------------
  useEffect(() => {
    // The client changes transport on its own when something in front of the
    // gateway blocks a request, and a transport that silently changes itself is
    // the difference between "that felt slow" and knowing what happened. Wired
    // here and not at construction, because `push` is the REPL's: the one-shot
    // commands leave this unset, and their stdout stays clean for a pipe.
    client.onNotice = (text) => push({ kind: "notice", tone: "warn", text });
    for (const text of notices ?? []) push({ kind: "notice", tone: "warn", text: `  ${text}` });
    const files = contextRef.current.files;
    if (files.length) push({ kind: "notice", text: `  context: ${files.join(", ")}` });
    // Said only when opening the REPL is what granted it. The claim is
    // idempotent per UTC day and three surfaces make it, so announcing the state
    // rather than the event would report the same 400 credits every time
    // somebody opened a terminal. `streakLabel` decides the wording; this
    // decides whether there is anything to say at all.
    // Said once when the REPL opened without a wallet, so "balance unavailable"
    // in the banner and "? cr" under the box have a reason next to them. The
    // agent still works the moment the gateway answers again.
    if (!wallet) {
      let host = config.gatewayUrl;
      try {
        host = new URL(config.gatewayUrl).host;
      } catch {
        // keep the raw value
      }
      push({
        kind: "notice",
        tone: "warn",
        text: `  ${host} did not answer, so the balance is unknown for now. It fills in once a request gets through.`,
      });
    }
    const streakLine = streak && streak.claimed ? streakLabel(streak) : null;
    if (streakLine) push({ kind: "notice", tone: "good", text: `  ${streakLine}` });
    // The free models, on every start, because this is where most people never
    // found them: `/model` marked the free rows, but only for somebody who opened
    // it. One line, and a different one each day since the turn count moves.
    // Silent on a gateway with no free tier and on a paused one.
    const freeLine = freeTierNotice({
      model: config.model,
      balance: wallet?.balance ?? 0,
      free: wallet?.free_tier,
      cheapestPackUsd: client.premiumUnlockUsd,
    });
    if (freeLine) {
      push({ kind: "notice", tone: (wallet?.balance ?? 0) <= 0 ? "warn" : "good", text: `  ${freeLine}` });
    }
    if (session?.messages.length) {
      push({ kind: "notice", text: `  resumed session ${session.id} (${session.messages.length} messages)` });
    }
    // Somebody coming back to a project with no instruction file: this is the
    // session that pays to rediscover the layout, and the next one need not.
    if (initHint?.returning) {
      initHintedRef.current = true;
      push({ kind: "notice", text: `  ${INIT_HINT}` });
    }
    client
      .models()
      .then((m) => {
        catalogRef.current = m;
        setCatalogArrived((n) => n + 1);
        searchRef.current = client.capabilities?.web_search === true;
        // An installed CLI never heard about a release until now: npm pins the
        // version of the day it was installed. One line, when there is
        // something newer, and nothing otherwise. The command is the one that
        // works for a global install; somebody running through npx gets the
        // new version on their next run anyway.
        // A model that has left the catalog since this install picked it. The
        // gateway serves it with its successor either way; switching the saved
        // setting here makes the status line, the cost preview and `/model`
        // agree with what actually answers, and the notice says what happened
        // rather than letting the id change silently under the input box.
        const successor = client.retiredModels[modelRef.current];
        if (successor) {
          const from = modelRef.current;
          config.model = successor;
          saveConfig(config);
          switchModel(successor);
          push({
            kind: "notice",
            text: `  ${from} was retired; now using its successor, ${successor}. /model picks another.`,
          });
        }
        const latest = client.latestCli;
        if (latest && isNewerVersion(latest, VERSION)) {
          push({
            kind: "notice",
            text: `  clixad ${latest} is out (you have ${VERSION}). Update with: npm install -g clixad@latest`,
          });
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, []);

  /**
   * Connect the configured MCP servers, in the background.
   *
   * Never awaited by anything on the startup path: these are other people's
   * programs — a wrong path, an unset key, an npx package that no longer
   * publishes — and none of that may be a reason a coding agent takes six
   * seconds to open, or fails to. Tools appear when they appear, and a server
   * that never comes up is a line in `/mcp` rather than an error here.
   */
  useEffect(() => {
    const { servers, errors } = loadMcpConfig(root);
    // A config with a trailing comma that silently does nothing is
    // indistinguishable from a feature that does not work, so say so.
    for (const problem of errors) push({ kind: "notice", tone: "warn", text: `  mcp config — ${problem}` });
    const names = Object.keys(servers);
    if (names.length === 0) return;

    let cancelled = false;
    void McpHub.connect(servers, { root }).then((hub) => {
      // Unmounted while connecting: hand the servers back rather than leaking
      // a child process per one of them.
      if (cancelled) return void hub.close();
      mcpRef.current = hub;
      const ready = hub.status().filter((s) => s.state === "ready");
      const failed = hub.status().filter((s) => s.state === "failed");
      if (ready.length) {
        push({
          kind: "notice",
          text: `  mcp: ${ready.map((s) => `${s.name} (${s.toolCount} tools)`).join(", ")}`,
        });
      }
      for (const server of failed) {
        push({ kind: "notice", tone: "warn", text: `  mcp: ${server.name} did not start — ${server.error}` });
      }
    });

    return () => {
      cancelled = true;
      void mcpRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, []);

  // Spinner + elapsed clock, only while a turn is running.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [busy]);

  const contextWindow = useCallback(
    (id: string) => catalogRef.current.find((m) => m.id === id)?.context_window ?? contextTokensFor(id),
    [],
  );

  /**
   * Advance the sponsored line for a model call that is about to start.
   *
   * Two sources, in a deliberate order. The **house line is picked and painted
   * synchronously**, exactly as it always was, and only then is the gateway
   * asked for a network one; if it answers with a line for *this* call, it
   * replaces ours. That ordering is the whole design:
   *
   *  - The slot is never empty. Waiting for the network before painting anything
   *    would leave a blank row for as long as the request takes, on a gateway
   *    whose free tier can cold-start for the better part of a minute.
   *  - Nothing degrades. An unreachable gateway, an older one without the route,
   *    a deployment with no publisher id and an empty inventory all look
   *    identical from here — the house line simply stays. `sponsorLine` answers
   *    `null` for every one of them rather than throwing, because there is no
   *    state a user could act on.
   *  - The cost is a visible swap a few hundred milliseconds in. Accepted: the
   *    region is dim chrome under a call that runs for seconds, and the
   *    alternative trades a swap for a blank.
   *
   * The gate is re-read every time rather than cached at mount: `NO_COLOR` and
   * the config file can both change under a long-lived session, and the cost of
   * asking is two string comparisons. It is also what decides whether to ask the
   * gateway at all — a serve nobody could see is an impression the network is
   * billed for and a user never gets.
   *
   * Every figure a *house* line can carry is read out of what the CLI already
   * fetched — the wallet's observed grant range, the catalog's per-task
   * estimate — and formatted by the same two helpers the wallet and the `/model`
   * picker use, so the "on completion" label travels with the number and no
   * figure originates here. Anything not in hand yet leaves its line
   * unresolvable, and the rotation skips it. A network line carries no figure of
   * ours at all; it is somebody else's copy, and the gateway has already bounded
   * and sanitised it.
   *
   * **The other two formats follow the top bar's network half and have no house
   * half.** Each is asked for its own line alongside the top bar's, under the
   * same call counter and the same width rule, and an empty answer leaves its
   * slot undrawn. Starting all three at once rather than one after another is
   * what a person would see anyway — three slots filling within the same few
   * hundred milliseconds — and serially it would be three round trips before
   * the last one appeared.
   */
  const nextSponsor = useCallback(
    (modelId: string) => {
      const call = ++sponsorCallRef.current;
      // `stdout.isTTY`, not `process.stdout.isTTY`: the row is drawn on the
      // stream ink was handed, so that is the stream the gate has to ask about.
      // They are the same object in production, which is why the old reading
      // worked — and it is the wrong one on principle, and it made the width
      // rules below impossible to test, exactly as `useTerminalSize` was.
      if (
        !sponsorEnabled({
          isTTY: stdout.isTTY,
          env: process.env,
          configEnabled: sponsorPreference(config, preferences),
        })
      ) {
        setSponsor(null);
        setAdSlots({});
        return;
      }

      const est = catalogRef.current.find((m) => m.id === modelId)?.est_ads_per_task;
      const facts: SponsorFacts = {
        grant: wallet?.grant_per_ad ? grantLabel(wallet.grant_per_ad) : undefined,
        adsPerTask: est === undefined ? undefined : adsPerTaskLabel(est),
      };

      const picked = sponsorRef.current.pick(sponsorIdxRef.current++, sponsorPrevRef.current, facts);
      if (picked) {
        sponsorPrevRef.current = picked.id;
        recordImpression(tallyRef.current, picked.id);
        setSponsor({ text: picked.text, origin: "house" });
      } else {
        setSponsor(null);
      }

      // Too narrow for an advertisement: the house line stays and the network
      // is not asked. `serve()` refuses the same width from the inside, so this
      // is the cheap half of a decision that is enforced further down — it
      // saves the round trip and the gateway's config call, and the guarantee
      // that nothing is billed lives in `network.ts`. The same holds per format:
      // each is asked only where it could be drawn.
      const fetchNetwork = (format: AdFormat) => {
        void remoteSponsorRef.current[format].fetch().then((line) => {
          // The counter has moved: this line was asked for on a call that has
          // since ended or been superseded. Dropped, not painted.
          if (!line || call !== sponsorCallRef.current) return;
          // The terminal may have narrowed while the request was in flight. A
          // row that cannot be drawn was not seen, so it is not recorded and
          // never reported — an advertiser is already charged for the serve,
          // and claiming the impression on top of that would be claiming
          // something that did not happen.
          if (!adFitsFormat(format, colsRef.current)) return;
          // And a dialog may have opened: the card and the status bar give way
          // to one, so a line landing now would be held for a slot that is not
          // on screen and would first appear in the frame after the dialog
          // closed — which, when esc closes it, is the frame the turn ends in.
          if (format !== "top_bar" && modalOpenRef.current) return;
          if (format === "top_bar") {
            if (!sponsorRow(line.text, colsRef.current, "network")) return;
            sponsorPrevRef.current = line.id;
            setSponsor({ text: line.text, origin: "network", impressionId: line.impression.impressionId });
          } else {
            setAdSlots((slots) => ({
              ...slots,
              [format]: { text: line.text, impressionId: line.impression.impressionId },
            }));
          }
          recordImpression(tallyRef.current, line.id);
          // **Held here, reported when the turn ends, and only if it was
          // drawn** — three moments, and none of them may collapse into
          // another. Holding it here stamps it with the call it belongs to, so
          // a fill dropped by the counter above leaves nothing behind.
          // `drawnRef` is what says it reached a screen: the fill arriving is
          // not the same event as the row being drawn, and only the second is
          // an impression.
          //
          // Reporting is a separate moment because the gateway credits an
          // impression only once the model call it was shown during has been
          // settled, and at this instant the call has just started. Reported
          // from here, no impression could ever credit. See `runTurn`'s finally.
          pendingImpressionRef.current.set(format, { call, impression: line.impression });
        });
      };

      // A booked line for the slot, painted where ADtention's would have been.
      // The same fences as a network fill: the call it was asked for, the
      // width, a dialog. Marked as an advertisement exactly as a network line
      // is, because it is one.
      const paintDirect = (line: Extract<DirectLine, { text: string }>) => {
        const { format } = line;
        if (call !== sponsorCallRef.current) return;
        if (!adFitsFormat(format, colsRef.current)) return;
        if (format !== "top_bar" && modalOpenRef.current) return;
        const drawnId = `direct:${call}:${format}`;
        // The gateway's click address, drawn as a link where the terminal
        // understands one (`hyperlink.ts`); the text alone everywhere else.
        const link = line.clickUrl;
        if (format === "top_bar") {
          if (!sponsorRow(line.text, colsRef.current, "network")) return;
          setSponsor({ text: line.text, origin: "network", impressionId: drawnId, link });
        } else {
          setAdSlots((slots) => ({ ...slots, [format]: { text: line.text, impressionId: drawnId, link } }));
        }
        pendingDirectRef.current.set(format, { call, serveToken: line.serveToken, drawnId });
      };

      // Booked lines first, then ADtention for every slot nothing is booked
      // in. The ask waits at most `DIRECT_ASK_TIMEOUT_MS`, and the house line is
      // already on screen while it does, so the cost of asking is that a
      // network line arrives one round trip later. A slot answered with `hold`
      // gets no network line at all: it is booked, and this account has seen
      // the booking enough for today.
      const fitting = AD_FORMATS.filter((format) => adFitsFormat(format, colsRef.current));
      void (async () => {
        let direct: DirectLine[] = [];
        let failed = false;
        if (directSupportedRef.current && fitting.length > 0) {
          const ask = sponsorDirect ?? ((formats, cols, signal) => client.directSponsor(formats, cols, signal));
          // A `try` and not a `.catch()`: an asker that throws synchronously
          // never returns the promise `.catch` would attach to, and this runs
          // from a `void`, where a rejection is a Node process exiting.
          let answer: DirectAnswer = { supported: true, lines: [] };
          try {
            answer = await ask(fitting, colsRef.current, AbortSignal.timeout(DIRECT_ASK_TIMEOUT_MS));
          } catch {
            answer = { supported: true, lines: [], failed: true };
          }
          if (!answer.supported) directSupportedRef.current = false;
          failed = answer.failed === true;
          direct = answer.lines;
          if (!failed) knownBookedRef.current = new Set(direct.map((line) => line.format));
        }
        if (call !== sponsorCallRef.current) return;
        for (const format of ["top_bar", ...EXTRA_AD_FORMATS] as const) {
          if (!adFitsFormat(format, colsRef.current)) continue;
          const booked = direct.find((line) => line.format === format);
          if (booked && "hold" in booked) continue;
          if (booked) paintDirect(booked);
          // An ask that failed is "nothing booked" except where the last
          // answer said there was a booking: that slot stays empty this turn.
          else if (failed && knownBookedRef.current.has(format)) continue;
          else fetchNetwork(format);
        }
      })();
    },
    [config.sponsor, stdout, wallet, client, sponsorDirect],
  );

  /**
   * Report the impression for the line this turn showed, now that it is over.
   *
   * **The timing is the whole point, and it was wrong once.** The gateway
   * credits an impression only once the model call it was shown during has
   * been settled, which happens when that call finishes, so a report sent while
   * the call is still in flight can never credit. In production that was a
   * report sent at paint time: the whole chain worked, every log line looked
   * healthy, and the grant was refused every single time.
   *
   * Reporting here also makes the claim *stronger*, not weaker. At paint time
   * the line has been on screen for zero milliseconds and the turn may end in
   * the next one; by the time this runs it was displayed for the duration of the
   * turn, which is what an impression is supposed to mean.
   *
   * Called from `runTurn`'s `finally`, so it covers the ordinary end, an error,
   * and esc alike — the line was on screen in all three. What happens next is
   * the gateway's to decide: an aborted turn or a 402 may leave no settled call
   * at all, and then nothing credits, which is the rule working rather than
   * failing. Cleared as it fires so one line can only ever be reported once,
   * and the gateway counts an impression id once whatever arrives.
   */
  const reportSponsor = useCallback(() => {
    const pending = [...pendingImpressionRef.current.values()];
    const pendingDirect = [...pendingDirectRef.current.entries()];
    const drawn = drawnRef.current;
    pendingImpressionRef.current = new Map();
    pendingDirectRef.current = new Map();
    drawnRef.current = new Set();
    // Booked lines go in one call to their own route, under the same two
    // filters as a network line: this turn's call, and actually drawn.
    const directReports = pendingDirect
      .filter(([, p]) => p.call === sponsorCallRef.current && drawn.has(p.drawnId))
      .map(([format, p]) => ({ format, serveToken: p.serveToken }));
    if (directReports.length > 0) void client.reportDirectImpressions(directReports);
    const reports = pending
      // A line for a superseded call was dropped rather than painted, so there
      // is no impression to report — the counter is bumped in the same
      // `finally`, so this compares against the call this turn owned.
      .filter((p) => p.call === sponsorCallRef.current)
      // And a line that arrived but was never drawn — a dialog was up, the rows
      // ran out, the terminal narrowed — was not seen by anybody.
      .filter((p) => drawn.has(p.impression.impressionId))
      .map((p) => p.impression);
    if (reports.length === 0) return;
    // **One after another, not all at once.** The gateway decides each report
    // against the ones before it, so they go in the order they were drawn.
    // Sequential costs nothing anybody waits for — the turn is over and this
    // is not awaited — and
    // `reportImpression` swallows every failure, so one refused report cannot
    // stop the next.
    void (async () => {
      for (const report of reports) await client.reportImpression(report);
    })();
  }, [client]);

  // ---- permissions --------------------------------------------------------
  // `note` is auto mode saying why it is asking, which it otherwise never
  // does. It goes into the transcript above the dialog rather than into the
  // dialog: the dialog's rows are budgeted to the line, and the reason is
  // worth keeping after the answer anyway.
  const askUser = useCallback(
    (req: PermissionRequest, note?: string) =>
      new Promise<PermissionAnswer>((resolve) => {
        if (note) push({ kind: "notice", tone: "warn", text: `  auto mode ${note}` });
        setAsk({ req, resolve });
      }),
    [push],
  );
  const permit = useMemo(() => createPermit(() => permRef.current, askUser), [askUser]);

  /**
   * Put a plan to the user, then move the mode to whatever they chose.
   *
   * The mode lives here, not in the tool: a tool that could change its own
   * permission mode would be a tool that can grant itself write access.
   * `exit_plan_mode` only asks and reports the answer back to the model.
   */
  const approvePlan = useCallback(
    (proposed: string) =>
      new Promise<PlanDecision>((resolve) => {
        setPlan({
          plan: proposed,
          resolve: (decision) => {
            if (decision !== "keepPlanning") {
              switchMode(permRef.current, decision);
              setMode(decision);
            }
            resolve(decision);
          },
        });
      }),
    [],
  );

  const cycleMode = useCallback(() => {
    const next = nextMode(permRef.current.mode, autoModeOffered(catalogRef.current, modelRef.current));
    switchMode(permRef.current, next);
    setMode(next);
  }, []);

  /**
   * Put the model's question to the user, through the picker that already
   * exists for `/model` and `/resume`.
   *
   * The one thing it must never do is fail to settle: a turn is awaiting this
   * promise, and a dialog that closed without answering would leave the agent
   * waiting forever with the keyboard locked. So esc goes through `onCancel`,
   * which answers first and stops the turn second — the same order, and for the
   * same reason, as esc in the permission dialog.
   */
  const askQuestion = useCallback(
    (req: AskUserRequest) =>
      new Promise<string>((resolve) => {
        setPickerSel(0);
        setPicker({
          title: req.question,
          subtitle: "The agent is waiting for your answer · esc stops the turn",
          items: req.options.map((option) => ({
            value: option.label,
            label: option.label,
            hint: option.description ?? "",
          })),
          onPick: (choice) => {
            push({ kind: "notice", tone: "good", text: `  answered: ${choice.value}` });
            resolve(choice.value);
          },
          onCancel: () => {
            resolve("nothing — the user dismissed the question. Do not ask it again.");
            stopCurrent();
          },
        });
      }),
    // `stopCurrent` is declared below and is stable; naming it here would be a
    // use-before-declaration in the dependency array rather than in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [push],
  );

  // ---- one agent turn -----------------------------------------------------
  const handleEvent = useCallback(
    (event: AgentEvent) => {
      // Text pools for one frame; everything else drains the pool first, so a
      // sentence can never be painted after the tool call it preceded.
      if (event.type === "delta") {
        deltaBufRef.current += event.text;
        if (!deltaTimerRef.current) deltaTimerRef.current = setTimeout(flushDelta, DELTA_FLUSH_MS);
        return;
      }
      flushDelta();
      switch (event.type) {
        case "message":
          push({ kind: "assistant", text: event.content });
          setLive((l) => ({ ...(l ?? { text: "" }), text: "" }));
          return;
        case "tool_call": {
          const summary = toolSummary(event.name, event.args);
          runningToolRef.current = { name: event.name, summary };
          setLive((l) => ({ text: l?.text ?? "", tool: { name: event.name, summary, output: "" } }));
          return;
        }
        case "tool_output":
          setLive((l) =>
            l?.tool ? { ...l, tool: { ...l.tool, output: tailLines(l.tool.output + event.chunk, LIVE_OUTPUT_LINES) } } : l,
          );
          return;
        case "tool_result": {
          const summary = runningToolRef.current?.summary ?? "";
          setLive((l) => (l ? { text: l.text, tool: undefined } : l));
          // A permission refusal says one thing to the model and a shorter one
          // to the user; when it does, that short line is the whole entry and
          // there is nothing further to expand.
          if (event.display) {
            push({ kind: "tool", name: event.name, summary, output: `  ${event.display}`, ok: event.ok });
            runningToolRef.current = null;
            return;
          }
          const lines = event.result.split("\n").filter((l) => l.trim() !== "");
          // Cut to the width the entry is actually drawn at — `EntryView` indents
          // committed output by four columns and `entryHeight` measures it at
          // `cols - 4`, so anything else is a row the layout did not count. In
          // columns, and with the ellipsis `fitRow` adds: this was `slice` on
          // code units at `cols - 8`, which cut a line of CJK at half the width
          // it had and said nothing about having cut it.
          const shown = lines
            .slice(0, COMMITTED_OUTPUT_LINES)
            .map((l) => fitRow(l, Math.max(20, cols - 4)));
          const more = Math.max(0, lines.length - shown.length);
          const id = push({
            kind: "tool",
            name: event.name,
            summary,
            output: shown.join("\n"),
            outputMore: more,
            ok: event.ok,
          });
          // Recorded exactly when the label is drawn, so the two can't diverge.
          if (more > 0) {
            keepOutput({ id, label: `${event.name} ${summary}`.trim(), output: event.result });
          }
          runningToolRef.current = null;
          return;
        }
        case "attachment":
          // Said out loud because an image is the one thing in a conversation
          // the user cannot see in the transcript, and it is the expensive
          // thing: it is re-sent on every round for the rest of the turn.
          push({ kind: "notice", text: `  showing the model: ${event.labels.join(", ")}` });
          return;
        case "usage":
          balanceSeqRef.current++;
          setBalance(event.balance);
          if (event.spendable) {
            takeSpendable(event.spendable, event.balance);
          } else if (event.creditsCharged > 0 && premiumRef.current) {
            // A gateway that sends no figures: funded credits are spent first,
            // so whatever a paid call charged came off what premium models may
            // spend, down to the new balance. A buyer's premium credits are
            // simply the balance.
            const p = premiumRef.current;
            setPremium({
              ...p,
              credits: Math.max(0, p.unlocked ? event.balance : Math.min(event.balance, p.credits - event.creditsCharged)),
            });
          }
          // What actually left the wallet, so a free call correctly moves
          // neither the spend nor the burn rate — they describe money, and no
          // money moved.
          setSpent((s) => s + event.creditsCharged);
          if (event.free) {
            setFreeTier((f) =>
              f ? { ...f, credits_left: event.freeCreditsLeft ?? f.credits_left } : f,
            );
          }
          return;
        default:
          return;
      }
    },
    [cols, flushDelta, push, setPremium, takeSpendable],
  );

  // Figures that no longer belong to the balance on screen, or to today, are
  // not shown (see `spendable`), and one wallet read is asked for in their
  // place. Once per balance and day: a gateway that sends none, or a read that
  // fails, leaves the bare balance rather than asking again on every render.
  useEffect(() => {
    if (balance === undefined) return;
    const s = spendableRef.current;
    const day = utcDay();
    if (s && s.balance === balance && s.day === day) return;
    const key = `${balance}|${day}`;
    if (spendableAskedRef.current === key) return;
    spendableAskedRef.current = key;
    refreshSpendable();
  }, [balance, spendable, dayTick, refreshSpendable]);

  const runTurn = useCallback(
    async (task: string, images: ImageAttachment[] = []) => {
      // Any new turn supersedes the last paywall's offer. The list was true of
      // that refusal and of no other — the allowance has moved since, and a
      // stale one would let enter switch to a model that has nothing left.
      pendingFreeRef.current = [];
      pendingPremiumRef.current = null;
      // Deliberately shadowing the render's `model` for the length of this
      // function: see `modelRef`. Every line below wants the model this turn is
      // about to run on, which is not the same thing as the model the last
      // render happened to draw.
      const model = modelRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);
      setStartedAt(Date.now());
      setLive({ text: "" });
      // One step per model call, and only here: `busy` is also set by the /earn
      // wait and the model picker, and rotating on those would spend the
      // inventory on moments that are not a model call.
      nextSponsor(model);

      let history = messagesRef.current;
      try {
        // Compact before the call, so a long session never dies on context.
        const window = contextWindow(model);
        if (shouldCompact([{ role: "system", content: contextRef.current.systemPrompt }, ...history], window)) {
          const res = await compact(client, model, [
            { role: "system", content: contextRef.current.systemPrompt },
            ...history,
          ], { signal: ac.signal, effort: savedEffort(config, model) });
          if (res) {
            history = res.messages.slice(1);
            setMessages(history);
            balanceSeqRef.current++;
            setBalance(res.balance);
            if (res.spendable) takeSpendable(res.spendable, res.balance);
            setSpent((s) => s + res.creditsCharged);
            push({
              kind: "notice",
              text: `  compacted context: ~${Math.round(res.before / 1000)}k → ~${Math.round(res.after / 1000)}k tokens (${res.creditsCharged.toLocaleString("en-US")} credits)`,
            });
          }
        }

        const result = await runAgent(client, task, {
          model,
          // Read now rather than from the render, for `modelRef`'s reason: a
          // setting chosen in the same tick as this turn starts is in `config`
          // already and not yet in any state.
          effort: savedEffort(config, model),
          root,
          history,
          attachments: images,
          // The mode is read at the moment the turn starts and appended to the
          // project context, so the model is told the rule instead of paying a
          // round-trip to discover it. Rebuilt per turn: shift+tab, `/mode` and
          // an approved plan all move it mid-conversation.
          // The mode, and — only where it applies — what to do instead of
          // searching. A deployment that has a search key must not pay for the
          // paragraph explaining that it does not.
          systemPrompt:
            `${contextRef.current.systemPrompt}\n\n${modeInstruction(permRef.current.mode)}` +
            (searchRef.current ? "" : `\n\n${NO_SEARCH_INSTRUCTION}`) +
            // The account's name and instructions, set in the
            // browser or on the account page, said on every turn.
            (preferencesText ? `\n\n${preferencesText}` : ""),
          permit,
          // Auto mode's reviewer: this turn's model, at the cheapest setting
          // the catalog lists for it (see `pickReviewModel` for why not a
          // cheaper model of somebody else's).
          review: pickReviewModel(catalogRef.current, model),
          approvePlan,
          askUser: askQuestion,
          // Bound here rather than passed as the client: the tool takes a
          // function, so a test can drive the agent loop without a gateway.
          webSearch: (query, options) => client.webSearch(query, options),
          webSearchAvailable: searchRef.current,
          todos: todosRef.current,
          mcp: mcpRef.current,
          // Asked per model call, not once: approving a plan restores the write
          // tools in the middle of a turn — and an MCP server that finished
          // connecting mid-turn brings its tools with it.
          tools: () =>
            toolSchemaFor(permRef.current.mode, mcpRef.current.toolSchemas(), {
              webSearch: searchRef.current,
            }),
          signal: ac.signal,
          onEvent: handleEvent,
        });

        // Drop the system prompt: it is rebuilt per run and may change.
        const next = result.messages.slice(1);
        setMessages(next);
        // Named once, by the message that opened it, and then left alone —
        // which is what `StoredSession.title` has always promised the resume
        // picker. The first line only: an `@path` message carries the whole
        // file after a blank line, and a session titled with a file's contents
        // is not a title. What the user typed is always the first line.
        sessionRef.current.title ??= (task.split("\n")[0] || task).slice(0, 80);
        saveSession({
          id: sessionRef.current.id,
          started: sessionRef.current.started,
          updated: new Date().toISOString(),
          cwd: root,
          model,
          title: sessionRef.current.title,
          messages: next,
        });

        if (result.stopped === "aborted") {
          push({ kind: "notice", tone: "warn", text: "  (stopped)" });
          const w = await client.wallet().catch(() => undefined);
          if (w) setBalance(w.balance);
        } else if (result.stopped === "max_steps") {
          push({ kind: "notice", tone: "warn", text: "  (stopped: reached the step limit — ask me to continue)" });
        } else if (result.content) {
          push({
            kind: "assistant",
            text: result.content,
            meta: turnMeta(result),
          });
          // Said once per session, and only when it is news: the free allowance
          // ran out and turns now cost credits. The gateway records the same
          // transition in `free_tier_blocks`; this is the half the person at the
          // keyboard needs, because otherwise a balance simply starts falling
          // for no stated reason — the silence the ad wall's ledger list exists
          // to break, in a second place.
          //
          // Only for a model that *is* free. On a premium model nothing changed
          // and there is nothing to announce.
          let spentNotice = false;
          if (
            freeTier?.models.includes(model) &&
            result.creditsWaived === 0 &&
            result.creditsCharged > 0 &&
            (result.freeCreditsLeft ?? freeTier.credits_left) === 0 &&
            !freeSpentNoticeRef.current
          ) {
            freeSpentNoticeRef.current = true;
            spentNotice = true;
            push({
              kind: "notice",
              tone: "warn",
              text:
                "  Today's free turns are used up. This one cost " +
                `${result.creditsCharged.toLocaleString("en-US")} credits.\n` +
                "  The free allowance resets at midnight UTC. /earn tops up before then.",
            });
          }
          // Said once per session when a paid turn empties the balance, because
          // the next turn on this model is the paywall and the free models are
          // the exit that costs nothing. Not after the notice above, which has
          // just said the same thing about the same moment. The wallet is re-read
          // for it, off the path of the next turn: `turns_left` is only as fresh
          // as the last read, and a turn count on this line is a promise.
          if (result.creditsCharged > 0 && result.balance <= 0 && !spentNotice && !emptyNoticeRef.current) {
            emptyNoticeRef.current = true;
            const on = model;
            void client
              .wallet()
              .then((w) => {
                setFreeTier(w.free_tier);
                const line = freeTierNotice({
                  model: on,
                  balance: w.balance,
                  free: w.free_tier,
                  cheapestPackUsd: client.premiumUnlockUsd,
                });
                if (line) push({ kind: "notice", tone: "warn", text: `  ${line}` });
              })
              .catch(() => undefined);
          }
          // Only a turn that actually answered is rateable, which is why this
          // sits in this branch and not in the `finally`. There is nothing
          // useful to say about a turn that was stopped, and asking somebody to
          // rate their own esc is the sort of prompt that gets a feature turned
          // off. The counter moves with it, so a stopped turn does not spend a
          // slot in the cadence either.
          lastTurnRef.current = {
            turn: turnCountRef.current,
            model,
            prompt: task,
            response: result.content,
            steps: result.steps,
            // Whether the free tier paid for it. Sent with the rating, where it
            // can only ever lower the grant — see `FeedbackReport.free`. A turn
            // that was partly free counts as free: we funded some of it, and of
            // the two roundings this is the one that is ours to absorb.
            free: result.creditsWaived > 0,
          };
          turnCountRef.current += 1;
          config.turns = turnCountRef.current;
          saveConfig(config);
          // A first session here that has become real work: suggest the file
          // that lets the next one start where this one is. Checked again at
          // this moment, because the agent may have written it by now.
          sessionTurnsRef.current += 1;
          if (
            initHint &&
            !initHintedRef.current &&
            sessionTurnsRef.current >= INIT_HINT_AFTER_TURNS &&
            shouldSuggestInit(root)
          ) {
            initHintedRef.current = true;
            push({ kind: "notice", text: `  ${INIT_HINT}` });
          }
        }
      } catch (err) {
        // A refusal carries what may be spent and the balance it was worked
        // out from, so the status line says what is usable as the refusal is
        // printed rather than one read later.
        if ((err instanceof LimitRefusalError || err instanceof PremiumLockedError) && err.spendable) {
          balanceSeqRef.current++;
          takeSpendable(err.spendable.figures, err.spendable.balance);
        }
        if (err instanceof PremiumLockedError) {
          // Not the paywall: the wallet may be full of bonus credits, and they
          // still work, just not on this model. So it says what unlocks the
          // model and that the request is kept, and enter opens a chooser
          // whose rows are the two unlocks and the budget models.
          pendingTaskRef.current = { task, images };
          pendingPremiumRef.current = err;
          setPremium({ unlocked: false, credits: err.premiumCredits });
          const short =
            err.premiumCredits > 0
              ? `  This turn needs about ${err.neededCredits.toLocaleString("en-US")} of those credits, ` +
                `and you have ${err.premiumCredits.toLocaleString("en-US")}.\n`
              : "";
          push({
            kind: "notice",
            tone: "warn",
            text:
              `  ${premiumHeadline(err.unlockUsd)}\n` +
              `  ${err.model} is a premium model. It runs on credits from offer-wall surveys or purchases.\n` +
              short +
              "  Your bonus credits (the signup bonus, our own surveys) still work on budget models.\n" +
              "  Press enter to unlock it or to switch to a budget model. Your request is kept.",
          });
        } else if (err instanceof PaywallError) {
          pendingTaskRef.current = { task, images };
          pendingFreeRef.current = err.freeModels;
          pendingGrantRef.current = err.grantPerAd;
          pendingBalanceRef.current = err.balance;
          // Two notices, because there are two different situations and one
          // sentence cannot describe both. With something free left today the
          // wall is no longer the only way on, and saying "press enter to open
          // the ad wall" would send somebody on a five-minute detour past a
          // model that would have answered immediately for nothing. With
          // nothing free left this is word for word what it always was.
          const free = err.freeModels[0];
          // Our own survey, when the gateway says one is open (2026-10-19): the
          // way on with no screenout, and the first card on the wall.
          const own = err.ownSurvey
            ? `  Our own surveys pay ${err.ownSurvey.credits.toLocaleString("en-US")} credits each and nobody is ` +
              `screened out (${err.ownSurvey.leftToday} left today). They are first on the wall.\n`
            : "";
          push({
            kind: "notice",
            tone: "warn",
            text: free
              ? `  ${shortfallHeadline(err, model)}\n` +
                own +
                `  Press enter — ${free.id} is still free today ` +
                `(~${free.turnsLeft} turn${free.turnsLeft === 1 ? "" : "s"} left), or take an offer instead.\n` +
                `  Your request is kept either way, so you will not have to type it again.\n` +
                `  Offers you are screened out of pay nothing; that is normal, just start another.\n` +
                `  /buy is there too${packsFromClause(err.cheapestPackUsd)}, if you would rather pay than do an offer.`
              : `  ${shortfallHeadline(err, model)}\n` +
                own +
                `  Press enter to open the ad wall — offers pay ${grantLabel(err.grantPerAd)}.\n` +
                `  I'll continue automatically. Offers you are screened out of pay nothing;\n` +
                `  that is normal, just start another.\n` +
                // A wallet that is short rather than empty has a third way on,
                // and it is the cheapest: the same credits on a smaller model.
                // It names the command and no figure, since what a model costs
                // is the gateway's to say and `/model` says it.
                (err.balance > 0 ? `  Or pick a cheaper model with /model, which shows what each one costs.\n` : "") +
                // One clause, last, and it stays last. The wall is how this product
                // is meant to be paid for and the offer is free; naming /buy here
                // is discoverability rather than a pitch, and it is the moment
                // somebody actually wants to know the command exists. The
                // cheapest pack's price rides along, the gateway's figure: the
                // median refusal is a couple of thousand credits short, and the
                // smallest pack is what fits that.
                `  /buy is there too${packsFromClause(err.cheapestPackUsd)}, if you would rather pay than do an offer.`,
          });
        } else if (err instanceof AuthError) {
          push({ kind: "notice", tone: "error", text: NOT_SIGNED_IN });
        } else if (err instanceof MaintenanceError) {
          // The gateway's one sentence, alone: the agent is switched off on
          // the other side, nothing here went wrong and nothing was charged.
          push({ kind: "notice", tone: "warn", text: `  ${errorNotice(err.message, undefined, "  ")}` });
        } else {
          push({ kind: "notice", tone: "error", text: `  error: ${errorNotice((err as Error).message, undefined, "  ")}` });
        }
      } finally {
        abortRef.current = null;
        // Pooled text belongs to a call that is over; painting it now would put
        // a fragment under a turn that has already been committed whole.
        dropDelta();
        setLive(null);
        setBusy(false);
        // The impression, now that the model calls behind this turn have been
        // metered and settled: the gateway credits one only once its call has
        // been settled, so this cannot move earlier. Before the counter bump, because it
        // checks the pending line against the call this turn owned.
        reportSponsor();
        // The line belongs to the call, not to the session: it goes when the
        // call goes, including on error and on esc. Bumping the counter is the
        // other half of that — a network line still in flight for this call is
        // dropped when it lands rather than painted (the `busy` gate would
        // already stop it rendering) and, more to the point, never counted as an
        // impression nobody saw.
        sponsorCallRef.current++;
        setSponsor(null);
        setAdSlots({});
      }
    },
    [
      approvePlan,
      askQuestion,
      client,
      contextWindow,
      dropDelta,
      handleEvent,
      model,
      reportSponsor,
      nextSponsor,
      permit,
      push,
      root,
      takeSpendable,
    ],
  );

  /**
   * Stop whatever the escape key is pointing at.
   *
   * There is more than one thing `busy` can mean: a model call (`abortRef`) and
   * everything routed through `runBusy` below. Only ever one is live, so aborting
   * both is the whole rule — and it is a rule rather than a branch because the
   * failure mode of forgetting one is a locked-up terminal, which is what "esc to
   * stop" did during /earn for the five minutes the wall polled.
   */
  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    busyAbortRef.current?.abort();
  }, []);

  /**
   * Run something that holds the keyboard, with esc wired to it.
   *
   * Every path that locks the input box goes through here or through `runTurn`,
   * and nothing else may call `setBusy(true)` — that is the invariant. Each of
   * the slash commands below used to set `busy` and await the gateway with no
   * controller anywhere, so esc reached nothing: a cold gateway (Render's free
   * tier spins down, and a cold start is the better part of a minute) froze the
   * REPL for as long as the request took, with the box claiming "esc to stop".
   *
   * The `finally` is the part that matters: the keyboard comes back on every
   * path, including the ones nobody wrote a catch for.
   */
  const runBusy = useCallback(
    async (label: string, fn: (signal: AbortSignal) => Promise<void>) => {
      const ac = new AbortController();
      busyAbortRef.current = ac;
      setBusy(true);
      setBusyLabel(label);
      setStartedAt(Date.now());
      try {
        await fn(ac.signal);
      } catch (err) {
        // An abort is the user getting their terminal back, not a fault — and
        // `fetch` reports it as an error like any other, so it is told apart by
        // asking the signal rather than by matching on the message.
        if (ac.signal.aborted) push({ kind: "notice", tone: "warn", text: "  (stopped)" });
        else if (err instanceof AuthError) push({ kind: "notice", tone: "error", text: NOT_SIGNED_IN });
        else if (err instanceof MaintenanceError)
          push({ kind: "notice", tone: "warn", text: `  ${errorNotice(err.message, undefined, "  ")}` });
        else push({ kind: "notice", tone: "error", text: `  ${errorNotice((err as Error).message, undefined, "  ")}` });
      } finally {
        busyAbortRef.current = null;
        setBusyLabel(WORKING);
        setBusy(false);
      }
    },
    [push],
  );

  /**
   * Sign in without leaving the REPL.
   *
   * This exists because the REPL is where the 401 is *printed*: "Not logged in.
   * Run `clixad login` first" named a subcommand that cannot be reached from
   * this prompt, since anything without a leading slash is a prompt — so typing
   * it sent it to the model, which hit the same 401 and printed the same line
   * again, forever.
   *
   * The flow itself is `login.ts`, shared with the subcommand. It mutates the
   * `config` object the `GatewayClient` was constructed with, so the client
   * picks up the new token without being rebuilt; the balance has to be pushed
   * into state by hand because the status line reads it from there.
   */
  const runLogin = useCallback(
    async (arg: string) => {
      const args = parseLoginArgs(arg.split(/\s+/).filter(Boolean));
      // Through `runBusy` like every other gateway call, and for the usual
      // reason: the device flow polls for up to fifteen minutes, and a locked
      // keyboard whose box says "esc to stop" has to actually stop.
      // Pushed before the flow rather than from inside `verify`: the dev shortcut
      // creates an account without ever showing a device code. It lands in
      // <Static>, so it costs nothing in `chromeHeight`.
      push({ kind: "notice", text: TERMS_NOTICE });
      await runBusy(SIGNING_IN, async (signal) => {
        const outcome = await performLogin(
          client,
          config,
          args,
          {
            verify: (start) =>
              push({
                kind: "notice",
                text:
                  `  Open ${start.verification_uri}\n` +
                  `  and enter the code: ${start.user_code}\n` +
                  `  Waiting for GitHub — esc to cancel.`,
              }),
          },
          signal,
        );

        switch (outcome.status) {
          case "ok": {
            const { account } = outcome;
            setBalance(account.balance);
            push({
              kind: "notice",
              tone: "good",
              text:
                `  signed in as ${account.login ?? account.email ?? "you"} · ` +
                `balance ${account.balance.toLocaleString("en-US")} credits` +
                (account.created ? " (signup bonus)" : ""),
            });
            // A brand-new account starts on the gateway's default, and
            // `performLogin` has already saved it. The ref moves first, for the
            // reason `switchModel` exists.
            if (account.model) {
              switchModel(account.model);
              push({ kind: "notice", text: `  model → ${account.model} (the default for new accounts)` });
            }
            // Signing in mid-session means a different account than the one the
            // startup claim was made for, so today's streak is claimed again —
            // for the new account, and idempotently. The balance is pushed back
            // into state by hand for the reason the line above does it: the
            // status line reads it from there.
            const claimed = await client.claimStreak(signal);
            const line = claimed?.claimed ? streakLabel(claimed) : null;
            if (claimed?.claimed) setBalance(claimed.balance);
            if (line) push({ kind: "notice", tone: "good", text: `  ${line}` });
            // A different account has a different allowance, and a REPL that
            // opened signed out has never read one. The startup notice's line,
            // said for the account that just arrived.
            const w = await client.wallet(signal).catch(() => undefined);
            if (w) {
              setBalance(w.balance);
              setFreeTier(w.free_tier);
              const freeLine = freeTierNotice({
                model: modelRef.current,
                balance: w.balance,
                free: w.free_tier,
                cheapestPackUsd: client.premiumUnlockUsd,
              });
              if (freeLine) push({ kind: "notice", tone: w.balance <= 0 ? "warn" : "good", text: `  ${freeLine}` });
            }
            return;
          }
          case "closed":
            // Not an error: the gateway accepted the identity and refused it an
            // account. The message is the only actionable part, so it is passed
            // through rather than summarised.
            push({
              kind: "notice",
              tone: "warn",
              text:
                `  Clixad isn't open yet.\n  ${outcome.message}` +
                (outcome.hadInvite ? "\n  That invite code wasn't accepted — check it for typos." : ""),
            });
            return;
          case "timeout":
            push({ kind: "notice", tone: "warn", text: "  login timed out — /login to try again." });
            return;
          case "aborted":
            // Said here rather than left to `runBusy`: that catch only fires on
            // a throw, and this flow reports cancellation as a *result*. Without
            // it esc would silently return the keyboard with nothing on screen.
            push({ kind: "notice", tone: "warn", text: "  (stopped) — /login to try again." });
            return;
          default:
            push({ kind: "notice", tone: "error", text: `  login failed: ${outcome.error}` });
        }
      });
    },
    [client, config, push, runBusy],
  );

  /** Ad wall: open the dashboard, wait for the balance to rise, resume the task. */
  const runAdWall = useCallback(async () => {
    const pending = pendingTaskRef.current;
    pendingTaskRef.current = null;
    // A premium refusal waits for credits that pay for premium, not for any
    // credit (2026-10-19). Our own surveys are the first card on the wall and
    // pay bonus credits, so a rise in the balance alone used to re-run the
    // request straight into the same refusal.
    const premiumNeed = pendingPremiumRef.current;
    let toldBonus = false;
    // The wait below watches for the balance to rise, so it needs a starting
    // point. When the REPL opened without one, it is read now, before the
    // browser opens and before any reward could land; if even that fails, the
    // first poll that answers becomes the baseline.
    let before = balance ?? (await client.wallet().catch(() => undefined))?.balance;
    // Hand the browser a single-use code so the wall opens already signed in. The
    // page otherwise asks for an account token the CLI never prints, which made
    // the main way to earn credits a dead end. Falls back to the bare URL (manual
    // paste) if the gateway can't issue a code.
    const code = await client.handoffCode();
    const base = config.dashboardUrl.replace(/\/+$/, "");
    openBrowser(code ? `${base}/?c=${encodeURIComponent(code)}` : base);
    push({
      kind: "notice",
      text:
        (code
          ? `  opened ${base} (signed in) — waiting for the reward…\n`
          : `  opened ${base} — paste your token there; waiting for the reward…\n`) +
        `  Credits land on completion; being screened out of an offer pays nothing and is normal.`,
    });
    // Five minutes of polling is the longest the REPL is ever unavailable, and
    // the most likely moment to want out of it: the user closed the wall, or was
    // screened out, and there is nothing left to wait for.
    let credited = false;
    let stopped = false;
    await runBusy(WAITING_FOR_REWARD, async (signal) => {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline && !credited && !signal.aborted) {
        await sleep(3000, signal);
        if (signal.aborted) break;
        // A poll that fails is not worth a notice — the next one is three
        // seconds away — so this one swallows, including the abort.
        const w = await client.wallet(signal).catch(() => undefined);
        if (w && before === undefined) {
          before = w.balance;
          setBalance(w.balance);
        } else if (w && before !== undefined && w.balance > before) {
          setBalance(w.balance);
          if (!premiumNeed) {
            credited = true;
            continue;
          }
          // One premium read for each rise, never one per poll: it reads the
          // account's whole ledger (`/v1/wallet?premium=1`).
          const p = (await client.wallet(signal, { premium: true }).catch(() => undefined))?.premium;
          if (!p || p.unlocked || p.credits >= premiumNeed.neededCredits) {
            credited = true;
          } else {
            before = w.balance;
            if (!toldBonus) {
              toldBonus = true;
              push({
                kind: "notice",
                text:
                  "  bonus credits landed. They pay for budget models; this premium request is still\n" +
                  "  waiting for credits from an offer-wall survey.",
              });
            }
          }
        }
      }
      stopped = signal.aborted;
    });

    // Nothing landed, for either reason: the task the paywall queued is still
    // unrun, so it goes back rather than being dropped on the floor — enter
    // reopens the wall, exactly as the paywall notice said it would.
    if (!credited) pendingTaskRef.current = pending;
    if (stopped)
      return push({
        kind: "notice",
        tone: "warn",
        text:
          "  stopped waiting. A reward still lands whenever the offer clears —\n" +
          "  /wallet checks the balance, /earn opens the wall again." +
          (pending ? "\n  Your last request is still queued: press enter to retry it." : ""),
      });
    // A screenout looks exactly like this from here, and it is the common outcome
    // rather than a fault, so the wording must not read as a failure.
    if (!credited)
      return push({
        kind: "notice",
        tone: "warn",
        text: "  no credit yet — offers take a while to confirm, and a screenout pays nothing.\n  That is normal: start another with /earn, or check /wallet later.",
      });
    push({ kind: "notice", tone: "good", text: "  credits added — continuing" });
    refreshPremium();
    if (pending) await runTurn(pending.task, pending.images);
  }, [balance, client, config.dashboardUrl, push, refreshPremium, runBusy, runTurn]);

  /**
   * What enter does at the paywall, when there is more than one way on.
   *
   * The paywall is the one moment this product stops somebody in the middle of
   * their own work, and until now it had exactly one exit: open a browser, find
   * an offer, finish it, come back. That is the right exit when it is the only
   * one — it is how the product is paid for — but on most days the account has
   * a free allowance sitting unspent on a cheaper model that would answer the
   * same request immediately, and sending somebody past it was costing them a
   * five-minute detour to buy something they already had.
   *
   * So enter opens a chooser rather than a browser, and the rules are the
   * `/buy` picker's:
   *
   * - **It decides nothing.** Every row is an action the user takes, and the
   *   wall is one of them rather than the thing that happens if they hesitate.
   *   Esc closes it and changes nothing — the interrupted task stays queued and
   *   enter opens this again, which is what the notice promised.
   * - **It is only built when there is a choice.** With nothing free left today
   *   `pendingFreeRef` is empty, enter goes straight to the wall, and not one
   *   keystroke of the old path has moved. A picker with one row is a dialog
   *   asking somebody to confirm the only thing they can do.
   * - **The turn counts are the gateway's**, carried on the refusal. This
   *   program cannot import the pricing engine, so a figure computed here would be one
   *   nothing forces to agree with what is actually metered.
   *
   * Switching is saved as the default, exactly as `/model` saves it. The
   * alternative — switch for this one turn and silently go back — would 402
   * again on the very next message, which is the loop this exists to break.
   */
  const runPaywallChoice = useCallback(() => {
    const free = pendingFreeRef.current.filter((m) => m.id !== EARN_ROW);
    if (free.length === 0) return void runAdWall();
    const items: PickerItem[] = [
      ...free.map((m) => ({
        value: m.id,
        label: m.id,
        hint: `free: ~${m.turnsLeft} turn${m.turnsLeft === 1 ? "" : "s"} left today`,
        current: m.id === model,
      })),
      {
        value: EARN_ROW,
        label: "earn credits instead",
        // The wall keeps its figure here: this row is the one that costs time,
        // and what it pays is the only thing that makes the time worth it.
        hint: `opens the ad wall — offers pay ${grantLabel(pendingGrantRef.current)}`,
      },
    ];
    setPickerSel(0);
    setPicker({
      title: (pendingBalanceRef.current ?? 0) > 0 ? "Not enough credits" : "Out of credits",
      subtitle: "Pick a free model to carry on with, or earn credits at the wall.",
      items,
      onPick: (choice) => {
        if (choice.value === EARN_ROW) return void runAdWall();
        const pending = pendingTaskRef.current;
        pendingTaskRef.current = null;
        pendingFreeRef.current = [];
        config.model = choice.value;
        saveConfig(config);
        switchModel(choice.value);
        push({
          kind: "notice",
          tone: "good",
          text: `  model → ${choice.value} (free today) — continuing where you left off`,
        });
        // The whole point: the request is re-run from what was already typed.
        // `runTurn` is given the same task *and the same images*, because a
        // retry that quietly dropped the screenshot the question was about
        // would be answering a different question.
        if (pending) void runTurn(pending.task, pending.images);
      },
    });
  }, [config, model, push, runAdWall, runTurn, switchModel]);

  /**
   * `/buy` — the pack picker, and the only purchase surface the CLI has.
   *
   * It used to be `clixad buy`, a subcommand you had to leave the REPL to
   * reach. That is the wrong shape twice over: the REPL is the default entry
   * point, so almost nobody saw the subcommand list, and the moment somebody
   * wants credits is the moment they are sitting at this prompt with an empty
   * wallet. Anything typed here without a leading slash is a prompt, so
   * "run `clixad buy`" was the same dead end "run `clixad login`" was, and for
   * the same reason.
   *
   * Nothing is charged by this command. It ends on a confirmation dialog, and
   * that ends on Stripe's own page.
   */
  const runBuy = useCallback(async () => {
    await runBusy(LOADING, async (signal) => {
      const { enabled, packs } = await client.creditPacks(signal);
      // A gateway with no Stripe key is a supported state, not a fault: the
      // whole product is designed to be paid for with earned credits, so this
      // says what does work rather than reporting an error.
      if (!enabled || !packs.length) {
        return void push({
          kind: "notice",
          tone: "warn",
          text: "  buying credits isn't enabled on this gateway — /earn tops up the wallet for free.",
        });
      }
      // The figures are the gateway's, never ours: this program cannot import
      // the pricing engine, so a pack size typed here would be a literal nothing
      // forces to agree with the engine — `grantLabel`'s rule.
      const items: PickerItem[] = packs.map((pack) => ({
        value: pack.id,
        label: pack.label,
        hint: `${pack.credits.toLocaleString("en-US")} credits   $${pack.price_usd.toFixed(2)}`,
      }));
      setPickerSel(0);
      setPicker({
        title: "Buy credits",
        subtitle: "Optional — everything here can be paid for with credits you earn.",
        items,
        // No `onCancel`: nothing is awaiting this. Closing it is the end of it,
        // exactly as with `/model`.
        onPick: (choice) => {
          const pack = packs.find((x) => x.id === choice.value);
          if (pack) setBuy({ pack, typed: "" });
        },
      });
    });
  }, [client, push, runBusy]);

  /**
   * What enter does after a premium refusal (2026-10-04).
   *
   * The paywall chooser's rules, `runPaywallChoice`: it decides nothing, esc
   * closes it and keeps the request queued, and every figure is the
   * gateway's. The rows are the two ways to unlock the model, first because
   * that is what somebody who picked a premium model wants, and then the free
   * models the refusal offered, where the bonus credits work. A survey opens
   * the offer walls and resumes the request once credits land, as the paywall
   * does; a pack opens `/buy`, and a purchase that clears resumes it too.
   */
  const runPremiumChoice = useCallback(() => {
    const refusal = pendingPremiumRef.current;
    if (!refusal) return void runPaywallChoice();
    const items: PickerItem[] = [
      {
        value: EARN_ROW,
        label: "complete an offer-wall survey",
        // The label already says where; the hint is what an offer pays, and
        // at 100 columns the longer phrasing cut the figure in half.
        hint: `offers pay ${grantLabel(refusal.grantPerAd)}`,
      },
      ...(refusal.unlockUsd
        ? [
            {
              value: BUY_ROW,
              label: `buy credits from ${usd(refusal.unlockUsd)}`,
              hint: "bought credits work on every model",
            },
          ]
        : []),
      ...refusal.freeModels
        .filter((m) => m.id !== EARN_ROW && m.id !== BUY_ROW)
        .map((m) => ({
          value: m.id,
          label: m.id,
          hint: `budget, free: ~${m.turnsLeft} turn${m.turnsLeft === 1 ? "" : "s"} left today`,
        })),
    ];
    setPickerSel(0);
    setPicker({
      title: premiumHeadline(refusal.unlockUsd),
      subtitle: "Unlock premium, or carry on with a budget model.",
      items,
      onPick: (choice) => {
        if (choice.value === EARN_ROW) return void runAdWall();
        if (choice.value === BUY_ROW) return void runBuy();
        const pending = pendingTaskRef.current;
        pendingTaskRef.current = null;
        pendingPremiumRef.current = null;
        config.model = choice.value;
        saveConfig(config);
        switchModel(choice.value);
        push({ kind: "notice", tone: "good", text: `  model → ${choice.value} (budget) · continuing where you left off` });
        if (pending) void runTurn(pending.task, pending.images);
      },
    });
  }, [config, push, runAdWall, runBuy, runPaywallChoice, runTurn, switchModel]);

  /**
   * Open Stripe Checkout for a confirmed pack and wait for the credits.
   *
   * Reached only from the confirmation dialog, so the two declarations have
   * been made by the time this runs — it sends them rather than deciding them.
   * The wait is `runAdWall`'s: credits arrive as a server-to-server webhook
   * rather than as a reply to anything sent from here, so the balance has to be
   * re-read, and esc has to be felt for the whole five minutes.
   */
  const runCheckout = useCallback(
    async (pack: CreditPackInfo) => {
      // A starting point for the wait, read now if the REPL opened without one:
      // `runAdWall`'s rule for `runAdWall`'s reason.
      let before = balance ?? (await client.wallet().catch(() => undefined))?.balance;
      let credited = false;
      let stopped = false;
      await runBusy(WAITING_FOR_PAYMENT, async (signal) => {
        const checkout = await client.checkout(
          pack.id,
          {
            requestImmediatePerformance: true,
            acknowledgeLossOfWithdrawal: true,
            at: new Date().toISOString(),
          },
          signal,
        );
        openBrowser(checkout.url);
        // The URL is printed as well as opened: `openBrowser` cannot report a
        // desktop with no browser on it, and a checkout nobody can reach is a
        // purchase that silently does not happen.
        push({
          kind: "notice",
          text:
            `  opened Stripe Checkout — ${checkout.credits.toLocaleString("en-US")} credits ` +
            `for $${checkout.price_usd.toFixed(2)}\n  ${checkout.url}`,
        });
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline && !credited && !signal.aborted) {
          await sleep(3000, signal);
          if (signal.aborted) break;
          const w = await client.wallet(signal).catch(() => undefined);
          if (w && before === undefined) {
            before = w.balance;
            setBalance(w.balance);
          } else if (w && before !== undefined && w.balance > before) {
            setBalance(w.balance);
            credited = true;
          }
        }
        stopped = signal.aborted;
      });
      if (credited) {
        push({
          kind: "notice",
          tone: "good",
          text: "  credits added — an invoice is on its way to the address on the payment.",
        });
        // A purchase opens premium models to every credit: the status line's
        // preview is told, and a request the premium gate stopped runs now, as
        // the chooser that led here said it would.
        refreshPremium();
        const pending = pendingPremiumRef.current ? pendingTaskRef.current : null;
        if (pending) {
          pendingTaskRef.current = null;
          pendingPremiumRef.current = null;
          push({ kind: "notice", tone: "good", text: "  premium is unlocked · continuing where you left off" });
          await runTurn(pending.task, pending.images);
        }
        return;
      }
      // Neither outcome is an error, and neither may claim the payment failed:
      // nothing here knows that. The webhook credits whenever it arrives, so
      // both endings point at the balance rather than at a retry — paying twice
      // is the one mistake this screen could talk somebody into.
      push({
        kind: "notice",
        tone: "warn",
        text: stopped
          ? "  stopped waiting. Credits still land when the payment clears — /wallet checks the balance."
          : "  no credits yet — the payment may still be clearing. /wallet checks the balance.",
      });
    },
    [balance, client, push, refreshPremium, runBusy, runTurn],
  );

  // ---- slash commands -----------------------------------------------------
  const runCommand = useCallback(
    async (line: string) => {
      const [cmd, ...rest] = line.slice(1).split(" ");
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "exit":
        case "quit":
          exit();
          return;
        case "help":
          push({ kind: "notice", text: helpText(freeHelpLine(freeTier)) });
          return;
        // Clears both halves of what "clear" means: the model's context *and*
        // the screen. It used to drop only the context, so nothing visibly
        // happened and the transcript of a conversation the agent could no
        // longer remember stayed sitting there.
        case "clear":
          setMessages([]);
          setEntries([]);
          setStaticEpoch((n) => n + 1);
          outputsRef.current = [];
          keptOutputCharsRef.current = 0;
          droppedOutputsRef.current = false;
          expandedRef.current = new Set();
          heightCacheRef.current = { cols: 0, heights: new Map() };
          // The task list belongs to the conversation that agreed it. Background
          // commands do not: a dev server the agent started is still serving,
          // and killing it because the screen was cleared would be a surprise.
          todosRef.current = new TodoList();
          // A rating is about an exchange; with the conversation gone there is
          // nothing left to rate, and a prompt naming a turn nobody can see any
          // more is a question with no answer. The *count* survives — the
          // cadence is a property of the install, not of the conversation.
          lastTurnRef.current = null;
          sessionRef.current = { id: newSessionId(), started: new Date().toISOString() };
          writeToStdout("\x1b[2J\x1b[3J\x1b[H");
          push({ kind: "notice", text: "  cleared — new session, empty context" });
          return;
        case "mode": {
          const wanted = MODES.find((m) => m.toLowerCase() === arg.toLowerCase().replace(/[-\s]/g, ""));
          if (arg && !wanted) {
            push({ kind: "notice", tone: "warn", text: `  unknown mode: ${arg} — try ${MODES.join(", ")}` });
            return;
          }
          if (wanted === "auto" && !autoModeOffered(catalogRef.current, modelRef.current)) {
            push({ kind: "notice", tone: "warn", text: `  ${autoModeUnavailable(catalogRef.current, modelRef.current)}` });
            return;
          }
          if (wanted) {
            switchMode(permRef.current, wanted);
            setMode(wanted);
          } else {
            cycleMode();
          }
          push({ kind: "notice", text: `  mode → ${MODE_LABEL[permRef.current.mode]}` });
          return;
        }
        // A model call like any other, so esc has to stop it like any other —
        // and stopping it costs nothing, since the summary only replaces the
        // conversation once the call has come back whole.
        case "compact":
          await runBusy(COMPACTING, async (signal) => {
            const res = await compact(
              client,
              model,
              [{ role: "system", content: contextRef.current.systemPrompt }, ...messagesRef.current],
              { signal, effort: savedEffort(config, model) },
            );
            if (!res) return void push({ kind: "notice", text: "  nothing to compact yet" });
            setMessages(res.messages.slice(1));
            setBalance(res.balance);
            setSpent((s) => s + res.creditsCharged);
            push({
              kind: "notice",
              text: `  compacted: ~${Math.round(res.before / 1000)}k → ~${Math.round(res.after / 1000)}k tokens (${res.creditsCharged.toLocaleString("en-US")} credits)`,
            });
          });
          return;
        case "init":
          // Nothing left to suggest once somebody has asked for it.
          initHintedRef.current = true;
          await runTurn(INIT_PROMPT);
          return;
        // Always the picker — an id you have to remember and type is exactly
        // what a picker is for. A typed id only preselects a row.
        case "model":
          await runBusy(LOADING, async (signal) => {
            // A failed fetch now reports itself ("models failed: 503") instead of
            // the old blanket "could not load the model list": that line survives
            // for the one case it actually describes, a catalog that came back
            // empty. `.catch(() => [])` would swallow the abort too, and esc would
            // look like a broken gateway.
            const models = catalogRef.current.length ? catalogRef.current : await client.models(signal);
            catalogRef.current = models;
            if (!models.length) return void push({ kind: "notice", tone: "error", text: "  could not load the model list" });
            if (arg && !models.some((m) => m.id === arg)) {
              push({ kind: "notice", tone: "warn", text: `  unknown model: ${arg}` });
            }

            // The allowance is re-read here rather than trusted from startup,
            // because this is the one moment the per-model turn estimates are
            // actually looked at — and by now the session may have spent half
            // of it. One request, on a command the user just typed, on a path
            // that is already busy with an abort controller behind it. A stale
            // "≈19 free turns" next to a model that has three left is worse
            // than no figure at all.
            //
            // It also asks whether premium models are open to this account
            // (2026-10-04), so a premium row is marked locked *before* anybody
            // picks it. Only here: it is a read of the account's whole ledger,
            // and this is the one moment it is shown.
            const free = await client
              .wallet(signal, { premium: true })
              .then((w) => {
                setBalance(w.balance);
                setFreeTier(w.free_tier);
                setPremium(w.premium);
                return w.free_tier;
              })
              .catch(() => {
                setPremium(undefined);
                return freeTier;
              });
            const premium = premiumRef.current;
            const unlockUsd = client.premiumUnlockUsd;

            const items: PickerItem[] = models.map((m) => ({
              value: m.id,
              label: m.id,
              hint:
                accessColumn(m, premium) +
                (m.access === "premium" && premiumLocked(premium)
                  ? premiumUnlockHint(unlockUsd)
                  : modelHint(m, free)),
              current: m.id === model,
            }));
            const preselect = items.findIndex((i) => i.value === arg);
            setPickerSel(preselect >= 0 ? preselect : Math.max(0, items.findIndex((i) => i.current)));
            setPicker({
              title: "Select model",
              subtitle: "Applies to this session and is saved as your default.",
              items,
              onPick: (choice) => {
                config.model = choice.value;
                saveConfig(config);
                switchModel(choice.value);
                push({ kind: "notice", text: `  model → ${choice.value}` });
                // Picked although it is marked locked: said now, rather than
                // after a turn has been typed and refused.
                const picked = models.find((m) => m.id === choice.value);
                if (picked?.access === "premium" && premiumLocked(premium)) {
                  push({
                    kind: "notice",
                    tone: "warn",
                    text:
                      `  ${premiumHeadline(unlockUsd)}\n` +
                      `  ${choice.value} runs on credits from offer-wall surveys or purchases.\n` +
                      "  /earn opens the offer walls" +
                      (unlockUsd ? `, /buy sells credits from ${usd(unlockUsd)} that work on every model.` : ".") +
                      " Your bonus credits work on budget models.",
                  });
                }
              },
            });
          });
          return;
        // How long the model thinks, saved per model. The picker offers only
        // what the current model takes, so a stored setting is always one it
        // has; a typed level it does not have moves to the nearest one below,
        // the gateway's rule, and says so. Every figure about cost stays in
        // words: what a setting costs depends on the task, and the meta line
        // under each turn already shows what it did cost.
        case "effort":
          await runBusy(LOADING, async (signal) => {
            const models = catalogRef.current.length ? catalogRef.current : await client.models(signal);
            catalogRef.current = models;
            const info = models.find((m) => m.id === model);
            const name = info?.label ?? model;
            const levels = effortsOf(info);
            const fallback = info?.default_effort;
            if (!info || levels.length === 0) {
              const why =
                info?.efforts === undefined
                  ? "this gateway does not offer effort settings"
                  : fallback === "on"
                    ? `${name} always thinks before it answers, and has no setting for how long`
                    : `${name} has no effort setting`;
              return void push({ kind: "notice", text: `  ${why}` });
            }
            const defaultWords = fallback ? effortLabel(fallback) : "its default";
            const apply = (choice: string | undefined, note = "") => {
              saveEffort(config, model, choice);
              // With the account too, so the browser's chat thinks as long.
              void client.saveSettings?.({ efforts: { [model]: choice ?? "auto" } });
              setEffortBy({ ...(config.effort ?? {}) });
              const now = choice ? effortLabel(choice) : `auto (${defaultWords})`;
              push({ kind: "notice", text: `  ${name}: ${now}${note}` });
            };
            if (arg) {
              const wanted = parseEffortArg(arg);
              if (!wanted) {
                return void push({
                  kind: "notice",
                  tone: "warn",
                  text: `  unknown effort: ${arg}. ${name} takes ${["auto", ...levels].join(", ")}`,
                });
              }
              if (wanted === "auto") return apply(undefined);
              const resolved = resolveEffort(info, wanted);
              if (!resolved) return apply(undefined, `. ${name} can only switch its thinking off`);
              return apply(resolved, resolved === wanted ? "" : `. It has no ${wanted}, so this is the nearest below`);
            }
            const current = resolveEffort(info, savedEffort(config, model));
            const items: PickerItem[] = [
              { value: "auto", label: "auto", hint: `the model's default (${defaultWords})`, current: !current },
              ...levels.map((level) => ({
                value: level,
                label: level,
                hint:
                  level === fallback
                    ? "same as auto"
                    : effortRaised(info, level)
                      ? "more thinking, more credits"
                      : "less thinking, fewer credits",
                current: current === level,
              })),
            ];
            setPickerSel(Math.max(0, items.findIndex((i) => i.current)));
            setPicker({
              title: `Effort for ${name}`,
              subtitle: "Saved for this model. Thinking is billed as output, like the answer.",
              items,
              onPick: (choice) => apply(choice.value === "auto" ? undefined : choice.value),
            });
          });
          return;
        case "models":
          await runBusy(LOADING, async (signal) => {
            const ms = await client.models(signal);
            catalogRef.current = ms;
            push({
              kind: "notice",
              text: ms
                .map((m) => `  ${m.id.padEnd(24)} ${accessColumn(m, premium)}${modelHint(m, freeTier)}`)
                .join("\n"),
            });
          });
          return;
        case "wallet":
          await runBusy(LOADING, async (signal) => {
            // Claimed before the balance is read, so the figure below already
            // includes today's grant instead of trailing it by one command.
            // Idempotent per UTC day: on every call but the first this credits
            // nothing and only reports where the streak stands.
            const streakNow = await client.claimStreak(signal);
            const w = await client.wallet(signal, { premium: true });
            const figures = parseSpendable(w.spendable);
            balanceSeqRef.current++;
            if (figures) takeSpendable(figures, w.balance);
            else setBalance(w.balance);
            if (w.premium) setPremium(w.premium);
            const usableNow = figures ? walletUsableLines(w.balance, figures) : [];
            // A reversal is the one ledger entry a user cannot explain to
            // themselves: the network charges a conversion back, credits they
            // had already earned vanish, and nothing they did caused it. The
            // REPL has no ledger view, so if one is in the recent history it
            // gets named here — `clixad wallet` has the full list.
            const reversals = w.ledger.filter((e) => e.reason === "ad_reversal");
            const reversed = reversals.reduce((sum, e) => sum + Math.abs(e.delta), 0);
            // `ads_today` counts offers *finished*. A screenout bonus is the
            // opposite of that — a token payment for an attempt that qualified
            // for nothing — so it gets its own clause rather than being added
            // in. Optional, because a gateway older than the bonus does not
            // send it and "0 screenouts" would be a claim we cannot make.
            const screenouts = w.screenouts_today ?? 0;
            const screenoutCredits = w.screenout_credits_today ?? 0;
            // Where the streak stands, claimed or not — unlike the startup
            // notice, `/wallet` is a question about the account rather than an
            // announcement, so "today's already counted" is an answer to it.
            const streakLine = streakNow && streakLabel(streakNow);
            push({
              kind: "notice",
              text:
                `  balance ${w.balance.toLocaleString("en-US")} credits · ` +
                `${w.ads_today} offers today · $${w.earned_usd_today.toFixed(2)}/$${w.max_reward_usd_per_day.toFixed(2)} earned` +
                usableNow.map((l) => `\n  ${l}`).join("") +
                (screenouts
                  ? `\n  plus ${screenoutCredits.toLocaleString("en-US")} credits from ` +
                    `${screenouts} screenout bonus${screenouts === 1 ? "" : "es"} — ` +
                    "attempts that didn't qualify, which CPX pays a little for anyway."
                  : "") +
                (streakLine ? `\n  ${streakLine}` : "") +
                (reversals.length
                  ? `\n  recently: ${reversed.toLocaleString("en-US")} credits from ` +
                    `${reversals.length} offer${reversals.length === 1 ? "" : "s"} were reversed ` +
                    `by the provider. Run \`clixad wallet\` for the full ledger.`
                  : ""),
            });
          });
          return;
        // The same browser handoff the paywall takes, rather than a second way of
        // doing it: two ways to earn is how one of them stops working unnoticed.
        // Resuming without leaving the REPL. `--continue` and `--resume` have
        // always existed as flags, which means the only way to pick up an
        // earlier conversation was to quit the one you were in.
        case "resume":
        case "sessions": {
          const metas = listSessions(root, 10);
          if (!metas.length) {
            push({ kind: "notice", tone: "warn", text: "  no saved sessions in this directory yet" });
            return;
          }
          const load = (id: string) => {
            const found = loadSession(id);
            if (!found) {
              push({ kind: "notice", tone: "error", text: `  no such session: ${id}` });
              return;
            }
            setMessages(found.messages);
            // The title travels with the id: without it the next turn would
            // rename the conversation just resumed after whatever was typed into it.
            sessionRef.current = { id: found.id, started: found.started, title: found.title };
            push({
              kind: "notice",
              tone: "good",
              text: `  resumed ${found.id} — ${found.messages.length} messages\n  ${found.title}`,
            });
          };
          // A typed id skips the picker: `/resume <id>` is what the notices and
          // `clixad --resume` both print, so it has to work as written.
          if (arg) return load(arg);
          const items: PickerItem[] = metas.map((m) => ({
            value: m.id,
            label: m.updated.slice(0, 16).replace("T", " "),
            hint: m.title.slice(0, 60),
            current: m.id === sessionRef.current.id,
          }));
          setPickerSel(0);
          setPicker({
            title: "Resume a session",
            subtitle: "Replaces the current conversation; nothing on screen is lost.",
            items,
            onPick: (choice) => load(choice.value),
          });
          return;
        }
        // What the agent left running, and the way to stop it. The model can
        // see its own background commands through read_output; without this the
        // person whose port 3000 is occupied could not.
        case "bg": {
          const [verb, target] = arg.split(/\s+/);
          if (verb === "kill") {
            const running = shells.list().filter((s) => s.status === "running");
            const doomed = target === "all" ? running : running.filter((s) => s.id === target);
            if (!doomed.length) {
              push({ kind: "notice", tone: "warn", text: `  nothing running${target ? ` as ${target}` : ""}` });
              return;
            }
            for (const s of doomed) shells.kill(s.id);
            push({ kind: "notice", text: `  stopped ${doomed.map((s) => s.id).join(", ")}` });
            return;
          }
          const list = shells.list();
          if (!list.length) {
            push({ kind: "notice", text: "  no background commands have been started" });
            return;
          }
          push({
            kind: "notice",
            text: list
              .map(
                (s) =>
                  // A command is arbitrary text, so it is cut in columns like
                  // everything else that is measured against the width.
                  fitRow(
                    `  ${s.id.padEnd(8)} ${s.status.padEnd(8)} ${Math.round(s.runningMs / 1000)}s  ${s.command}`,
                    Math.max(28, cols),
                  ),
              )
              .join("\n")
              .concat("\n  /bg kill <id> · /bg kill all"),
          });
          return;
        }
        case "mcp": {
          const status = mcpRef.current.status();
          if (!status.length) {
            push({
              kind: "notice",
              text:
                "  no MCP servers configured\n" +
                '  Add them to .mcp.json or ~/.clixad/mcp.json as { "mcpServers": { "name": { "command": "…" } } }',
            });
            return;
          }
          push({
            kind: "notice",
            text: status
              .map((s) => {
                const head = `  ${s.name.padEnd(16)} ${s.state.padEnd(10)} ${s.transport}`;
                if (s.state === "ready") return `${head}  ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`;
                return s.error ? `${head}\n    ${s.error.split("\n").join("\n    ")}` : head;
              })
              .join("\n"),
          });
          return;
        }
        case "earn":
          await runAdWall();
          return;
        // Through `runBusy` like every other gateway call: the free instance can
        // cold-start for the better part of a minute, and the box says "esc to
        // stop" whenever it is locked.
        case "refer":
          await runBusy(LOADING, async (signal) => {
            const info = await client.referral(signal);
            // One notice, so the whole summary commits as a block rather than
            // four separate rows the layout has to budget for one at a time.
            push({ kind: "notice", text: referLines(info).map((line) => `  ${line}`).join("\n") });
          });
          return;
        case "buy":
          await runBuy();
          return;
        case "redeem": {
          if (!arg) {
            push({ kind: "notice", tone: "warn", text: "  usage: /redeem <code>" });
            return;
          }
          await runBusy(LOADING, async (signal) => {
            const result = await client.redeem(arg, signal);
            const { ok, text } = redeemMessage(result);
            // A refusal is an answer, not an error: `warn` rather than `error`,
            // because nothing is broken and the user has something to do about
            // it. Each status says a different thing for that reason.
            if (ok) setBalance(result.balance);
            push({
              kind: "notice",
              tone: ok ? "good" : "warn",
              text: ok
                ? `  ${text} · balance ${result.balance.toLocaleString("en-US")}`
                : `  ${text}`,
            });
          });
          return;
        }
        case "login":
          await runLogin(arg);
          return;
        default:
          push({ kind: "notice", tone: "warn", text: `  unknown command: /${cmd} — try /help` });
      }
    },
    [client, cols, config, cycleMode, exit, model, premium, push, root, runAdWall, runBusy, runBuy, runLogin, runTurn, setPremium, writeToStdout],
  );

  /**
   * `!command` — run a shell command yourself, with no model call.
   *
   * The command is not gated: the permission modes exist to decide what the
   * *model* may do, and the person at the keyboard is the authority those modes
   * answer to. What it does need is to reach the conversation, or the next turn
   * would be blind to something the user just did in the same workspace — so
   * the command and its output are appended as an ordinary user message.
   */
  const runShell = useCallback(
    async (command: string) => {
      push({ kind: "user", text: `!${command}` });
      let output = "";
      await runBusy(RUNNING, async (signal) => {
        output = await TOOLS.run_command(
          {
            root,
            signal,
            onOutput: (chunk) =>
              setLive((l) => ({
                text: l?.text ?? "",
                tool: { name: "!", summary: command, output: tailLines((l?.tool?.output ?? "") + chunk, LIVE_OUTPUT_LINES) },
              })),
          },
          { command },
        );
        const lines = output.split("\n").filter((l) => l.trim() !== "");
        // The width the layout measures this entry at — see the tool_result path.
        const shown = lines
          .slice(0, COMMITTED_OUTPUT_LINES)
          .map((l) => fitRow(l, Math.max(20, cols - 4)));
        const more = Math.max(0, lines.length - shown.length);
        const id = push({
          kind: "tool",
          name: "!",
          summary: command,
          output: shown.join("\n"),
          outputMore: more,
          ok: true,
        });
        if (more > 0) keepOutput({ id, label: `! ${command}`, output });
      });
      setLive(null);
      // Only once it actually ran: a command the user aborted told the model
      // nothing, and a phantom entry in the history is worse than a gap.
      if (output) {
        setMessages((prev) => [
          ...prev,
          { role: "user", content: `I ran \`${command}\` in the workspace myself. Its output:\n\n${output}` },
        ]);
      }
    },
    [cols, push, root, runBusy],
  );

  /** Actually carry out one line of input. Assumes nothing else is running. */
  const dispatchLine = useCallback(
    async (line: string) => {
      if (line.startsWith("!")) {
        const command = line.slice(1).trim();
        if (!command) return;
        return runShell(command);
      }

      push({ kind: "user", text: line });
      if (line.startsWith("/")) return runCommand(line);

      // `@path` used to insert a filename and nothing else, so the model read
      // the name, called read_file, and the user paid a round-trip for a file
      // they had already pointed at. The typed line stays on screen; only the
      // model's copy carries the contents.
      const { text: task, attached, images } = expandMentions(line, root);
      if (attached.length) {
        push({ kind: "notice", text: `  attached ${attached.join(", ")}` });
      }
      return runTurn(task, images);
    },
    [push, root, runCommand, runShell, runTurn],
  );

  /**
   * Every fiftieth turn, ask whether the last answer was any good — and pay for
   * the answer either way.
   *
   * Four rules, and each of them is the difference between a prompt people
   * answer and one they learn to dismiss:
   *
   *  - **It fires after the queue has drained**, not at the end of a turn. A
   *    message typed while the agent was working is a message the user is waiting
   *    for; putting a modal in front of it would be the most annoying possible
   *    moment for this to appear.
   *  - **Skipping costs nothing and sends nothing.** Esc and the third row are
   *    the same outcome: no request, no row, no credits withheld. There is
   *    deliberately no "skipped" rating — declining to answer is not a data
   *    point, and a value for it would sit in the eval set forever meaning
   *    nothing.
   *  - **Both answers pay the same**, and the copy says so before the choice is
   *    made. Paying more for a thumbs-up buys thumbs-ups; a set biased toward
   *    approval is biased in the one direction that makes it useless. The gateway
   *    enforces this — the crediting path never reads the rating — but the prompt
   *    has to *say* it, or the user supplies the bias on our behalf.
   *  - **The figure comes from the wallet, never from here.** This program cannot
   *    import the pricing engine, so a number typed into this file is a literal
   *    nothing forces to agree with the engine. An older gateway sends none and
   *    the line simply drops the amount, which is the sponsored line's rule for
   *    an unresolvable placeholder.
   *
   * It also states that the exchange is stored, because it is: this is the one
   * place in the product where a prompt and a response are written down, and
   * somebody agreeing to that should be told they are.
   */
  const askFeedback = useCallback(async () => {
    const turn = lastTurnRef.current;
    if (!turn) return;
    // Cleared before the await: the picker is modal but the promise is not, and
    // a second prompt about the same exchange would be a second row the gateway
    // refuses anyway.
    lastTurnRef.current = null;

    // The figure has to match what this rating will actually be paid, and a
    // rating on a free turn is paid the reduced share — so the two amounts are
    // two fields from the gateway rather than one number and a multiplication.
    // This program cannot import the pricing engine, and this line says "both
    // answers pay N" out loud: a figure derived here would be a promise nothing
    // forces to agree with what the route grants.
    //
    // An older gateway sends only `feedback_credits`, and one older still sends
    // neither — in which case the amount is dropped rather than invented, the
    // sponsored line's rule for an unresolvable placeholder.
    const amount = turn.free
      ? wallet?.rewards?.feedback_credits_free ?? wallet?.rewards?.feedback_credits
      : wallet?.rewards?.feedback_credits;
    const pay = amount ? `Both answers pay ${amount.toLocaleString("en-US")} credits` : "Both answers pay the same";
    const choice = await new Promise<string | null>((resolve) => {
      setPickerSel(0);
      setPicker({
        title: "Was that last answer any good?",
        subtitle: `${pay} · we keep that exchange to test against · esc skips`,
        items: [
          { value: "up", label: "yes — that worked", hint: "" },
          { value: "down", label: "no — that missed", hint: "" },
          { value: "skip", label: "skip", hint: "nothing is sent, nothing is stored" },
        ],
        onPick: (item) => resolve(item.value),
        // Esc and "skip" are the same outcome and must stay that way: a skip
        // that cost something is a prompt people stop reading.
        onCancel: () => resolve(null),
      });
    });
    if (choice !== "up" && choice !== "down") return;

    await runBusy(SENDING_FEEDBACK, async (signal) => {
      const outcome = await client.sendFeedback(
        { ...turn, session: sessionRef.current.id, rating: choice },
        signal,
      );
      // `sendFeedback` never throws, so `null` is every failure at once — an
      // older gateway, a cold one, a stale token. None of them is something the
      // user can act on and none of them cost anything, so none of them gets a
      // notice.
      if (!outcome) return;
      if (outcome.credited > 0) setBalance(outcome.balance);
      push({
        kind: "notice",
        tone: "good",
        text:
          outcome.credited > 0
            ? `  thanks — +${outcome.credited.toLocaleString("en-US")} credits`
            : // Recorded and unpaid: the daily ceiling, or a turn already rated.
              // Worth saying, because the offer of credits was made a moment ago.
              "  thanks — noted (today's feedback credits are already in)",
      });
    });
  }, [client, push, runBusy, wallet]);

  /**
   * Run `line`, then whatever was typed while it ran.
   *
   * The loop lives here rather than in an effect on `busy` for a reason: an
   * effect would fire on the same render that flips `busy` back to false and
   * again on the queue change, and the second firing sees a stale `busy` and
   * starts a second turn on top of the first. Only one caller is ever the
   * runner — everything submitted while it runs simply queues — so serialising
   * is a `for` loop and needs no guard flag at all.
   */
  const runSerially = useCallback(
    async (line: string) => {
      await dispatchLine(line);
      for (let next = dequeue(); next !== undefined; next = dequeue()) {
        await dispatchLine(next);
      }
      // Only once nothing is waiting. A modal in front of a message somebody is
      // already waiting for is the worst moment this could pick, and `turnCount`
      // has moved for each of the turns that just ran — so the cadence is
      // measured against the last of them, not the first.
      if (lastTurnRef.current && turnCountRef.current % FEEDBACK_TURN_INTERVAL === 0) {
        await askFeedback();
      }
    },
    [askFeedback, dequeue, dispatchLine],
  );

  const submit = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      setEditor(ed.EMPTY);
      setHistIdx(-1);
      setMenuOff(false);
      if (!line) return;

      setHist((h) => {
        const next = [line, ...h.filter((x) => x !== line)].slice(0, 200);
        saveHistory(next);
        return next;
      });

      // Typing during a turn is allowed and the message waits its place, which
      // is the single biggest thing this REPL did differently from Claude Code:
      // the keyboard used to be dead for the length of every call, so a thought
      // you had while watching the agent work was a thought you had to hold.
      if (busyRef.current) return void enqueue(line);
      return runSerially(line);
    },
    [enqueue, runSerially],
  );

  // Kick off `clixad agent "<task>"` once the UI is mounted.
  useEffect(() => {
    if (!initialTask) return;
    // Through the same runner as a typed line, so anything entered while the
    // opening task runs is picked up when it finishes rather than stranded.
    void runSerially(initialTask);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, []);

  // ---- completion menu ----------------------------------------------------
  const text = ed.toText(editor);
  const cursor = ed.offset(editor);
  const query = useMemo(() => findToken(text, cursor), [text, cursor]);
  const matches = useMemo(
    () =>
      query
        ? suggest(query, {
            files: () => (filesRef.current ??= listWorkspaceFiles(root)),
          })
        : [],
    [query, root],
  );
  const menu = menuOff || ask || picker || plan || buy ? [] : matches;
  useEffect(() => {
    setSel(0);
    setMenuOff(false);
  }, [text]);

  const accept = useCallback(
    (choice: Suggestion) => {
      if (!query) return;
      const { text: nextText, cursor: nextCursor } = applySuggestion(text, cursor, query, choice);
      setEditor(ed.fromTextAt(nextText, nextCursor));
    },
    [cursor, query, text],
  );

  /**
   * Pasted text, as one piece.
   *
   * `usePaste` turns on the terminal's bracketed-paste mode, which wraps a
   * paste in `\x1b[200~`/`\x1b[201~` markers and routes it to its own channel —
   * so it never reaches `useInput` at all. Without it a paste arrives as raw
   * keystrokes split across however many reads the OS decides on, and a chunk
   * that happens to end on a `\r` is indistinguishable from Enter: the prompt
   * submitted itself halfway through a pasted stack trace.
   *
   * A modal owns the keyboard, so a paste into one is dropped rather than
   * queued behind it — landing in the editor underneath a dialog would be
   * invisible until the dialog closed.
   */
  usePaste((text) => {
    if (ask || picker || plan || buy) return;
    setEditor((state) => ed.insert(state, text));
    lastTextAtRef.current = Date.now();
    setHistIdx(-1);
  });

  /**
   * Settle whatever modal is waiting on an answer, then let the caller stop.
   *
   * A turn holds the keyboard while a dialog is up, and it is holding a promise
   * with it: the tool is inside `await ctx.permit(req)`, or `approvePlan`, or
   * `askUser`. Aborting the signal does not resolve any of those, so a stop
   * that only aborts leaves the dialog on screen and the loop waiting on
   * something nobody will answer. Esc has always answered first and aborted
   * second, for exactly that reason — ctrl+c did not, so it silently did
   * nothing at all while a permission dialog was up, which is the one moment
   * `busy` is most likely to be true.
   *
   * The answers are esc's: a refusal that stops the turn, never a silent yes.
   */
  const dismissModals = useCallback(() => {
    if (plan) {
      setPlan(null);
      plan.resolve("keepPlanning");
    }
    if (ask) {
      setAsk(null);
      ask.resolve("deny");
    }
    if (picker) {
      const cancel = picker.onCancel;
      setPicker(null);
      cancel?.();
    }
    // Nothing is awaiting this one — no tool, no turn — so closing it is the
    // whole answer. It is still listed here rather than left out: the rule is
    // that a stop leaves no modal on screen, and a dialog that outlived ctrl+c
    // would sit over a prompt that had already been handed back.
    if (buy) setBuy(null);
  }, [ask, buy, picker, plan]);

  // ---- keys ---------------------------------------------------------------
  useInput((ch, key) => {
    // More input right behind an Enter that had not sent yet: it was a line
    // break inside a paste (`pendingSendRef`), and goes in ahead of this event.
    if (pendingSendRef.current !== undefined) {
      clearTimeout(pendingSendRef.current);
      pendingSendRef.current = undefined;
      setEditor(ed.newline);
      lastTextAtRef.current = Date.now();
    }

    // Ctrl+C: stop the turn, then clear the line, then quit on a second press.
    if (key.ctrl && ch === "c") {
      if (busy) {
        // The gate first, the abort second — see `dismissModals`.
        dismissModals();
        return stopCurrent();
      }
      if (!ed.isEmpty(editorRef.current)) return setEditor(ed.EMPTY);
      if (Date.now() - ctrlCRef.current < 2000) return exit();
      ctrlCRef.current = Date.now();
      setQuitHint(true);
      return;
    }
    if (quitHint) setQuitHint(false);

    // A pending permission question owns the keyboard. Enter accepts once — it is
    // the most reflexive key to press at a prompt, and it used to do nothing at all.
    // A plan awaiting approval owns the keyboard, like the permission dialog.
    // Two ways to say yes, because there are two modes worth landing in, and
    // they are the keys the permission dialog already uses for the same ideas.
    if (plan) {
      const decision: PlanDecision | undefined =
        ch === "y" || ch === "j" || key.return
          ? "normal"
          : ch === "a"
            ? "acceptEdits"
            : ch === "u" && autoModeOffered(catalogRef.current, modelRef.current)
              ? "auto"
              : ch === "n"
                ? "keepPlanning"
                : undefined;
      if (key.escape) {
        // Esc stops the turn, as everywhere else. The model is told the plan was
        // not approved so the conversation stays truthful about what happened.
        setPlan(null);
        plan.resolve("keepPlanning");
        stopCurrent();
        return;
      }
      if (!decision) return;
      setPlan(null);
      plan.resolve(decision);
      push({
        kind: "notice",
        tone: decision === "keepPlanning" ? "warn" : "good",
        text:
          decision === "keepPlanning"
            ? "  keeping plan mode on — say what you'd like changed"
            : `  plan approved · mode → ${MODE_LABEL[decision]}`,
      });
      return;
    }

    if (ask) {
      // Esc means stop, here as everywhere else. It used to mean "deny", so the
      // turn carried on and paid for another round-trip to be told no — while
      // the working line one row above promised "esc to stop". The gate is
      // answered first: the tool has to be released, or the loop would wait on
      // a promise nobody will ever resolve. Answering it "deny" and then
      // aborting means the loop sees the refusal, then the signal, and ends the
      // turn without another model call.
      if (key.escape) {
        setAsk(null);
        ask.resolve("deny");
        stopCurrent(); // runTurn reports the "(stopped)" itself
        return;
      }
      const answer: PermissionAnswer | undefined =
        ch === "y" || ch === "j" || key.return
          ? "once"
          : ch === "a"
            ? "always"
            : ch === "n"
              ? "deny"
              : undefined;
      if (!answer) return;
      setAsk(null);
      ask.resolve(answer);
      push({
        kind: "notice",
        tone: answer === "deny" ? "warn" : undefined,
        text: `  ${answer === "deny" ? "denied" : answer === "always" ? "allowed (always)" : "allowed"}: ${ask.req.summary}`,
      });
      return;
    }

    // The picker is modal: arrows or a row number, Enter confirms, Esc cancels.
    if (picker) {
      const n = picker.items.length;
      if (key.escape) {
        // Closed before the choice was made. `onCancel` is how a *tool* waiting
        // on this picker is released: `/model` and `/resume` have nothing to
        // settle, but `ask_user` has a turn holding the keyboard until it hears
        // back, and closing without answering would hang it forever.
        const cancel = picker.onCancel;
        setPicker(null);
        cancel?.();
        return;
      }
      if (key.upArrow) return setPickerSel((s) => (s - 1 + n) % n);
      if (key.downArrow) return setPickerSel((s) => (s + 1) % n);
      // Row numbers address what is **on screen**. The picker scrolls now, so
      // an absolute index would let "3" pick a row the window is not showing.
      if (/^[1-9]$/.test(ch)) {
        const { from, count } = pickerWindowRef.current;
        const row = Number(ch);
        if (row > count) return;
        const choice = picker.items[from + row - 1];
        if (!choice) return;
        setPicker(null);
        return picker.onPick(choice);
      }
      if (key.return) {
        const choice = picker.items[Math.min(pickerSel, n - 1)];
        setPicker(null);
        if (choice) picker.onPick(choice);
      }
      return;
    }

    /**
     * The purchase confirmation owns the keyboard, and it is the only dialog
     * here that no single key can accept.
     *
     * Every other one is answered with `y` — approving an edit is the most
     * practised keystroke in this REPL and it lands at this same spot on the
     * screen. This dialog opens a payment page, so it takes the word `yes` and
     * an enter instead, and a bare enter is a refusal. Nothing about it is
     * charged either way: Stripe's page is where a payment is made, and the
     * only thing confirming here does is open it.
     */
    if (buy) {
      const cancelled = () =>
        push({ kind: "notice", tone: "warn", text: "  cancelled — you have not been charged." });
      if (key.escape) {
        setBuy(null);
        cancelled();
        return;
      }
      if (key.return) {
        const confirmed = buy.typed.trim().toLowerCase() === BUY_CONFIRM_WORD;
        // A yes to a question that was never fully put is not a yes. The
        // dialog stays open rather than closing, because the fix is to resize
        // the terminal and the dialog is what the resize is for.
        if (confirmed && !buyFitsRef.current) {
          return void push({
            kind: "notice",
            tone: "warn",
            text: "  the confirmation does not fit on this terminal — make it taller, then answer.",
          });
        }
        const { pack } = buy;
        setBuy(null);
        if (!confirmed) return void cancelled();
        void runCheckout(pack);
        return;
      }
      if (key.backspace || key.delete) {
        setBuy((b) => (b ? { ...b, typed: b.typed.slice(0, -1) } : b));
        return;
      }
      // Printable ASCII only, and bounded. The field is one budgeted row inside
      // a box whose height is counted before it is drawn, and a key held down
      // must not be able to make it two — that is the one bug in this file that
      // clears the screen and replays the session.
      if (ch && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(ch)) {
        setBuy((b) => (b ? { ...b, typed: (b.typed + ch).slice(0, BUY_TYPED_MAX) } : b));
      }
      return;
    }

    // Esc still stops the turn, and takes the queue with it: a message you
    // typed to run *after* this one is not a message you want run *instead* of
    // the thing you just stopped. What was dropped is printed, so nothing
    // disappears silently.
    if (busy && key.escape) {
      const dropped = queueRef.current;
      if (dropped.length) {
        queueRef.current = [];
        syncQueue();
        push({
          kind: "notice",
          tone: "warn",
          text: `  not sent:\n${dropped.map((l) => `  · ${l}`).join("\n")}`,
        });
      }
      stopCurrent();
      return;
    }

    if (key.tab && key.shift) return cycleMode();

    // Expand the most recent tool output that is still collapsed, then the one
    // before it, and so on — so every "… +N lines (ctrl+o)" on screen is
    // reachable rather than only the last one written.
    if (key.ctrl && ch === "o") {
      const next = [...outputsRef.current].reverse().find((o) => !expandedRef.current.has(o.id));
      if (!next) {
        push({
          kind: "notice",
          text: droppedOutputsRef.current
            ? "  nothing left to expand — older output is not kept this far back"
            : "  nothing left to expand",
        });
        return;
      }
      expandedRef.current.add(next.id);
      const lines = next.output.split("\n");
      const shown = lines.slice(0, EXPAND_MAX_LINES);
      const dropped = lines.length - shown.length;
      push({
        kind: "notice",
        text:
          `  ${next.label}\n` +
          shown.map((l) => `  ${l}`).join("\n") +
          (dropped > 0 ? `\n  … +${dropped} more lines (not shown)` : ""),
      });
      return;
    }

    // An Enter inside a paste the terminal did not bracket is a newline, never
    // a send (`PASTE_ENTER_MS`). Ahead of the completion menu, which a pasted
    // `@` or `/` can open, so a paste cannot pick a completion either.
    if (key.return && !key.meta && !key.shift && Date.now() - lastTextAtRef.current < PASTE_ENTER_MS) {
      lastTextAtRef.current = Date.now();
      return setEditor(ed.newline);
    }

    // Completion menu.
    if (menu.length > 0) {
      if (key.upArrow) return setSel((s) => (s - 1 + menu.length) % menu.length);
      if (key.downArrow) return setSel((s) => (s + 1) % menu.length);
      if (key.escape) return setMenuOff(true);
      if (key.return || key.tab) {
        const choice = menu[Math.min(sel, menu.length - 1)]!;
        if (key.tab || choice.takesArgs || choice.kind === "file") return accept(choice);
        return void submit(choice.value);
      }
    }

    if (key.return) {
      if (key.meta || key.shift) return setEditor(ed.newline);
      if (ed.endsWithContinuation(editorRef.current)) return setEditor(ed.continueLine);
      if (!busy && pendingTaskRef.current && ed.isEmpty(editorRef.current)) {
        return void (pendingPremiumRef.current ? runPremiumChoice() : runPaywallChoice());
      }
      pendingSendRef.current = setTimeout(() => {
        pendingSendRef.current = undefined;
        void submit(ed.toText(editorRef.current));
      }, PASTE_ENTER_MS);
      return;
    }
    if (key.ctrl && ch === "j") return setEditor(ed.newline);

    // History at the edges of a multi-line buffer; cursor movement inside it.
    if (key.upArrow && editorRef.current.row === 0) {
      const n = Math.min(histIdx + 1, hist.length - 1);
      const v = hist[n];
      if (v !== undefined) {
        setHistIdx(n);
        setEditor(ed.fromText(v));
      }
      return;
    }
    if (key.downArrow && editorRef.current.row === editorRef.current.lines.length - 1 && histIdx >= 0) {
      const n = histIdx - 1;
      setHistIdx(n < 0 ? -1 : n);
      setEditor(n < 0 ? ed.EMPTY : ed.fromText(hist[n] ?? ""));
      return;
    }

    const editorKey = toEditorKey(ch, key);
    if (editorKey.input && !key.ctrl && !key.meta) lastTextAtRef.current = Date.now();
    setEditor((state) => ed.apply(state, editorKey));
  });

  // ---- layout -------------------------------------------------------------
  //
  // Everything below the committed scrollback is redrawn every frame, and it
  // **must stay shorter than the viewport**. Ink erases the rows it last wrote
  // to redraw them; once the frame is taller than the terminal it cannot, and
  // falls back to clearing the screen and replaying every static line it has
  // ever emitted. That fallback is what drew half a dozen stacked input boxes
  // up the screen, and — running once per streamed token — what made the output
  // arrive in lurches with several tool calls already behind it.
  //
  // So the rows are **reserved before they are spent**, and the order is the
  // whole thing. First what cannot be clipped: the input line, and whatever a
  // modal needs to be answerable at all (`modalFloor`). What is left is granted
  // — best first — to the input's border, the working line, the status line,
  // the queue and the sponsored line, and anything that does not fit is not
  // drawn. Only then do the picker, the dialogs and the streamed text divide
  // the remainder, each clipped to it.
  //
  // The order this replaced spent the working line's two rows **last**, after a
  // dialog had already taken the budget, so they came out of nothing — and a
  // permission dialog is always up while `busy` is true, which made that the
  // ordinary path rather than a corner. Every optional block therefore renders
  // on its grant (`busyHeight > 0`, `showStatus`, `showSponsor`, `inputBorder`)
  // and never on the state that produced it: a row that is granted but drawn
  // unconditionally is the same bug in a different place.
  //
  // Every block is clipped by its *rendered* height (`lineCount` / `tailRows` /
  // `headRows`), which run the text through ink's own `wrapAnsi` — counting
  // `\n`s misses that one streamed paragraph wraps to thirty rows, and
  // `ceil(width / cols)` misses that word wrap needs more rows than that.
  const elapsed = busy && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  // The duck turns a third as often as the clock ticks: at 120 ms a two-frame
  // cycle is a strobe, and the seconds still have to count at 120 ms.
  const spinner = spinnerRef.current[Math.floor(tick / SPINNER_TICKS_PER_FRAME) % spinnerRef.current.length];

  // Cut here, at the width, so it is exactly one row — `sponsorRow` answers
  // null rather than wrap, and the budget below subtracts the same 0-or-1 it
  // draws. The `Ad ·` mark on a network line costs five of those columns and
  // takes them out of the ad copy's share, never out of the row's height.
  const sponsorLine = busy && sponsor ? sponsorRow(sponsor.text, cols, sponsor.origin) : null;
  // Whether the accent may be painted. Refusing it does not refuse the mark:
  // the row still says `Ad ·`, in the same dim as everything else.
  const adColor = adColorEnabled({ isTTY: stdout.isTTY, env: process.env });
  // Whether a booked line may be a link to click (`sponsor/hyperlink.ts`).
  const linkable = hyperlinksEnabled({ isTTY: stdout.isTTY, env: process.env });
  // **A dialog on screen is what the person is reading**, so the two newer
  // slots give way to it: a permission prompt, a question, a plan or a
  // purchase with an advertisement beside or under it is an advertisement
  // competing with a decision. The top bar keeps its place, as it always has —
  // it is above the input box, not beside the dialog. Checked here and again
  // before a slot is reported, since a line hidden by a dialog for the whole
  // turn was never seen.
  const modalOpen = Boolean(picker || ask || plan || buy);
  modalOpenRef.current = modalOpen;
  // The sidebar card: two rows beside the working line. It costs no row of its
  // own — its second row takes the blank row under the working line, which is
  // why the bottom block drops its margin while it is up — and it is drawn only
  // where the working line was granted, since that is what it sits beside.
  const card = busy && !modalOpen && adSlots.sidebar_card ? sidebarCard(adSlots.sidebar_card.text, cols) : null;
  // The status bar: one row, `sponsorRow`'s rules, under the status line.
  const statusBarLine =
    busy && !modalOpen && adSlots.status_bar ? sponsorRow(adSlots.status_bar.text, cols, "network") : null;

  // One row is left free at the bottom: ink appends a newline to a frame that
  // does not fill the viewport, and a frame that exactly fills it is already
  // the "fullscreen" case we are staying out of.
  //
  // `rows - 1` and nothing else. This used to floor at 6, which is above the
  // terminal itself once it is shorter than seven rows — a budget that cannot
  // be met by construction, so the frame overflowed on the first paint and ink
  // cleared the screen to draw a prompt nobody could have read anyway.
  const viewport = Math.max(1, rows - 1);

  // The input box, never cut — but capped, so a pasted essay scrolls inside the
  // box instead of pushing the whole frame past the viewport.
  const inputRows = Math.max(1, Math.min(MAX_INPUT_ROWS, editor.lines.length));
  const inputFrom = windowStart(editor.row, editor.lines.length, inputRows);
  // Queued messages sit above the box in the same column, so they are chrome
  // and have to be counted: an uncounted row makes the box drift for as long as
  // anything is waiting. Past three they become a count — a queue is a
  // reminder, not a transcript — and each is fitted to one row, because a
  // queued message is arbitrary user text and `⏳` is two columns wide.
  const queuedRows = [
    ...queueView.slice(0, MAX_QUEUE_ROWS).map((line) => line.replace(/\s+/g, " ")),
    ...(queueView.length > MAX_QUEUE_ROWS ? [`+${queueView.length - MAX_QUEUE_ROWS} more queued`] : []),
  ].map((line) => fitRow(`  ${QUEUE_MARKER} ${line}`, cols));

  // Everything below is drawn inside a bordered, padded box, so it has four
  // fewer columns than the terminal. Measuring it at `cols` counts a line of
  // `cols - 3` columns as one row and renders it as two.
  const inner = dialogInner(cols);

  /**
   * What a modal needs before it is worth drawing at all.
   *
   * A dialog is not optional in the way the status line is — a permission
   * prompt that does not fit is a turn nobody can answer — so the space it
   * needs is reserved *first*, and the chrome around it gives way instead.
   */
  // What the purchase dialog cannot do without: its chrome and the two
  // declarations whole. Unlike every other modal here it reserves its *content*
  // rather than one row of it, because a clipped declaration is not a shorter
  // dialog — it is a different one. The status line and the input's border give
  // way to it, which is what `modalFloor` is for.
  const buyEssential = buy ? lineCount(buyDeclarationLines(buy.pack), inner) : 0;
  const modalFloor = picker
    ? PICKER_CHROME_COMPACT + 1
    : ask
      ? ASK_CHROME + 1
      : plan
        ? PLAN_CHROME + 1
        : buy
          ? BUY_CHROME + buyEssential
          : 0;

  /**
   * The chrome, granted in order of what it is worth, while there is room.
   *
   * The budget used to be a subtraction that could go negative and a set of
   * `Math.max(1, …)` floors that could not be met, so on a short terminal — or
   * with a dialog open, which is the ordinary case — the frame simply came out
   * taller than the screen. It is a hard cap now: whatever is left after the
   * input box and the modal floor is handed out, best first, and anything that
   * does not fit is not drawn.
   *
   * The working line leads because "esc to stop" is the one promise the REPL
   * has to keep. The status line is reference material. The queue is a
   * reminder. The sponsored line is ours, and is the first thing we give up.
   */
  let slack = Math.max(0, viewport - inputRows - modalFloor - menu.length);
  const grant = (want: number) => {
    if (want <= 0 || want > slack) return 0;
    slack -= want;
    return want;
  };
  // The border around the input is the first thing granted and the last given
  // up: it is two rows of decoration, and the `❯` on its own is still a prompt.
  // Eight rows cannot hold a bordered box, a permission dialog and a free row —
  // and a dialog that does not fit is a turn nobody can answer, so the frame
  // goes first.
  const inputBorder = grant(2) > 0;
  const busyHeight = grant(busy ? 2 : 0); // marginTop + the line itself
  const showStatus = grant(2) > 0;
  const queueRows = grant(queuedRows.length) > 0 ? queuedRows : [];
  const showSponsor = grant(sponsorLine ? 1 : 0) > 0;
  // Granted last, so it is the first thing given up. It sits under the status
  // line and only there: with the status line gone, or replaced by a menu's or
  // ctrl+c's hint, a row under it would read as part of what the person is
  // being told.
  const showStatusBar = grant(statusBarLine && showStatus && !quitHint && menu.length === 0 ? 1 : 0) > 0;
  const showCard = busyHeight > 0 && card !== null;

  const inputBoxHeight = inputRows + (inputBorder ? 2 : 0);
  const chromeHeight =
    inputBoxHeight + (showStatus ? 2 : 0) + (showSponsor ? 1 : 0) + (showStatusBar ? 1 : 0) + queueRows.length;

  // What the frame actually carries, for `drawnRef`: an impression is reported
  // only if its row was drawn, and the effect runs after the commit that drew
  // it. A key rather than the array, so the effect runs when what is on screen
  // changes rather than on every spinner tick.
  const drawnKey = [
    showSponsor && sponsorLine?.origin === "network" ? sponsor?.impressionId : undefined,
    showCard ? adSlots.sidebar_card?.impressionId : undefined,
    showStatusBar ? adSlots.status_bar?.impressionId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  useEffect(() => {
    for (const id of drawnKey.split(" ")) if (id) drawnRef.current.add(id);
  }, [drawnKey]);
  // The completion menu is chrome too, and each of its rows is fitted below so
  // that `menu.length` is a row count rather than an item count.
  let budget = Math.max(0, viewport - chromeHeight - menu.length - busyHeight);

  // The picker scrolls under the selection rather than growing without limit:
  // the catalog is already fourteen models and a short terminal has no room for
  // fourteen rows plus its own chrome. Where even the chrome does not fit, the
  // subtitle and the two spacer rows go and the box closes up: eight rows of
  // frame around one row of list is not a picker.
  const pickerCompact = Boolean(picker) && budget < PICKER_CHROME + 1;
  const pickerChrome = pickerCompact ? PICKER_CHROME_COMPACT : PICKER_CHROME;
  const pickerRows = picker
    ? Math.max(1, Math.min(MAX_PICKER_ROWS, picker.items.length, budget - pickerChrome))
    : 0;
  const pickerFrom = picker ? windowStart(pickerSel, picker.items.length, pickerRows) : 0;
  const pickerItems = picker ? picker.items.slice(pickerFrom, pickerFrom + pickerRows) : [];
  const pickerHeight = picker ? pickerItems.length + pickerChrome : 0;
  // What the 1-9 shortcut may address; read at key time, written at render.
  pickerWindowRef.current = { from: pickerFrom, count: pickerItems.length };
  // The label column never takes more than three fifths of the box, so the hint
  // beside it always has somewhere to go. Measured in columns: `padEnd` pads by
  // code units, and a model id is not guaranteed to be ASCII forever.
  const pickerLabelW = picker
    ? Math.min(
        Math.max(1, Math.floor(inner * 0.6)),
        picker.items.reduce((w, i) => Math.max(w, visibleLength(i.label)), 0),
      )
    : 0;
  /**
   * Every picker row, pre-fitted to exactly one terminal row.
   *
   * `pickerHeight` counts one row per item, so each one has to *be* one row.
   * They are three `<Text>` siblings in a flex row, and below about 78 columns
   * — an ordinary width for a terminal beside an editor — ink wrapped each of
   * them independently and the pieces landed on top of each other:
   * `gemini-2.5-flash-litecompletion`. Every item then cost two rows against a
   * budget that had counted one, and opening `/model` at 60 columns produced a
   * 41-row frame in a 24-row terminal.
   *
   * The marker is reserved first (it says which model is loaded, and losing it
   * is worse than losing a few characters of the hint), then the label, then
   * the hint takes what is left.
   */
  const pickerViewRows = pickerItems.map((item, i) => {
    const index = pickerFrom + i;
    const marker = item.current ? PICKER_CURRENT : "";
    const markerW = Math.min(visibleLength(marker), Math.max(0, inner - MIN_PICKER_LABEL_COLS));
    const head = fitRow(
      `${index === pickerSel ? "❯ " : "  "}${i + 1}. ${padColumns(item.label, pickerLabelW + 2)}`,
      Math.max(1, inner - markerW),
    );
    const room = inner - visibleLength(head) - markerW;
    return {
      key: item.value,
      selected: index === pickerSel,
      head,
      hint: room > 1 ? fitRow(item.hint, room) : "",
      marker: markerW >= visibleLength(marker) ? marker : "",
    };
  });
  const pickerTitle = picker ? fitRow(picker.title, inner) : "";
  const pickerSubtitle = picker ? fitRow(picker.subtitle, inner) : "";
  // Widest phrasing that fits: the tail is `esc cancel`, and a picker whose
  // hint has been truncated past it is a modal with no visible way out.
  const pickerHint = picker
    ? pickHint(
        picker.items.length > pickerItems.length
          ? [
              `↑↓ choose (${pickerFrom + 1}-${pickerFrom + pickerItems.length} of ${picker.items.length}) · 1-${pickerItems.length} jump · ⏎ confirm · esc cancel`,
              `↑↓ ${pickerFrom + 1}-${pickerFrom + pickerItems.length}/${picker.items.length} · ⏎ confirm · esc cancel`,
              "↑↓ · ⏎ · esc",
            ]
          : [
              `↑↓ choose · 1-${Math.min(9, pickerItems.length)} jump straight to a row · ⏎ confirm · esc cancel`,
              `↑↓ choose · 1-${Math.min(9, pickerItems.length)} jump · ⏎ confirm · esc cancel`,
              "↑↓ · ⏎ · esc",
            ],
        inner,
      )
    : "";
  budget -= pickerHeight;

  // The permission dialog: a diff is the one preview that is routinely longer
  // than the screen, and its *end* is the part that matters least, so the head
  // is what survives the clip.
  //
  // The summary is clipped too, and has to be. It is a path — `overwrite
  // src/components/very/deeply/nested/thing.tsx` — so on a narrow terminal it
  // wraps to three or four rows on its own, and `modalFloor` only reserves one.
  // Its head survives for the preview's reason: which file, not which suffix.
  const askSummary = ask ? headRows(ask.req.summary, inner, Math.max(1, budget - ASK_CHROME)) : "";
  const askSummaryRows = ask ? lineCount(askSummary, inner) : 0;
  // `Math.max(0, …)`, not `1`: where the summary has taken the room, there is
  // no preview rather than a forced row the budget cannot pay for.
  const askPreview = ask?.req.preview
    ? headRows(ask.req.preview, inner, Math.max(0, budget - ASK_CHROME - askSummaryRows))
    : "";
  const askHeight = ask ? askSummaryRows + (askPreview ? lineCount(askPreview, inner) : 0) + ASK_CHROME : 0;
  budget -= askHeight;

  // The plan awaiting approval. Its head survives the clip for the diff's
  // reason: the first lines say what is about to be done.
  // Measured after `renderMarkdown`, because that is what is drawn: a heading
  // loses its `##` and a bullet gains a glyph, so the marked-up source and the
  // rendered block are not the same number of columns.
  const planBlock = plan
    ? headRows(renderMarkdown(plan.plan), inner, Math.max(1, budget - PLAN_CHROME))
    : "";
  const planHeight = plan ? lineCount(planBlock, inner) + PLAN_CHROME : 0;
  budget -= planHeight;

  // The purchase confirmation. Its head survives the clip for the plan's
  // reason, sharpened: the first lines are what is about to be bought and the
  // two declarations that make buying it lawful — and where even those do not
  // fit, the dialog says so instead of showing half of one. The title and the
  // spacer go first, the picker's compact form for the picker's reason.
  const buyCompact = Boolean(buy) && budget < BUY_CHROME + 1;
  const buyChrome = buyCompact ? BUY_CHROME_COMPACT : BUY_CHROME;
  const buyRoom = Math.max(1, budget - buyChrome);
  const buyFits = Boolean(buy) && buyRoom >= buyEssential;
  const buyBlock = buy
    ? headRows(buyFits ? buyConfirmLines(buy.pack) : BUY_TOO_SHORT, inner, buyRoom)
    : "";
  const buyHeight = buy ? lineCount(buyBlock, inner) + buyChrome : 0;
  budget -= buyHeight;
  // Read by the key handler, written here: `yes` is only an answer to a
  // question that was actually put. Same shape as `pickerWindowRef`, and for
  // the same reason — only the render knows what ended up on screen.
  buyFitsRef.current = buyFits;

  const liveRaw = [
    // Trailing blank lines are rows the clamp would spend on nothing, and a
    // streamed answer ends on one more often than not.
    (live?.text ?? "").replace(/\n+$/, ""),
    live?.tool ? `⏺ ${live.tool.name} ${live.tool.summary}` : "",
    live?.tool?.output ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  // Whatever is left, minus its own marginTop. The tail is what survives here:
  // streaming text is read at the bottom.
  const liveBlock = tailRows(liveRaw, cols, Math.max(0, budget - 1));
  const liveHeight = liveBlock ? lineCount(liveBlock, cols) + 1 : 0;

  // Measuring the scrollback re-renders markdown, so keep it off the spinner's
  // 120 ms path: it only changes when a turn commits or the terminal resizes.
  // Per-entry heights are cached because the reduce walks every entry that has
  // ever been committed, and re-rendering a whole session's markdown to place
  // one new row is work that grows with the conversation.
  const printed = useMemo(() => {
    if (heightCacheRef.current.cols !== cols) heightCacheRef.current = { cols, heights: new Map() };
    const cache = heightCacheRef.current.heights;
    return entries.reduce((n, e) => {
      let h = cache.get(e.id);
      if (h === undefined) {
        h = entryHeight(e, cols);
        cache.set(e.id, h);
      }
      return n + h;
    }, 0);
  }, [entries, cols]);

  // Pin the box to the bottom. Every term above has already been clipped to
  // fit, so this can only ever be the slack.
  //
  // **The slack is measured against what is still on screen, not against
  // everything ever printed.** It was `viewport - printed - used`, which is
  // right only until the terminal scrolls — and a frame that grows scrolls it:
  // the command menu under a typed `/`, the `/model` picker, a dialog, a tall
  // input. Once the scrollback was long enough for the spacer to be zero, that
  // growth pushed committed rows off the top, and when the menu closed the
  // frame shrank back while nothing came down to meet it. Ink erased the rows
  // it had written and painted fewer, so the input box stood in the middle of
  // the screen with empty rows under it that the terminal let you scroll into —
  // after every slash command, since typing the slash is what opens the menu.
  //
  // Scrolled-off rows cannot be brought back without clearing the screen and
  // replaying the whole session, which is the one thing this layout exists to
  // avoid. So the rows the frame gives up are kept as spacer *above* it: the
  // box, the status line and everything under the scrollback stay exactly
  // where they were, and the next committed output fills the gap. `onScreen`
  // is how many committed rows are still visible above the frame: whatever was
  // there after the last commit plus what has been committed since, less what
  // a frame taller than the room left for it has pushed off the top. A new
  // `<Static>` (`/clear`), a resize or a shorter scrollback starts it again
  // from `printed`, which is where the old formula always stood — so on a
  // screen that has never scrolled the two agree to the row.
  const used =
    chromeHeight + menu.length + pickerHeight + askHeight + planHeight + buyHeight + busyHeight + liveHeight;
  const lastScreen = screenRef.current;
  const freshScreen =
    !lastScreen ||
    lastScreen.epoch !== staticEpoch ||
    lastScreen.rows !== rows ||
    lastScreen.cols !== cols ||
    printed < lastScreen.printed;
  const onScreen = Math.max(
    0,
    Math.min(freshScreen ? printed : lastScreen.onScreen + (printed - lastScreen.printed), viewport - used),
  );
  const spacer = Math.max(0, viewport - onScreen - used);
  // Recorded after the commit rather than here: a render React throws away
  // was never painted, and must not be remembered as having scrolled anything.
  useLayoutEffect(() => {
    screenRef.current = { epoch: staticEpoch, rows, cols, printed, onScreen };
  });

  // Measured in columns, like the picker's: a suggestion is a file path, and a
  // repository is allowed to have non-ASCII names in it.
  const labelW = Math.min(
    Math.max(1, Math.floor(cols * 0.5)),
    menu.reduce((w, c) => Math.max(w, visibleLength(c.label)), 0),
  );

  /**
   * How full the context is, once it is worth knowing.
   *
   * Compaction happens silently at 75% and costs a model call, so the first the
   * user knew of it was a notice saying it had already happened. Shown from 60%
   * on and not before: a percentage that reads 4% all day is a number nobody
   * looks at, which is how a status line stops being read at all. Memoised
   * because the estimate walks every message and the spinner re-renders eight
   * times a second.
   */
  const conversationUsed = useMemo(
    () => conversationTokens([{ role: "system", content: contextRef.current.systemPrompt }, ...messages]),
    [messages],
  );
  const contextPct = useMemo(() => {
    const window = contextWindow(model);
    if (!window) return 0;
    return conversationUsed / window;
  }, [contextWindow, conversationUsed, model]);

  // What the tool schema adds to every call, which the conversation estimate
  // above does not count. Per mode, since plan mode advertises fewer tools.
  const schemaTokens = useMemo(
    () =>
      estimateTokens(
        JSON.stringify(toolSchemaFor(mode, mcpRef.current.toolSchemas(), { webSearch: searchRef.current })),
      ),
    [mode],
  );

  /**
   * Roughly what the task being typed will cost, and whether the wallet covers
   * it: the cost preview.
   *
   * Only while something is being typed that will become a model call, so not
   * for a slash command or a `!command`, and not while a turn runs, when the
   * status line is reporting what is being spent rather than what might be.
   * Absent whenever the gateway sent no task shape or the catalog has not
   * arrived, rather than built on a guess. See `estimate.ts` for why this is
   * the one figure the CLI multiplies out itself.
   */
  const typed = ed.toText(editor);
  let estimate: { variants: string[]; warn: boolean } | undefined;
  const info = catalogRef.current.find((m) => m.id === model);
  // What a call on this model may spend right now, from figures that belong to
  // the balance on screen and to today (`spendable`), and only when the
  // catalog says which kind of model it is. Anything less certain leaves the
  // bare balance, which claims nothing about what can be spent.
  const usable: StatusUsable | undefined = (() => {
    const s = spendable;
    if (!s || balance === undefined || s.balance !== balance || s.day !== utcDay() || !info?.access) return undefined;
    const credits = Math.max(0, Math.min(balance, info.access === "premium" ? s.figures.premium : s.figures.budget));
    return {
      kind: info.access,
      credits,
      locked: Math.max(0, balance - credits),
      afterReset: Math.max(credits, Math.min(balance, s.figures.budgetAfterReset)),
    };
  })();
  // The setting this model runs at, as the gateway will resolve it. Before the
  // catalog has arrived the saved value is shown as it is.
  const effortNow = info ? resolveEffort(info, effortBy[model]) : effortBy[model];
  const shape = client.taskShape;
  // No preview on a raised setting: `task_shape` was measured at the models'
  // defaults, so it would understate exactly the tasks that think longer, and
  // a preview shown too low is the one that meets the paywall halfway. A
  // lowered setting keeps it, since there it errs toward a dearer figure.
  if (
    !busy &&
    info &&
    shape &&
    balance !== undefined &&
    !effortRaised(info, resolveEffort(info, effortBy[model])) &&
    typed.trim() !== "" &&
    !/^[/!]/.test(typed.trimStart())
  ) {
    const range = estimateTask(info, conversationUsed + schemaTokens + estimateTokens(typed), shape);
    const onFree = Boolean(info.free && freeTier?.models.includes(model));
    // On a premium model only the credits premium takes count (2026-10-04): a
    // balance of bonus credits shown as covering the task would be a preview
    // for a turn the gateway is about to refuse. Unknown counts the balance,
    // as it did before the rule.
    //
    // Since 2026-10-12 the gateway's own figure for this kind of model, when it
    // belongs to the balance on screen: past the daily limit on bonus credits a
    // budget model is in the same position, and the preview said "covered"
    // over a wallet the gateway was about to refuse.
    const canSpend = usable
      ? usable.credits
      : info.access === "premium" && premium && !premium.unlocked
        ? Math.min(balance, premium.credits)
        : balance;
    const verdict = taskVerdict(range, {
      balance: canSpend,
      ...(onFree ? { freeLeft: freeTier!.credits_left } : {}),
    });
    estimate = estimateClause(range, verdict, !onFree && (freeTier?.credits_left ?? 0) > 0);
  }

  // The status line, fitted to one row before anything is drawn.
  //
  // The mode leads it in its own colour and is never cut — it is the only
  // clause that changes what the agent is allowed to do. What follows is
  // reference material and gives up clauses, lowest rank first, rather than
  // wrapping onto a second row `chromeHeight` never counted.
  const modeText = `  ${MODE_STYLE[mode].glyph} ${MODE_LABEL[mode]}`;
  const statusText = fitRow(
    `  ${statusLine(
      {
        model,
        ...(effortNow ? { effort: effortNow } : {}),
        balance,
        ...(usable ? { usable } : {}),
        spent,
        contextPct,
        minutes: (Date.now() - runStartedAtRef.current) / 60_000,
        // Only while a free model is selected: on a premium one the allowance
        // is real but irrelevant, and a countdown that has nothing to do with
        // the next turn is a number that teaches people to stop reading the row.
        ...(freeTier?.models.includes(model) ? { freeLeft: freeTier.credits_left } : {}),
        ...(estimate ? { estimate: estimate.variants } : {}),
      },
      Math.max(1, cols - visibleLength(modeText) - 2),
    )}`,
    Math.max(0, cols - visibleLength(modeText)),
  );
  // The estimate is drawn as a warning when the wallet does not cover it, and
  // only when it survived the fitting whole: a clause cut in half is not
  // coloured, since the colour would then be doing the talking for words that
  // are not on screen. Splitting the one fitted string, rather than fitting
  // three, is what keeps it one row.
  const statusParts: { before: string; warn?: string; after: string } = (() => {
    const shown = estimate?.warn ? estimate.variants.find((v) => statusText.includes(v)) : undefined;
    if (shown === undefined) return { before: statusText, after: "" };
    const at = statusText.indexOf(shown);
    return { before: statusText.slice(0, at), warn: shown, after: statusText.slice(at + shown.length) };
  })();
  // The row that replaces it while a menu is open or ctrl+c is pending.
  const hintText = quitHint
    ? fitRow("  press ctrl+c again to quit", cols)
    : `  ${pickHint(
        ["↑↓ choose · ⏎ run · tab complete · esc close", "↑↓ · ⏎ run · tab · esc", "↑↓ ⏎ tab esc"],
        Math.max(1, cols - 2),
      )}`;
  // Completion rows, fitted for the picker's reason: `menu.length` is spent as
  // a row count, and a label and a hint that wrap independently both overflow
  // the budget and print the hint's tail at column zero.
  const menuRows = menu.map((item, i) => {
    const head = fitRow(`${i === sel ? "  ❯ " : "    "}${padColumns(item.label, labelW + 2)}`, cols);
    const room = cols - visibleLength(head);
    return { key: item.value, selected: i === sel, head, hint: room > 1 ? fitRow(item.hint, room) : "" };
  });
  // The working line. `busyHeight` reserves exactly two rows for it, and the
  // duck is two columns wide, so it is fitted like every other counted row.
  // Beside the card it has the columns the card leaves, and no more.
  const busyCols = showCard ? cols - SIDEBAR_CARD_COLS : cols;
  const busyText = fitRow(
    `${busyLabel} ${elapsed}s · esc to stop`,
    Math.max(1, busyCols - visibleLength(`${spinner} `)),
  );

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={entries}>
        {(entry) => <EntryView key={entry.id} entry={entry} />}
      </Static>

      {spacer > 0 ? <Box height={spacer} /> : null}

      {liveBlock ? (
        <Box marginTop={1}>
          <Text>{liveBlock}</Text>
        </Box>
      ) : null}

      {/*
        The working line, under the last thing written rather than inside the
        input box. It says the same words it always did — the box's "esc to
        stop" was the one promise the REPL had to keep — but it now sits where
        the eye already is, at the end of the output, instead of overwriting the
        prompt with a status message.
      */}
      {/*
        Drawn on `busyHeight`, not on `busy`. The two are not the same: on a
        terminal too short to hold the input box, a dialog and this, the row
        budget refuses it — and a row that is drawn without being counted is
        exactly the overflow the budget exists to prevent. Where it is refused,
        the dialog underneath is saying "esc stops the turn" anyway.
      */}
      {busyHeight > 0 && showCard && card ? (
        /*
          The working line with the sidebar card beside it. Two columns, two
          rows: the working line and the blank row under it on the left, the
          card on the right. The blank row is the one the block below would
          otherwise have spent on its margin, so the frame is exactly as tall
          with the card as without it — the input box does not move when a card
          arrives or goes, and the budget above never had to count it.
        */
        <Box marginTop={1}>
          <Box flexDirection="column" width={busyCols}>
            <Box>
              <Text color={MANGO}>{spinner} </Text>
              <Text dimColor wrap="truncate-end">
                {busyText}
              </Text>
            </Box>
            <Text> </Text>
          </Box>
          <Box flexDirection="column" width={SIDEBAR_CARD_COLS}>
            <Box>
              <Text dimColor>{card.rule}</Text>
              <Text {...(adColor ? { color: AD_MARK } : { dimColor: true })} wrap="truncate-end">
                {card.label}
              </Text>
            </Box>
            <Box>
              <Text dimColor>{card.rule}</Text>
              <Text {...(adColor ? { color: AD_TEXT } : { dimColor: true })} wrap="truncate-end">
                {linkable && adSlots.sidebar_card?.link ? osc8(card.body, adSlots.sidebar_card.link) : card.body}
              </Text>
            </Box>
          </Box>
        </Box>
      ) : busyHeight > 0 ? (
        <Box marginTop={1}>
          <Text color={MANGO}>{spinner} </Text>
          <Text dimColor wrap="truncate-end">
            {busyText}
          </Text>
        </Box>
      ) : null}

      {ask ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            {askSummary}
          </Text>
          {askPreview ? <Text>{askPreview}</Text> : null}
          <Text dimColor wrap="truncate-end">{pickHint(ASK_HINT, inner)}</Text>
        </Box>
      ) : null}

      {/*
        The exit from plan mode — the thing plan mode did not have. The model
        used to be told to "let the user approve it" and the user had nothing to
        approve with: the only way out was shift+tab and retyping the request,
        which then landed on a conversation where the model's own announced plan
        was already sitting. Approving here continues the same turn.
      */}
      {plan ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={MODE_STYLE.plan.color} paddingX={1}>
          <Text bold color={MODE_STYLE.plan.color} wrap="truncate-end">
            {fitRow(`${MODE_STYLE.plan.glyph} Ready to act on this plan?`, inner)}
          </Text>
          <Box height={1} />
          <Text>{planBlock}</Text>
          <Text dimColor wrap="truncate-end">
            {pickHint(autoModeOffered(catalogRef.current, model) ? PLAN_HINT : PLAN_HINT_NO_AUTO, inner)}
          </Text>
        </Box>
      ) : null}

      {/*
        The purchase confirmation. It is the last thing before Stripe's page and
        the only place the two § 356 (5) declarations are put to anybody, so the
        field below is drawn whatever the terminal's height: `BUY_CHROME` counts
        it, and the block above it is what gives way instead.
      */}
      {buy ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={MANGO} paddingX={1}>
          {buyCompact ? null : (
            <Text bold color={MANGO_BRIGHT} wrap="truncate-end">
              {fitRow("Buy credits", inner)}
            </Text>
          )}
          {buyCompact ? null : <Box height={1} />}
          <Text>{buyBlock}</Text>
          <Box>
            <Text color={MANGO_BRIGHT}>❯ </Text>
            <Text bold wrap="truncate-end">{fitRow(buy.typed, Math.max(1, inner - 2))}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{pickHint(BUY_HINT, inner)}</Text>
        </Box>
      ) : null}

      {picker ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={MANGO} paddingX={1}>
          <Text bold color={MANGO_BRIGHT}>
            {pickerTitle}
          </Text>
          {pickerCompact ? null : <Text dimColor>{pickerSubtitle}</Text>}
          {pickerCompact ? null : <Box height={1} />}
          {/*
            Every row is built and fitted in the layout above, so what is drawn
            here is exactly what was counted. Ink must not be left to wrap these
            three siblings itself: below ~78 columns it wrapped each one
            separately and they collided into each other.
          */}
          {pickerViewRows.map((row) => (
            <Box key={row.key}>
              <Text color={row.selected ? MANGO_BRIGHT : undefined} bold={row.selected} wrap="truncate-end">
                {row.head}
              </Text>
              {row.hint ? (
                <Text dimColor wrap="truncate-end">
                  {row.hint}
                </Text>
              ) : null}
              {row.marker ? <Text color="green">{row.marker}</Text> : null}
            </Box>
          ))}
          {pickerCompact ? null : <Box height={1} />}
          <Text dimColor>{pickerHint}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={showCard ? 0 : 1}>
        {/*
          House content, ours, shown only while a model call is in flight.

          It sits in the bottom re-rendered region, never in <Static>, so it
          cannot interleave with or corrupt model output: committed turns are
          written once and never rewritten, and this line is repainted with the
          rest of the chrome on every frame. Ink owns the ordering; nothing here
          writes to stdout directly.
        */}
        {/* What is waiting behind the turn in flight. */}
        {queueRows.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}

        {/* The top bar. Its pieces and colours are `SponsorRowView`'s. */}
        {showSponsor && sponsorLine ? (
          <SponsorRowView row={sponsorLine} adColor={adColor} link={linkable ? sponsor?.link : undefined} />
        ) : null}

        {/*
          The box is only ever the input, and it is live even mid-turn: what you
          type while the agent works is queued and sent when it finishes. It was
          briefly drawn dim and cursorless, back when a turn really did swallow
          every keystroke — a caret over a box that ignores you is a lie, but so
          is a dead-looking box that is listening.
        */}
        {inputBorder ? (
          <Box borderStyle="round" borderColor={busy ? MANGO : MANGO_BRIGHT} paddingX={1}>
            <Text color={MANGO_BRIGHT}>❯ </Text>
            <Text>{renderInput(editor, inputFrom, inputRows)}</Text>
          </Box>
        ) : (
          <Box>
            <Text color={MANGO_BRIGHT}>❯ </Text>
            <Text>{renderInput(editor, inputFrom, inputRows)}</Text>
          </Box>
        )}

        {menuRows.map((row) => (
          <Box key={row.key}>
            <Text color={row.selected ? MANGO_BRIGHT : MANGO} bold={row.selected} wrap="truncate-end">
              {row.head}
            </Text>
            {row.hint ? (
              <Text dimColor={!row.selected} wrap="truncate-end">
                {row.hint}
              </Text>
            ) : null}
          </Box>
        ))}

        {/*
          The status line. The permission mode leads it and wears its own
          colour, because it is the only clause that changes what the agent is
          allowed to do — grey among five other grey clauses meant shift+tab
          moved it and nothing on screen looked different. Everything after it
          is dim: a model id and a balance are reference, not state.
        */}
        {!showStatus ? null : quitHint || menu.length > 0 ? (
          <Text dimColor wrap="truncate-end">
            {hintText}
          </Text>
        ) : (
          <Box>
            <Text color={MODE_STYLE[mode].color} bold wrap="truncate-end">
              {modeText}
            </Text>
            {statusParts.warn === undefined ? (
              <Text dimColor wrap="truncate-end">
                {statusText}
              </Text>
            ) : (
              <>
                <Text dimColor>{statusParts.before}</Text>
                <Text color="yellow">{statusParts.warn}</Text>
                <Text dimColor wrap="truncate-end">
                  {statusParts.after}
                </Text>
              </>
            )}
          </Box>
        )}

        {/*
          The status bar: ADtention's third format, a row of its own under the
          status line rather than a clause inside it. The status line is the
          person's own reference material — mode, model, balance — and cutting
          a clause of that to make room for somebody else's copy would be the
          wrong way round. Same row as the top bar, same mark, same accent.
        */}
        {showStatusBar && statusBarLine ? (
          <SponsorRowView row={statusBarLine} adColor={adColor} link={linkable ? adSlots.status_bar?.link : undefined} />
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * One sponsored row: the top bar, and the status bar, which is the same row in
 * a different place.
 *
 * Three pieces, because they are three colours. The mark leads the copy — a
 * label after the thing it qualifies tells you what you have already read — and
 * it is the piece that is never cut: `sponsorRow` takes its five columns off the
 * copy's budget first, and drops the whole row before it would drop the mark.
 */
function SponsorRowView({ row, adColor, link }: { row: SponsorRow; adColor: boolean; link?: string | undefined }): React.ReactElement {
  return (
    <Box>
      <Text dimColor wrap="truncate-end">
        {row.marker}
      </Text>
      {row.label ? (
        <Text {...(adColor ? { color: AD_MARK } : { dimColor: true })} wrap="truncate-end">
          {row.label}
        </Text>
      ) : null}
      <Text {...(adColor && row.origin === "network" ? { color: AD_TEXT } : { dimColor: true })} wrap="truncate-end">
        {link && row.origin === "network" ? osc8(row.body, link) : row.body}
      </Text>
    </Box>
  );
}

/**
 * Sleep that gives up the instant the signal aborts.
 *
 * A plain `setTimeout` between polls would swallow the keystroke for up to one
 * interval, so esc would feel broken even once it is wired up. Already-aborted
 * resolves immediately: `addEventListener` never fires on a spent signal.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The input with a block cursor drawn at the caret, windowed to `rows` lines.
 *
 * The window is what keeps a pasted essay from pushing the whole frame past the
 * viewport — see the layout comment. `from` is chosen so the caret is always
 * inside it, so scrolling is invisible until the buffer is genuinely too tall.
 */
function renderInput(state: ed.EditorState, from: number, rows: number): React.ReactNode {
  return state.lines.slice(from, from + rows).map((line, i) => {
    const row = from + i;
    const prefix = i === 0 ? "" : "\n";
    if (row !== state.row) return <Text key={row}>{prefix + line}</Text>;
    const before = line.slice(0, state.col);
    const at = line.slice(state.col, state.col + 1) || " ";
    const after = line.slice(state.col + 1);
    return (
      <Text key={row}>
        {prefix + before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    );
  });
}

/**
 * Everything on the status line that is *not* the permission mode.
 *
 * The mode is rendered separately and coloured, so it is deliberately absent
 * here; what is left is reference material and reads as one dim run.
 *
 * ## It has to come back as one row, and it did not
 *
 * `chromeHeight` counts this as a single row, and the input box is pinned to
 * the bottom by that count. Nothing used to hold it to one: with spend, a burn
 * rate and a context warning all present it reaches 101 columns, so in an
 * 80-column terminal — the most ordinary width there is — it silently became
 * two rows and the box sat one row too high for the rest of the session. At 24
 * columns it became four.
 *
 * So the clauses are **dropped by rank** before anything is cut. Which one goes
 * first is a judgement about what the row is for: the model and the balance are
 * what the user is spending and what they have left, and they never go. `/help`
 * is a fixed hint that never changes and is the first to go; the burn rate is
 * derived from the spend beside it; the spend is a subtotal of the balance; the
 * context warning outlasts those, because it is *news*: it appears at 60% to say
 * a compaction is coming. The cost preview outlasts everything optional, since
 * it exists only while a task is being typed and answers the question the
 * person is asking at that moment: what will this cost, and can I afford it.
 *
 * `fitRow` is the backstop for a terminal too narrow for even the model id.
 */
/**
 * What one row of the model picker says about cost.
 *
 * A **free** model leads with what the allowance still buys on it, because that
 * is the number the row exists to make comparable: the same 60,000 credits is
 * roughly 250 turns on the cheapest model in the set and 25 on the
 * dearest, and somebody choosing between them cannot see that anywhere else.
 * The effort estimate follows it, since a free model still costs offers once
 * the day is spent.
 *
 * The turn count is **the gateway's arithmetic**, arriving finished in
 * `turns_left`. This program cannot import the pricing engine, so a division done
 * here would be a figure nothing forces to agree with what is actually metered —
 * the rule `grantLabel` and `streakLabel` both follow.
 *
 * Three states, and the difference between the last two matters. `free` with
 * turns left says how many. `free` with the day spent says so in words rather
 * than printing "≈0 free turns", which reads as a broken estimate rather than as
 * a spent allowance. A model outside the set says nothing about free at all —
 * silence, not "not free", because a row that has never been free has nothing to
 * report.
 */
export function modelHint(
  m: ModelInfo,
  free: { models: string[]; turns_left: Record<string, number> } | undefined,
): string {
  const effort = adsPerTaskLabel(m.est_ads_per_task);
  // `m.free` is the catalog's own flag and `free.models` is this account's
  // allowance; both have to agree before a row claims to be free, so a paused
  // tier (which answers with an empty allowance) cannot leave "free" on screen.
  if (!m.free || !free?.models.includes(m.id)) return effort;
  const turns = free.turns_left[m.id] ?? 0;
  if (turns <= 0) return `free: none left today · ${effort}`;
  return `free: ~${turns} turn${turns === 1 ? "" : "s"} left · ${effort}`;
}

/**
 * The meta line under a finished turn.
 *
 * Three shapes, because a turn is one of three things and collapsing them costs
 * the user the only explanation they get for what just happened to their
 * balance. A **paid** turn reads exactly as it always has. A **free** one says
 * what it would have cost and what is left, because "0 credits" alone is a
 * number somebody will assume is a bug. A **mixed** one — the allowance ran out
 * mid-turn, which is the ordinary way it ends — says both, since neither figure
 * on its own describes what was spent.
 *
 * Every number here came off the wire from the gateway; nothing is derived. The
 * CLI cannot import the pricing engine, so a figure computed in this file would
 * be a literal nothing forces to agree with what was actually metered.
 */
export function turnMeta(result: {
  creditsCharged: number;
  creditsWaived: number;
  freeCreditsLeft?: number;
  balance: number;
}): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const balance = `balance ${n(result.balance)}`;
  if (result.creditsWaived <= 0) return `[${n(result.creditsCharged)} credits · ${balance}]`;
  const left =
    result.freeCreditsLeft === undefined ? "" : ` · ${n(result.freeCreditsLeft)} free credits left`;
  if (result.creditsCharged > 0) {
    return `[free: ${n(result.creditsWaived)} credits · then ${n(result.creditsCharged)} charged · ${balance}]`;
  }
  return `[free · ${n(result.creditsWaived)} credits waived${left}]`;
}

/**
 * What a call on the model in use may spend right now (2026-10-12), from the
 * gateway's figures: `credits` of the balance, with `locked` held back. On a
 * budget model the bonus credits past today's limit, which `afterReset` says
 * how far 00:00 UTC lets through; on a premium model the bonus credits it
 * takes only through the login streak allowance.
 */
export interface StatusUsable {
  kind: "budget" | "premium";
  credits: number;
  locked: number;
  /** What a budget call may spend from 00:00 UTC if nothing changes before then. */
  afterReset: number;
}

/**
 * The phrasings of the locked clause, longest first: what is held back and
 * until when, in fewer words each time. Empty when nothing is held back.
 */
export function lockedPhrasings(u: StatusUsable | undefined): string[] {
  if (!u || u.locked <= 0) return [];
  const n = (v: number) => v.toLocaleString("en-US");
  const locked = `${n(u.locked)} bonus locked`;
  if (u.kind === "premium") return [`${locked} on premium`, locked];
  // All of it back at the reset, or only a day's limit of it: the longest
  // phrasing never says "until 00:00 UTC" about credits that wait longer.
  const back = u.afterReset - u.credits;
  return back >= u.locked
    ? [`${locked} until 00:00 UTC`, locked]
    : back > 0
      ? [`${locked}, ${n(back)} usable from 00:00 UTC`, locked]
      : [locked];
}

/**
 * What `/wallet` adds under the balance when part of it is held back: what a
 * call may spend now on each kind of model, and when the bonus credits over
 * today's limit come back. Nothing when everything can be spent.
 */
export function walletUsableLines(balance: number, f: Spendable): string[] {
  const n = (v: number) => Math.max(0, v).toLocaleString("en-US");
  const budget = Math.min(balance, f.budget);
  const premium = Math.min(balance, f.premium);
  if (budget >= balance && premium >= balance) return [];
  const lines = [`usable now: ${n(budget)} credits on budget models, ${n(premium)} on premium models`];
  const locked = balance - budget;
  if (locked > 0) {
    const back = Math.min(balance, Math.max(budget, f.budgetAfterReset)) - budget;
    lines.push(
      back >= locked
        ? `${n(locked)} bonus credits are over today's limit and become usable at 00:00 UTC`
        : back > 0
          ? `${n(locked)} bonus credits are over today's limit: ${n(back)} become usable at 00:00 UTC, the rest on later days`
          : `${n(locked)} bonus credits are over today's limit`,
    );
  }
  return lines;
}

/** Below this the context is not worth a word on the status line. */
const CONTEXT_NOTICE_AT = 0.6;
/** Ranks drop lowest-first when the row is too narrow. Model and balance never drop. */
const KEEP_ALWAYS = Number.POSITIVE_INFINITY;

export function statusLine(
  o: {
    model: string;
    /**
     * The `/effort` setting the model runs at, when one is chosen. Ranked with
     * the free allowance: both decide what the next turn costs, and neither is
     * worth the model id or the balance.
     */
    effort?: string;
    /** Undefined while it has not been read, and then the row says so. */
    balance: number | undefined;
    /**
     * What a call on this model may spend, when the gateway said so for this
     * balance. With anything held back it takes the balance's place, as
     * "1,200 cr usable", followed by what is locked; absent, the row shows the
     * balance as it always did, which claims nothing about what can be spent.
     */
    usable?: StatusUsable;
    spent: number;
    /** Fraction of the model's window in use; shown only once it matters. */
    contextPct: number;
    /** Session length, for the burn rate — premium spend should never surprise. */
    minutes: number;
    /**
     * Credits left of today's free allowance, when the current model is one the
     * allowance may be spent on.
     *
     * Undefined on a premium model and on a gateway with no free tier — the two
     * states where there is nothing true to say — and 0 while the day is spent,
     * which is worth a row of its own: `free 0` is how somebody finds out why
     * their balance started moving without reading a notice they scrolled past.
     */
    freeLeft?: number;
    /**
     * The cost preview for the task being typed (`estimateClause`), present only
     * while one is: its phrasings, longest first. Ranked above every other
     * optional clause, because it is the only one that answers a question the
     * person is asking right now, and shortened before it is given up.
     */
    estimate?: string | readonly string[];
  },
  cols: number,
): string {
  const phrasings = o.estimate === undefined ? [] : typeof o.estimate === "string" ? [o.estimate] : [...o.estimate];
  const locked = lockedPhrasings(o.usable);
  // Each phrasing of the preview in turn, then none: a shorter preview is worth
  // more than the clauses below it, and none at all is the last resort. Inside
  // each, the locked clause the same way, ranked just under the preview: the
  // usable figure itself is never dropped, and while a task is typed the
  // preview's verdict is already worked out from it.
  for (const estimate of [...phrasings, undefined]) {
    for (const held of [...locked, undefined]) {
      const line = statusRow(o, estimate, held, cols);
      if (visibleLength(line) <= cols) return line;
    }
  }
  return fitRow(statusRow(o, undefined, undefined, cols), cols);
}

/** One attempt at the status row with given preview and locked phrasings, clauses dropped by rank. */
function statusRow(
  o: Parameters<typeof statusLine>[0],
  estimate: string | undefined,
  locked: string | undefined,
  cols: number,
): string {
  const burn =
    o.spent > 0 && o.minutes >= 1
      ? `${Math.round(o.spent / o.minutes).toLocaleString("en-US")} cr/min`
      : undefined;
  const clauses = [
    { text: o.model, rank: KEEP_ALWAYS },
    // Beside the model it qualifies, and given up with the free allowance.
    { text: o.effort === undefined ? undefined : effortLabel(o.effort), rank: 4 },
    {
      // "? cr" rather than "0 cr": unknown is not empty, and an empty-looking
      // wallet is the one misreading on this row that frightens somebody.
      // With part of the balance held back, what can be spent takes its place:
      // "33,396 cr" over a wallet the gateway refused to spend from was how
      // this row came to be read as a fault (2026-10-12).
      text:
        o.balance === undefined
          ? "? cr"
          : o.usable && o.usable.locked > 0
            ? `${o.usable.credits.toLocaleString("en-US")} cr usable`
            : `${o.balance.toLocaleString("en-US")} cr`,
      rank: KEEP_ALWAYS,
    },
    // Never dropped inside a row: `statusLine` tries its shorter phrasings,
    // then none, as it does for the preview.
    { text: locked, rank: 5 },
    // Above the context warning, below the balance. It is the second number
    // deciding whether the next turn costs anything, and unlike the spend it is
    // *news* — it only exists while a free model is selected and it counts down.
    {
      text: o.freeLeft === undefined ? undefined : `free ${o.freeLeft.toLocaleString("en-US")}`,
      rank: 4,
    },
    { text: estimate, rank: 5 },
    { text: o.spent > 0 ? `−${o.spent.toLocaleString("en-US")}` : undefined, rank: 2 },
    { text: burn, rank: 1 },
    {
      text: o.contextPct >= CONTEXT_NOTICE_AT ? `context ${Math.round(o.contextPct * 100)}%` : undefined,
      rank: 3,
    },
    { text: "/help", rank: 0 },
  ].filter((c): c is { text: string; rank: number } => Boolean(c.text));

  const join = (minRank: number) =>
    clauses
      .filter((c) => c.rank >= minRank)
      .map((c) => c.text)
      .join(" · ");

  let line = join(0);
  // Up to the preview's own rank and no further: a row that is still too wide
  // with only the preview left goes back to `statusLine`, which tries a shorter
  // phrasing and finally none. Without a preview, rank 5 is one more round than
  // there are droppable ranks, so the free clause can itself be dropped before
  // `fitRow` has to cut. Adding a rank without extending this bound is how the
  // row silently became two rows the last time.
  for (let minRank = 1; minRank <= 5 && visibleLength(line) > cols; minRank++) line = join(minRank);
  return line;
}

/**
 * First visible index of a scrolling window that keeps `sel` inside it.
 *
 * Used by both scrolling regions — the model picker and a tall input buffer —
 * so neither can grow the frame past the viewport. Centring the selection is
 * what makes paging feel continuous rather than jumping a screen at a time.
 */
function windowStart(sel: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.max(0, Math.min(total - size, sel - Math.floor(size / 2)));
}

/** Translate an Ink key event into the editor's own key shape. */
function toEditorKey(ch: string, key: InkKey): ed.EditorKey {
  const name = key.leftArrow
    ? "left"
    : key.rightArrow
      ? "right"
      : key.upArrow
        ? "up"
        : key.downArrow
          ? "down"
          : key.backspace
            ? "backspace"
            : key.delete
              ? "delete"
              : undefined;
  return {
    input: name || key.escape || key.tab ? undefined : ch,
    name,
    ctrl: key.ctrl,
    meta: key.meta,
  };
}

/** One-line description of what a tool call is about to do. */
function toolSummary(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return str(args.path);
    case "list_dir":
      return str(args.path) || ".";
    case "glob":
      return str(args.pattern);
    case "grep":
      return str(args.pattern) + (args.path ? ` in ${str(args.path)}` : "");
    case "run_command":
      return str(args.command) + (args.background === true ? "  (background)" : "");
    case "read_output":
    case "kill_shell":
      return str(args.shell_id);
    case "web_search":
      return str(args.query);
    case "web_fetch":
      return str(args.url);
    case "task":
      return str(args.description);
    case "todo_write":
      return Array.isArray(args.todos) ? `${args.todos.length} items` : "";
    case "ask_user":
      return str(args.question);
    default:
      // An MCP tool names its server, which is the part the user needs: two
      // servers can both offer `search`, and only one of them is reading their
      // private issue tracker.
      return name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : "";
  }
}

function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : lines.slice(-max).join("\n");
}
