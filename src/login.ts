/**
 * The login flow, written once for both surfaces that run it.
 *
 * `clixad login` renders it with console.log and the REPL's `/login` renders it
 * as Ink notices, but the flow itself — the dev-shortcut/device-flow choice, the
 * poll loop, the signup-closed case, and what gets written into config.json — is
 * one thing and belongs in one place.
 *
 * It was duplicated for exactly as long as the REPL had no `/login` at all,
 * which is also the reason it had none: a 401 inside the REPL printed "Run
 * `clixad login` first", and typing that at the prompt is not a command — it is
 * a *prompt*, so it went to the model, hit the same 401, and printed the same
 * line again. The instruction the CLI gave was unrunnable where it was given.
 *
 * The renderers stay in their own surfaces. What crosses this boundary is the
 * outcome, never a formatted string: the REPL cannot use ANSI codes and the
 * subcommand cannot use Ink, and a shared "message" field would end up as one
 * of the two dressed up as the other.
 */
import {
  GatewayUnreachableError,
  SignupClosedError,
  type DevicePoll,
  type DeviceStart,
  type GatewayClient,
} from "./client.ts";
import { openBrowser } from "./browser.ts";
import { FALLBACK_MODEL, saveConfig, type CliConfig } from "./config.ts";

/**
 * Where the terms live. Hardcoded rather than imported, for the reason every
 * constant in this program is: it may import nothing but npm packages
 * (`packages: "external"` in build.mjs would leave an unresolvable bare
 * specifier in the published bundle), so the gateway's copy and this one are
 * pinned to each other by a test that can see both.
 */
export const TERMS_URL = "https://clixad.io/terms.html";
export const PRIVACY_URL = "https://clixad.io/privacy.html";

/**
 * Shown before an account is created, on every surface that can create one.
 *
 * Terms nobody was pointed at are terms that do not bind (§ 305 (2) BGB): a
 * footer link on the website does not reach somebody signing in through a
 * device flow in a terminal, and this is the only moment the contract is
 * actually concluded. It is a constant rather than a printed line because this
 * file returns data and never prints — `clixad login` renders it with ANSI and
 * the REPL renders it as an Ink notice, and a pre-formatted string would be one
 * of the two wearing the other's clothes.
 *
 * It has to be rendered *before* `performLogin`, not from inside `verify`: the
 * dev shortcut never reaches `verify`, and it creates an account too.
 */
export const TERMS_NOTICE =
  "By creating an account you confirm that you are at least 18 and that you agree to\n" +
  `the Terms — ${TERMS_URL}\n` +
  `and the Privacy Policy — ${PRIVACY_URL}`;

export interface LoginArgs {
  /** Unlocks a gated signup: an invite code from us, or a referral code from another account. */
  invite?: string;
  /** Present → the dev shortcut, absent → GitHub device flow. */
  email?: string;
}

/** Split `--invite <code>` / `--invite=<code>` out of an argument list. */
export function parseLoginArgs(args: string[]): LoginArgs {
  let invite: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--invite") invite = args[++i];
    else if (a.startsWith("--invite=")) invite = a.slice("--invite=".length);
    else rest.push(a);
  }
  return { invite: invite?.trim() || undefined, email: rest[0] };
}

/** The account a completed login landed on. Rendered by the caller. */
export interface LoginAccount {
  email?: string;
  /** GitHub login. Absent on the dev shortcut, which has no GitHub identity. */
  login?: string;
  balance: number;
  /** A brand-new account, i.e. the balance is the signup bonus. */
  created: boolean;
  /** The bonus figure, when the gateway reported one separately. */
  signupBonus?: number;
  /**
   * The model this install was just moved to, because the account is new and
   * the gateway named one. Absent whenever nothing moved, which is every
   * returning login and every install where somebody had already chosen.
   */
  model?: string;
}

/**
 * Put a brand-new account on the model the gateway says new accounts start on.
 *
 * Three conditions, and each one is about not moving somebody who did not ask
 * to be moved. The account has to be **new**: the gateway only sends the field
 * then, and it is checked here as well. The gateway has to have **named** one:
 * an older gateway sends nothing and the install stays on `FALLBACK_MODEL`. And
 * nobody on this machine may have **chosen** a model already, which is what
 * `config.model !== FALLBACK_MODEL` means: somebody who picked Sonnet and then
 * created a second account keeps Sonnet.
 *
 * Returns the model when it moved, for the caller to say so.
 */
function adoptNewAccountModel(config: CliConfig, created: boolean, named: unknown): string | undefined {
  if (!created || typeof named !== "string" || !/^[A-Za-z0-9._\/-]{1,64}$/.test(named)) return undefined;
  if (config.model !== FALLBACK_MODEL || named === config.model) return undefined;
  config.model = named;
  return named;
}

/**
 * Why the flow stopped.
 *
 * `closed` is deliberately not folded into `failed`: the gateway authorized the
 * identity and then refused it an account (signups are waitlist-gated), which is
 * not retryable and whose *message* is the actionable part. Flattening it into
 * an error string loses the one thing the user can act on.
 */
export type LoginOutcome =
  | { status: "ok"; account: LoginAccount }
  | { status: "closed"; message: string; hadInvite: boolean }
  | { status: "aborted" }
  | { status: "timeout" }
  | { status: "failed"; error: string };

/** How a surface draws progress. Both hooks are noise, never results. */
export interface LoginReporter {
  /** Device flow only: the verification URL and the code to type into it. */
  verify(start: DeviceStart): void;
  /** One poll interval elapsed — somewhere to draw a progress dot. */
  tick?(): void;
}

/**
 * Run a login to completion, writing the token into `config` on success.
 *
 * `config` is mutated rather than returned because the object is shared by
 * reference with the live `GatewayClient` (`new GatewayClient(config)`), which
 * reads `config.token` on every request. That is what lets the REPL sign in
 * mid-session without rebuilding its client — and it is why the assignments
 * below must stay assignments, not a spread into a fresh object.
 */
export async function performLogin(
  client: GatewayClient,
  config: CliConfig,
  args: LoginArgs,
  report: LoginReporter,
  signal?: AbortSignal,
): Promise<LoginOutcome> {
  // Explicit email → dev shortcut (scriptable, and what the tests use).
  // Otherwise GitHub device flow, falling back to the dev shortcut when the
  // gateway has no GitHub configured (501 → null) — without that fallback,
  // `npm run gateway:memory` would have no way in at all.
  if (!args.email) {
    const start = await client.deviceStart().catch(() => null);
    if (start) return githubLogin(client, config, start, args.invite, report, signal);
  }
  return devLogin(client, config, args.email, args.invite);
}

/** GitHub device flow: show the code, open the browser, poll to completion. */
async function githubLogin(
  client: GatewayClient,
  config: CliConfig,
  start: DeviceStart,
  invite: string | undefined,
  report: LoginReporter,
  signal?: AbortSignal,
): Promise<LoginOutcome> {
  report.verify(start);
  openBrowser(start.verification_uri);

  const deadline = Date.now() + start.expires_in * 1000;
  let interval = Math.max(start.interval, 1);
  // When the gateway stopped answering, if it has. A poll it never saw changes
  // nothing on GitHub, so one bad answer is ridden out; a gateway that stays
  // gone for longer than a cold start takes is reported rather than waited on
  // until the code expires.
  let unavailableSince: number | undefined;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal);
    // Checked here rather than only at the top of the loop: the sleep is where
    // essentially all of the wall-clock time goes, so a cancel felt one interval
    // late is a cancel that looks broken.
    if (signal?.aborted) return { status: "aborted" };
    report.tick?.();
    let poll: DevicePoll;
    try {
      poll = await client.devicePoll(start.session, invite);
    } catch (err) {
      if (!(err instanceof GatewayUnreachableError)) throw err;
      poll = { status: "unavailable", error: err.message };
    }
    if (poll.status === "unavailable") {
      unavailableSince ??= Date.now();
      if (Date.now() - unavailableSince > UNAVAILABLE_GIVE_UP_MS) return { status: "failed", error: poll.error };
      continue;
    }
    unavailableSince = undefined;
    if (poll.status === "pending") {
      if (poll.interval) interval = poll.interval;
      continue;
    }
    if (poll.status === "closed") {
      // Authorized on GitHub but refused an account. Retrying cannot help, so
      // stop rather than spending the rest of the expiry window on it.
      return { status: "closed", message: poll.message, hadInvite: Boolean(invite) };
    }
    if (poll.status === "complete") {
      config.token = poll.token;
      config.userId = poll.userId;
      config.email = poll.email;
      config.login = poll.login;
      // Which gateway this token is worth anything to. Recorded from the URL
      // that just answered rather than from the stored one, because an env
      // redirect means those are different and the one that minted it is the
      // one that answered. `loadConfig` reads it back.
      config.tokenGateway = config.gatewayUrl;
      const model = adoptNewAccountModel(config, poll.created, poll.default_model);
      saveConfig(config);
      return {
        status: "ok",
        account: {
          email: poll.email,
          login: poll.login,
          balance: poll.balance,
          created: poll.created,
          signupBonus: poll.signupBonus,
          ...(model ? { model } : {}),
        },
      };
    }
    return { status: "failed", error: describePollError(poll.error ?? poll.status) };
  }
  return { status: "timeout" };
}

/**
 * How long the gateway may stay unreachable during a login before it is
 * reported. A cold start on Render's free tier takes 60–80 seconds; this is
 * twice that and more, so a restart is waited out and an outage is not.
 */
const UNAVAILABLE_GIVE_UP_MS = 180_000;

/**
 * A poll error as a sentence where the code alone would mean nothing to the
 * person reading it. Both surfaces print it after "login failed:", and neither
 * names a command here, because `clixad login` is a prompt at the REPL.
 */
function describePollError(error: string): string {
  if (error === "unknown_session") {
    return "the server restarted while you were signing in, so this code no longer works. Sign in again.";
  }
  if (error === "login_unavailable") {
    return "GitHub approved the sign-in, but the server could not finish it. Try again in a minute.";
  }
  return error;
}

/** Dev shortcut, for scripting and for a gateway with no GitHub configured. */
async function devLogin(
  client: GatewayClient,
  config: CliConfig,
  email: string | undefined,
  invite: string | undefined,
): Promise<LoginOutcome> {
  let res;
  try {
    res = await client.signupDev(email, invite);
  } catch (err) {
    if (err instanceof SignupClosedError) {
      return { status: "closed", message: err.message, hadInvite: Boolean(invite) };
    }
    throw err;
  }
  config.token = res.token;
  config.userId = res.userId;
  config.email = res.email;
  config.tokenGateway = config.gatewayUrl;
  // A dev account has no GitHub identity, so a `login` left over from a previous
  // GitHub session would outlive the account it named — and the welcome banner
  // greets by it (`app.tsx`), so the REPL would open addressed to somebody who
  // is no longer signed in. Switching accounts from inside the REPL is a normal
  // thing to do now, which is what makes this reachable.
  delete config.login;
  const model = adoptNewAccountModel(config, true, res.default_model);
  saveConfig(config);
  return {
    status: "ok",
    account: { email: res.email, balance: res.balance, created: true, ...(model ? { model } : {}) },
  };
}

/**
 * Sleep that gives up the instant the signal aborts.
 *
 * A plain `setTimeout` between polls swallows the cancel for up to a full
 * interval. Already-aborted resolves immediately, since `addEventListener` never
 * fires on a spent signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
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
