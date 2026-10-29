/**
 * Clixad CLI entry point.
 *
 * Commands:
 *   clixad login [email] [--invite <code>]
 *                            create/attach an account (dev shortcut for now)
 *   clixad logout            forget the stored token
 *   clixad whoami            show current account + balance
 *   clixad models            list models with credit prices and ads/task
 *   clixad model <id>        set the default model
 *   clixad wallet            show balance, ads today, recent ledger
 *   clixad earn              open the ad wall, wait for the reward to land
 *   clixad refer             print the account's invite code and its standing
 *   clixad redeem <code>     spend a code we handed out
 *   clixad ask "<prompt>"    one-shot completion (scriptable)
 *   clixad agent "<task>"    open the REPL with a task already running
 *   clixad -p "<task>"       headless agent run (read-only tools, no TTY needed)
 *   clixad code ["<task>"]   launch the full Kimi CLI coding agent on the cwd
 *   clixad [--continue|--resume [id]]   interactive coding REPL (default; signs
 *                            you in first if there is no account yet)
 */
import {
  AuthError,
  GatewayClient,
  MaintenanceError,
  PaywallError,
  PremiumLockedError,
  accessColumn,
  adsPerTaskLabel,
  grantLabel,
  NO_PREMIUM_CREDITS,
  premiumHeadline,
  premiumLocked,
  packsFromClause,
  usd,
  ledgerReasonLabel,
  redeemMessage,
  referLines,
  shortfallHeadline,
  streakLabel,
  type ChatMessage,
  type StreakInfo,
  type WalletInfo,
} from "./client.ts";
import {
  IDENTITY_KEYS,
  configPath,
  loadConfig,
  saveConfig,
  takeConfigNotices,
  type CliConfig,
} from "./config.ts";
import { syncPreferences } from "./preferences.ts";
import { TERMS_NOTICE, parseLoginArgs, performLogin } from "./login.ts";
import { freeAlternativeLine, freeModelToName } from "./free-tier.ts";
import { NO_SEARCH_INSTRUCTION, runAgent, type AgentEvent } from "./agent.ts";
import { toolSchemaFor } from "./tools.ts";
import { collectContext, shouldSuggestInit } from "./context.ts";
import { denyAll } from "./permissions.ts";
import { TodoList } from "./todos.ts";
import { shells } from "./shells.ts";
import { hasSessionIn, latestSession, listSessions, loadSession, type StoredSession } from "./session.ts";
import { runKimiCode } from "./kimi.ts";
import { clearScreen } from "./banner.ts";
import { loadTui } from "./tui/load.ts";
import { openBrowser } from "./browser.ts";
import { palette } from "./color.ts";
import { clearTerminalTitle, setTerminalTitle } from "./title.ts";
import { VERSION } from "./version.ts";
import { savedEffort } from "./effort.ts";

/**
 * The one-shot commands' palette, gated on the stream they are writing to.
 *
 * It used to be six unconditional template literals, so `clixad models > list`
 * and `clixad -p "…" | tee` wrote escape codes into a file. `colorEnabled`
 * applies the same rule `title.ts` and the sponsored line already apply — see
 * `color.ts` for why `FORCE_COLOR` wins and `CI` is not consulted.
 *
 * Read once, at module load: `process.stdout` is not going to stop being a pipe
 * halfway through a command, and a gate re-read per call is a gate that reads
 * differently in the middle of a sentence.
 */
const c = palette({ isTTY: process.stdout.isTTY, env: process.env });

async function main() {
  // Before anything prints: the tab says "node" until we say otherwise. The
  // 'exit' hook hands the name back on every ordinary ending, including a thrown
  // error and the REPL's own ctrl+c (Ink reads that as a keystroke in raw mode,
  // not as a signal). A bare SIGINT to a one-shot command kills the process
  // without running exit handlers — no listener is added for it, because taking
  // SIGINT over means owning termination for every command, and the shell's own
  // prompt rewrites the title a moment later anyway.
  // `process.stdout.write` on a TTY is synchronous, which is what makes this
  // usable from an exit handler at all.
  setTerminalTitle();
  process.on("exit", () => clearTerminalTitle());

  const [cmd, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const client = new GatewayClient(config);
  // Whatever reading the config had to say. On **stderr** for every command,
  // because `-p` and the one-shot commands exist to be piped and a warning about
  // config.json is not part of their output. The REPL is handed the same lines
  // again as entries, since it clears the screen on the way in and would
  // otherwise scroll the one explanation of why it opened signed out away.
  const configNotices = takeConfigNotices();
  for (const text of configNotices) console.error(c.yellow(text));

  switch (cmd) {
    case "login":
      return void (await login(client, config, rest, { nextStep: true }));
    case "logout":
      return logout(config);
    case "whoami":
      return whoami(client, config);
    case "models":
      return listModels(client);
    case "model":
      return setModel(client, config, rest[0]);
    case "wallet":
      return showWallet(client);
    case "earn":
      return earn(client, config);
    case "refer":
      return refer(client, config);
    case "redeem":
      return redeem(client, config, rest[0]);
    // `clixad buy` is gone, and it is the one removed subcommand that gets a
    // signpost rather than the ordinary "anything that is not a command is a
    // task" fallback. A typo reaching the model is the better failure; this is
    // not a typo — it is what the help output, the terms and every older CLI
    // have been telling people to run — so left alone it would send "buy
    // starter" to a model, spend credits and do nothing.
    case "buy":
      console.log(c.yellow("Buying credits moved into the REPL."));
      console.log(c.dim("  Run `clixad` and type /buy — it shows the packs and asks you to confirm."));
      return;
    case "ask":
      return ask(client, config, rest.join(" "));
    case "agent":
      return repl(client, config, { task: rest.join(" ").trim() || undefined, notices: configNotices });
    case "-p":
    case "--print":
      return printCmd(client, config, rest.join(" ").trim());
    case "-c":
    case "--continue":
      return repl(client, config, { resume: "latest", notices: configNotices });
    case "--resume":
      return repl(client, config, { resume: rest[0] ?? "pick", notices: configNotices });
    case "code":
      return codeCmd(client, config, rest);
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    // The first thing anyone types after an install, and it used to land in
    // `unknown command` and print the help with exit code 1. Bare, no "clixad"
    // prefix and no colour: it gets piped into scripts and issue reports.
    case "version":
    case "--version":
    case "-v":
      return void console.log(VERSION);
    case undefined:
      return repl(client, config, { notices: configNotices });
    default:
      // `clixad fix the failing test` — one of the first things anyone types,
      // and it used to answer `unknown command: fix` and exit 1. A word that is
      // not a subcommand is a task: the REPL opens with it already running,
      // which is what `claude "…"` does. A typo'd subcommand therefore reaches
      // the model instead of an error, and that is the better failure — the
      // model says it cannot find `wallett`, rather than the CLI refusing to
      // start. An unknown *option* is still an error: a stray flag is a mistake
      // in a script, never a prompt.
      if (cmd.startsWith("-")) {
        console.error(c.red(`unknown option: ${cmd}`));
        printHelp();
        process.exitCode = 1;
        return;
      }
      return repl(client, config, { task: [cmd, ...rest].join(" ").trim(), notices: configNotices });
  }
}

/**
 * `clixad login` — the console rendering of the shared flow in `login.ts`.
 *
 * The flow itself (dev shortcut vs device flow, the poll loop, signup-closed)
 * lives there so the REPL's `/login` runs the same one. What is left here is
 * output: ANSI colour, a progress dot per poll, and the exit code.
 */
/**
 * Sign in, and say so.
 *
 * Returns whether the account was created by this call, which the REPL uses to
 * greet a brand-new account as new rather than as "back". `nextStep` is for the
 * explicit `clixad login` command, which ends at a shell prompt: plenty of
 * accounts never ran a single model call, and the old output stopped at
 * "token stored in …" without saying what to type next. Bare `clixad` signs in
 * and carries on into the REPL, so it has no next step to name.
 */
async function login(
  client: GatewayClient,
  config: CliConfig,
  args: string[],
  opts: { nextStep?: boolean } = {},
): Promise<{ created: boolean } | undefined> {
  const parsed = parseLoginArgs(args);
  // Before the flow, never inside `verify`: the dev shortcut creates an account
  // without ever showing a device code, and this is the moment the contract is
  // concluded on both paths.
  for (const line of TERMS_NOTICE.split("\n")) console.log(c.dim(`  ${line}`));
  const outcome = await performLogin(client, config, parsed, {
    verify(start) {
      console.log(`\n  Open ${c.cyan(start.verification_uri)} and enter code: ${c.bold(start.user_code)}\n`);
      if (c.enabled) process.stdout.write(c.dim("  waiting for GitHub authorization… (Ctrl+C to cancel)"));
    },
    tick() {
      if (c.enabled) process.stdout.write(c.dim("."));
    },
  });

  switch (outcome.status) {
    case "ok": {
      const { account } = outcome;
      const who = account.login ?? account.email ?? "you";
      const suffix = account.login && account.email ? c.dim(` (${account.email})`) : "";
      console.log(c.green(`\n✓ logged in as ${who}`) + suffix);
      // Grouped, like `clixad wallet` and the TUI. Five figures is where a bare
      // integer starts being read as the wrong number, and this is the first
      // balance anyone sees.
      const bonus = account.created
        ? c.dim(account.signupBonus === undefined ? " (signup bonus)" : ` (signup bonus ${credits(account.signupBonus)})`)
        : "";
      console.log(`  balance: ${c.bold(credits(account.balance))} credits${bonus}`);
      // Only a brand-new account is moved, and only then is there anything to
      // say. Whether it is free today is the wallet's to say, not this line's:
      // the tier can be paused.
      if (account.model) console.log(`  model: ${c.bold(account.model)} ${c.dim("(the default for new accounts)")}`);
      // Claimed here because signing in is one of the three moments somebody is
      // provably at the machine today. It is idempotent per UTC day, so the REPL
      // and `wallet` claiming too costs nothing and means a person who never
      // types `login` again still gets their streak.
      await showStreak(client);
      console.log(c.dim(`  token stored in ${configPath()}`));
      if (opts.nextStep) {
        console.log(`\n  Next: open a project folder and run ${c.cyan("clixad")} to start coding.`);
      }
      return { created: account.created };
    }
    case "closed":
      reportSignupClosed(outcome.message, outcome.hadInvite);
      process.exitCode = 1;
      return undefined;
    case "timeout":
      console.log(c.red("\n  login timed out — run `clixad login` again."));
      return undefined;
    case "aborted":
      return undefined;
    default:
      console.log(c.red(`\n  login failed: ${outcome.error}`));
      return undefined;
  }
}

/** The gateway refused to create an account. Shown identically on both paths. */
function reportSignupClosed(message: string, hadInvite: boolean) {
  console.log(c.yellow("\n  Clixad isn't open yet.\n"));
  for (const line of wrapPlain(message, 68)) console.log(`  ${line}`);
  if (hadInvite) {
    console.log(
      c.dim("\n  The invite code you passed wasn't accepted — check it for typos, or ask for a new one."),
    );
  }
  console.log("");
}

/** Wrap on spaces without measuring escape codes — the text is plain. */
function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A credit figure as every other surface prints it: grouped, en-US. */
const credits = (n: number) => n.toLocaleString("en-US");

function logout(config: CliConfig) {
  // Every identity field, from the one list `loadConfig` also clears. Spelled
  // out here once, `login` was left behind — the welcome banner greets by it, so
  // a stale one is somebody else's name on the screen and their GitHub handle
  // sitting in config.json after they signed out. A second copy of the list is
  // how that happens again the next time a field is added.
  for (const key of IDENTITY_KEYS) delete config[key];
  saveConfig(config);
  console.log(c.green("✓ logged out"));
}

async function whoami(client: GatewayClient, config: CliConfig) {
  if (!config.token) return console.log(c.yellow("not logged in — run `clixad login`"));
  const w = await client.wallet();
  console.log(`${c.bold(config.email ?? "unknown")}  ·  model ${c.cyan(config.model)}`);
  console.log(`balance: ${c.bold(credits(w.balance))} credits  ·  ${earnedToday(w)}`);
}

/** "earned today: 3 offers · $0.42/$0.80" — the cap is on payout, not on count. */
function earnedToday(w: WalletInfo): string {
  const offers = `${w.ads_today} offer${w.ads_today === 1 ? "" : "s"}`;
  return `earned today: ${offers} · $${w.earned_usd_today.toFixed(2)}/$${w.max_reward_usd_per_day.toFixed(2)}`;
}

async function listModels(client: GatewayClient) {
  const models = await client.models();
  // The allowance, so the free rows can say what is actually left rather than
  // only that they are free, and whether premium models are open to this
  // account, so a locked one says so. Best-effort: a wallet read that fails
  // must not stop somebody listing the catalog, and without it the rows simply
  // say "free" and mark nothing locked.
  const wallet = await client.wallet(undefined, { premium: true }).catch(() => undefined);
  const free = wallet?.free_tier;
  const premium = wallet?.premium;
  console.log(c.bold("Models  (credit prices per 1M tokens)"));
  for (const m of models) {
    const tag = m.ad_fundable ? "" : c.dim(" [paid/BYOK]");
    // `free` is a fact about the deployment and `turns_left` is a fact about
    // this account, so the label degrades in one step rather than disappearing:
    // a catalog that says free with no wallet behind it still says free.
    const turns = free?.models.includes(m.id) ? free.turns_left[m.id] ?? 0 : undefined;
    const freeTag = !m.free
      ? ""
      : turns === undefined
        ? c.green(" [free]")
        : turns > 0
          ? c.green(` [free: ~${turns} turn${turns === 1 ? "" : "s"} left today]`)
          : c.dim(" [free: none left today]");
    const lockTag =
      m.access === "premium" && premiumLocked(premium)
        ? c.yellow(` [${premiumHeadline(client.premiumUnlockUsd).replace(/\.$/, "")}]`)
        : "";
    console.log(
      `  ${c.cyan(m.id.padEnd(22))} ${accessColumn(m, premium)} ` +
        `in ${String(m.credits_per_mtoken_input).padStart(9)}  out ${String(m.credits_per_mtoken_output).padStart(9)}  ` +
        `${adsPerTaskLabel(m.est_ads_per_task)}${tag}${freeTag}${lockTag}`,
    );
  }
}

/**
 * A premium refusal, said where a shell reads it (2026-10-04): every way on is
 * a command runnable from here, `PaywallError`'s rule for the one-shot
 * commands, and every figure is the gateway's.
 */
function printPremiumRefusal(err: PremiumLockedError) {
  console.log(c.yellow(premiumHeadline(err.unlockUsd)));
  console.log(
    c.yellow(`${err.model} is a premium model. It runs on credits from offer-wall surveys or purchases.`),
  );
  console.log(
    c.yellow(
      err.premiumCredits > 0
        ? `This turn needs about ${err.neededCredits.toLocaleString("en-US")} of those credits, ` +
            `and you have ${err.premiumCredits.toLocaleString("en-US")}.`
        : NO_PREMIUM_CREDITS,
    ),
  );
  console.log(c.yellow(`Run \`clixad earn\` for a survey on the offer walls. Offers pay ${grantLabel(err.grantPerAd)}.`));
  if (err.unlockUsd) {
    console.log(
      c.yellow(`Or buy credits from ${usd(err.unlockUsd)}, which work on every model: start \`clixad\` and type /buy.`),
    );
  }
  // The budget way on: the bonus credits still work there.
  const freeLine = freeAlternativeLine(err.freeModels);
  console.log(c.green(freeLine ?? "Your bonus credits still work on budget models: `clixad models` lists them."));
  console.log(c.dim("  Nothing was charged for this request."));
}

/**
 * Set the default model, rejecting ids the gateway doesn't serve. Saving an
 * unchecked string meant every later request failed with "unknown model" — the
 * error surfaced far from the typo that caused it. The REPL's `/model` picker
 * already validated; this is the same courtesy for the subcommand.
 */
async function setModel(client: GatewayClient, config: CliConfig, model?: string) {
  if (!model) return console.log(`current model: ${c.cyan(config.model)}`);

  const known = await client.models().catch(() => undefined);
  if (known && !known.some((m) => m.id === model)) {
    console.error(c.red(`unknown model: ${model}`));
    console.error(c.dim(`  available: ${known.map((m) => m.id).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  if (!known) console.log(c.yellow("  (couldn't reach the gateway to verify the id)"));

  config.model = model;
  saveConfig(config);
  console.log(c.green(`✓ model set to ${model}`));
  // Set although it is locked: said now, rather than after a task has been
  // typed and refused. One wallet read, only for a premium model.
  const picked = known?.find((m) => m.id === model);
  if (picked?.access === "premium") {
    const w = await client.wallet(undefined, { premium: true }).catch(() => undefined);
    if (premiumLocked(w?.premium)) {
      console.log(c.yellow(premiumHeadline(client.premiumUnlockUsd)));
      console.log(
        c.yellow(
          `${model} runs on credits from offer-wall surveys or purchases. ` +
            "Run `clixad earn` for a survey on the offer walls" +
            (client.premiumUnlockUsd ? `, or start \`clixad\` and type /buy.` : "."),
        ),
      );
    }
  }
}

async function showWallet(client: GatewayClient) {
  // Claimed before the balance is read, so the figure printed below already
  // includes today's grant rather than being one command behind it.
  const streak = await client.claimStreak();
  const w = await client.wallet();
  console.log(`balance: ${c.bold(w.balance.toLocaleString("en-US"))} credits`);
  // One figure, and it says it is the median. Unlabelled, a number next to the
  // balance reads as what the next offer will pay, and offers on the wall pay
  // well below and well above it. This line used to print the advertised range,
  // which carried no wall, count or date, and before that `typical grant: 40000`.
  console.log(`${earnedToday(w)}  ·  offers pay ${grantLabel(w.grant_per_ad)}`);
  // The free allowance, on the one command whose whole job is "what have I got".
  // Absent on a gateway with no free tier and on a paused one, which is the same
  // silence — there is nothing free to report either way, and a line saying "0
  // free credits" on a deployment that has never had a free tier would be
  // describing a feature the reader cannot get to.
  const free = w.free_tier;
  if (free && free.daily_credits > 0) {
    const best = free.models
      .map((id) => ({ id, turns: free.turns_left[id] ?? 0 }))
      .filter((m) => m.turns > 0)
      .sort((a, b) => b.turns - a.turns)[0];
    console.log(
      free.credits_left > 0
        ? c.green(
            `free today: ${credits(free.credits_left)} of ${credits(free.daily_credits)} credits left` +
              (best ? `  ·  ~${best.turns} turn${best.turns === 1 ? "" : "s"} on ${best.id}` : ""),
          )
        : c.dim(`free today: none left of ${credits(free.daily_credits)} credits — resets at midnight UTC`),
    );
  }
  const line = streak && streakLabel(streak);
  if (line) console.log(streak!.claimed ? c.green(line) : c.dim(line));
  if (w.ledger.length) {
    console.log(c.dim("recent:"));
    // Labelled, and the reason column is wide enough for the longest of them.
    // A reversal lands here as `-40,000  offer reward reversed by the provider`
    // rather than `-40000  ad_reversal`, which is the only place a user can
    // find out why credits they had already earned went away.
    const label = (e: { reason: string }) => ledgerReasonLabel(e.reason);
    const width = Math.max(...w.ledger.slice(0, 8).map((e) => label(e).length));
    for (const e of w.ledger.slice(0, 8)) {
      const amount = `${e.delta >= 0 ? "+" : "-"}${Math.abs(e.delta).toLocaleString("en-US")}`;
      const sign = e.delta >= 0 ? c.green(amount) : c.yellow(amount);
      // padEnd on the *uncoloured* text: ANSI escapes count toward .length and
      // silently eat the padding, which is what made this column ragged.
      const pad = " ".repeat(Math.max(0, 10 - amount.length));
      console.log(
        c.dim(`  ${sign}${pad}  ${label(e).padEnd(width)}  -> ${e.balanceAfter.toLocaleString("en-US")}`),
      );
    }
  }
}

/**
 * `clixad earn` — open the ad wall and wait for the reward to land.
 *
 * A terminal cannot show an offerwall, so this is a browser handoff, the same
 * one the REPL's paywall uses: mint a single-use code, open the dashboard
 * already signed in, then poll.
 *
 * Nothing is returned by the wall: the reward arrives as a signed postback from
 * the network to the gateway, so a rising balance is the only signal there is.
 */
async function earn(client: GatewayClient, config: CliConfig) {
  if (!config.token) return console.log(c.yellow("Not logged in. Run `clixad login` first."));
  const before = (await safeWallet(client))?.balance ?? 0;

  // The page otherwise asks for an account token the CLI never prints. Falls back
  // to the bare URL (manual paste) if the gateway cannot issue a code.
  const code = await client.handoffCode();
  const base = config.dashboardUrl.replace(/\/+$/, "");
  const url = code ? `${base}/?c=${encodeURIComponent(code)}` : base;
  openBrowser(url);
  console.log(`\n  Ad wall: ${c.dim(base)}`);
  if (!code) console.log(c.yellow("  (couldn't sign you in automatically — paste your token there)"));
  console.log(
    c.dim("  Credits are granted on completion. Surveys screen people out part way through —\n") +
      c.dim("  that pays nothing and is the normal case, so just start another one."),
  );
  if (c.enabled) process.stdout.write(c.dim("  waiting for an offer to clear"));

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (c.enabled) process.stdout.write(c.dim("."));
    const balance = (await safeWallet(client))?.balance ?? before;
    if (balance > before) {
      console.log(
        c.green(`\n✓ +${(balance - before).toLocaleString("en-US")} credits`) +
          `  ·  balance ${c.bold(balance.toLocaleString("en-US"))}`,
      );
      return;
    }
  }
  // Not a failure: surveys and sign-up offers can take longer than this to be
  // confirmed by the network, and the credits land whenever they land. It is also
  // what a screenout looks like from here, which is the common case rather than
  // the exception — so this must not read as an error.
  console.log(
    c.yellow("\n  Nothing yet — offers can take a while to confirm, and being screened out of one"),
  );
  console.log(c.yellow("  pays nothing and is normal. Start another, or check `clixad wallet` later."));
}

/**
 * `clixad refer` — print this account's referral code and where it stands.
 *
 * The code is minted by the gateway on the first read, so this is the command
 * that brings one into existence; there is nothing to set up first. All the
 * wording and every figure come from `referLines`, shared with the REPL's
 * `/refer` — what crosses that boundary is text, never a string one surface has
 * already coloured.
 */
async function refer(client: GatewayClient, config: CliConfig) {
  if (!config.token) return console.log(c.yellow("Not logged in. Run `clixad login` first."));
  let info;
  try {
    info = await client.referral();
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exitCode = 1;
    return;
  }
  const [code, share, deal, ...rest] = referLines(info);
  // The code and the command are what somebody came for, so they are the only
  // two lines that are not dim.
  console.log(`\n  ${c.bold(code!)}`);
  console.log(`  ${c.cyan(share!)}`);
  console.log(c.dim(`  ${deal!}`));
  for (const line of rest) console.log(c.dim(`  ${line}`));
  console.log("");
}

/**
 * `clixad redeem <code>` — spend a code we handed out.
 *
 * A refusal is not an error here: an expired or already-spent code is an answer,
 * and the exit code stays 0 for it. What does set a non-zero code is a request
 * that never got an answer at all — a gateway that is down, or a token that is
 * not valid for it — because that is the case a script needs to be able to see.
 */
async function redeem(client: GatewayClient, config: CliConfig, code?: string) {
  if (!config.token) return console.log(c.yellow("Not logged in. Run `clixad login` first."));
  if (!code) return console.error(c.red("usage: clixad redeem <code>"));

  let result;
  try {
    result = await client.redeem(code);
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exitCode = 1;
    return;
  }
  const { ok, text } = redeemMessage(result);
  if (!ok) return console.log(c.yellow(`  ${text}`));
  console.log(c.green(`\n✓ ${text}`) + `  ·  balance ${c.bold(credits(result.balance))}`);
}

async function ask(client: GatewayClient, config: CliConfig, prompt: string) {
  if (!prompt) return console.error(c.red('usage: clixad ask "your prompt"'));
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  await runTurn(client, config, messages);
}

/**
 * `clixad -p "<task>"` — headless agent run for scripts and CI. Tools that
 * change anything are refused (`denyAll`): approving them needs the REPL, and a
 * pipe has nobody to ask.
 */
async function printCmd(client: GatewayClient, config: CliConfig, task: string) {
  if (!config.token) return console.log(c.yellow("Not logged in. Run `clixad login` first."));
  if (!task) return console.error(c.red('usage: clixad -p "describe a task"'));
  // Ask what this gateway can do before assembling the tools: with no search
  // key, advertising `web_search` costs input tokens on every call and buys a
  // round-trip's worth of error.
  const capabilities = await client
    .models()
    .then(() => client.capabilities)
    .catch(() => undefined);

  try {
    const res = await runAgent(client, task, {
      model: config.model,
      effort: savedEffort(config, config.model),
      root: process.cwd(),
      systemPrompt:
        collectContext(process.cwd()).systemPrompt +
        (capabilities?.web_search ? "" : `\n\n${NO_SEARCH_INSTRUCTION}`),
      tools: () => toolSchemaFor("normal", [], { webSearch: capabilities?.web_search === true }),
      permit: denyAll,
      // Research works headlessly and is worth having here: the tools that need
      // a person — `ask_user`, and the permission dialog every write goes
      // through — are the ones a pipe cannot answer, and those already say so
      // themselves rather than guessing. MCP is deliberately absent: its tools
      // are gated, so `denyAll` would refuse every one of them after paying to
      // advertise it.
      webSearch: (query, opts) => client.webSearch(query, opts),
      webSearchAvailable: capabilities?.web_search === true,
      todos: new TodoList(),
      onEvent: printAgentEvent,
    });
    // The free tier gets said out loud here for the reason it does in the REPL:
    // `0 credits` on its own is a number somebody will read as a bug, and this
    // is the surface most likely to be piped into a log somebody reads later.
    const cost =
      res.creditsWaived > 0
        ? res.creditsCharged > 0
          ? `free: ${res.creditsWaived} credits · then ${res.creditsCharged} charged`
          : `free · ${res.creditsWaived} credits waived`
        : `${res.creditsCharged} credits`;
    console.log(
      c.dim(`\n  [${cost} · balance ${res.balance} · ${res.steps} step(s)]`),
    );
  } catch (err) {
    if (err instanceof PremiumLockedError) {
      console.log("");
      printPremiumRefusal(err);
    } else if (err instanceof PaywallError) {
      console.log(c.yellow(`\n${shortfallHeadline(err, config.model)}`));
      // The exit that costs nothing comes first when there is one, runnable
      // from here like every other line of this message.
      const freeLine = freeAlternativeLine(err.freeModels);
      if (freeLine) console.log(c.green(freeLine));
      // Both instructions have to be runnable *from a shell*, which is where
      // this one prints: `-p` is the headless run, there is no prompt here and
      // no slash commands. "or buy credits" named no way of doing it at all,
      // and the way is now inside the REPL, so it says which REPL.
      console.log(
        c.yellow(
          `Run \`clixad earn\` to open the offerwall — offers pay ${grantLabel(err.grantPerAd)}.`,
        ),
      );
      console.log(
        c.yellow(`Credits can also be bought${packsFromClause(err.cheapestPackUsd)}: start \`clixad\` and type /buy.`),
      );
      console.log(c.dim("  Offers you are screened out of pay nothing — that is normal, just start another."));
    } else if (err instanceof AuthError) {
      console.log(c.red(err.message));
    } else if (err instanceof MaintenanceError) {
      console.log(c.yellow(`\n${err.message}`));
    } else {
      console.log(c.red(`\nagent error: ${(err as Error).message}`));
    }
    process.exitCode = 1;
  } finally {
    // A background command holds the event loop open through its pipes, so a
    // scripted run that started a dev server would print its answer and then
    // never return the shell prompt. The `process.on("exit")` hook cannot help:
    // it fires once Node has already decided to go.
    shells.killAll();
  }
}

function printAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case "delta":
      process.stdout.write(event.text);
      break;
    case "tool_call":
      console.log(c.cyan(`\n  → ${event.name}`) + c.dim(` ${JSON.stringify(event.args).slice(0, 200)}`));
      break;
    case "tool_result": {
      const preview = event.result.split("\n").slice(0, 4).join("\n    ");
      console.log(c.dim(`    ${preview.slice(0, 400)}`));
      break;
    }
    case "attachment":
      console.log(c.dim(`    (showing the model: ${event.labels.join(", ")})`));
      break;
    case "final":
      process.stdout.write("\n");
      break;
    case "max_steps":
      console.log(c.yellow("  (stopped: reached max steps)"));
      break;
  }
}

/** `clixad code ["<task>"]` — launch the full Kimi CLI agent on the gateway. */
async function codeCmd(client: GatewayClient, config: CliConfig, rest: string[]) {
  if (!config.token) return console.log(c.yellow("Not logged in. Run `clixad login` first."));

  // Friendly pre-flight: surface the balance so an out-of-credits run is obvious.
  const w = await safeWallet(client);
  if (w) {
    console.log(
      c.dim(`  wallet: ${credits(w.balance)} credits · model ${config.model} · gateway ${config.gatewayUrl}`),
    );
    if (w.balance <= 0) {
      console.log(c.yellow("  You're out of credits — run `clixad earn` first, or the agent will hit a paywall."));
      // Kimi CLI runs whatever `config.model` says, so a free model is a way on
      // that needs no offer at all. Named with the shell command, since this is
      // printed before Kimi's own prompt takes over the terminal.
      const pick = w.free_tier && w.free_tier.credits_left > 0 ? freeModelToName(w.free_tier, config.model) : undefined;
      if (pick && pick.id !== config.model) {
        console.log(c.green(`  ${freeAlternativeLine([{ id: pick.id, turnsLeft: pick.turns }], { rerun: false })!}`));
      }
    }
  }
  console.log(c.dim("  launching Kimi CLI (Clixad-configured)…\n"));

  const task = rest.join(" ").trim();
  const code = await runKimiCode(config, task || undefined);
  if (code !== 0) process.exitCode = code;
}

async function repl(
  client: GatewayClient,
  config: CliConfig,
  opts: { task?: string; resume?: string; notices?: string[] } = {},
) {
  // Listing sessions is just output — no terminal required, and no account
  // either: the files are on this machine. Checked before the sign-in below so
  // `clixad --resume` never asks for a login it does not need.
  if (opts.resume === "pick") {
    const sessions = listSessions(undefined, 10);
    if (!sessions.length) return console.log(c.yellow("no saved sessions yet"));
    console.log(c.bold("Sessions:"));
    for (const s of sessions) {
      console.log(`  ${c.cyan(s.id)}  ${s.updated.slice(0, 16).replace("T", " ")}  ${s.title}`);
    }
    console.log(c.dim("\n  resume one with: clixad --resume <id>"));
    return;
  }

  if (!process.stdin.isTTY) {
    // No terminal: neither the REPL nor a device-flow login has anywhere to run,
    // so say both things at once rather than sending a script off to `login` to
    // fail the same way.
    if (!config.token) {
      console.log(c.yellow("Not logged in, and interactive mode needs a terminal."));
      console.log(c.dim('  Run `clixad login` in a terminal, then `clixad -p "..."` for scripted runs.'));
      return;
    }
    console.log(c.yellow('Interactive mode needs a terminal. Use `clixad -p "..."` for scripted runs.'));
    return;
  }

  // `clixad` is the first thing anyone types after installing, and it used to
  // answer with a single line telling them to type something else. Run that
  // something else instead: on success the REPL opens on the same run, so an
  // install is one command and a browser tab rather than three. On every
  // failure path — refused, denied, timed out, ctrl+c — `login` has already
  // explained itself, and an absent token is how we know not to continue.
  let newAccount = false;
  if (!config.token) {
    newAccount = Boolean((await login(client, config, []))?.created);
    if (!config.token) return;
  }

  let session: StoredSession | undefined;
  if (opts.resume === "latest") {
    session = latestSession(process.cwd());
    if (!session) console.log(c.dim("  no previous session here — starting a new one"));
  } else if (opts.resume) {
    session = loadSession(opts.resume);
    if (!session) return console.log(c.red(`no such session: ${opts.resume}`));
  }

  // Claimed before the wallet is read, so the balance the banner shows already
  // includes today's grant. The third of the three surfaces that claim, and the
  // one that matters most: a token persists, so most people never run `login`
  // again after the first time, and opening the REPL is what "coming back"
  // actually looks like.
  const { streak, wallet, settings } = await startupReads(client, config.gatewayUrl);
  // Before the TUI, which reads `config.model` on its first frame.
  const preferences = await syncPreferences(client, config, settings);
  // Decided here rather than in the TUI because it is a question about this
  // directory and this machine's saved sessions, which a render should not
  // depend on. `hasSessionIn` is asked only when the directory qualifies, so a
  // project that already has a CLIXAD.md costs nothing at startup.
  const cwd = process.cwd();
  const initHint = shouldSuggestInit(cwd) ? { returning: hasSessionIn(cwd) } : undefined;
  clearScreen();
  // Loaded lazily so ink/react never slow down the one-shot commands, and
  // through `loadTui` so a session of any length does not run out of heap.
  const { startTui } = await loadTui();
  await startTui({
    client,
    config,
    wallet,
    streak,
    session,
    newAccount,
    preferences,
    initialTask: opts.task,
    ...(opts.notices?.length ? { notices: opts.notices } : {}),
    ...(initHint ? { initHint } : {}),
  });
}

/** One assistant turn: stream the reply and print credit accounting. */
async function runTurn(client: GatewayClient, config: CliConfig, messages: ChatMessage[]) {
  // The label goes out with the first token rather than before the request, so
  // a request that fails prints its error on a line of its own instead of
  // after a dangling "assistant".
  let started = false;
  try {
    const result = await client.chatStream(messages, config.model, {
      effort: savedEffort(config, config.model),
      onDelta: (chunk) => {
        if (!started) process.stdout.write(c.green("assistant "));
        started = true;
        process.stdout.write(chunk);
      },
    });
    if (!started) process.stdout.write(c.green("assistant "));
    process.stdout.write("\n");
    console.log(c.dim(`  [${credits(result.creditsCharged)} credits · balance ${credits(result.balance)}]`));
    return result;
  } catch (err) {
    if (started) process.stdout.write("\n");
    if (err instanceof PremiumLockedError) {
      printPremiumRefusal(err);
    } else if (err instanceof PaywallError) {
      console.log(c.yellow(shortfallHeadline(err, config.model)));
      const freeLine = freeAlternativeLine(err.freeModels);
      if (freeLine) console.log(c.green(freeLine));
      // `clixad earn`, not `/earn`: the only caller is `clixad ask`, a one-shot
      // command with no prompt behind it, so a slash command here is the same
      // dead end "run `clixad login`" was at the REPL — an instruction that
      // cannot be carried out where it is read.
      console.log(
        c.yellow(`Run \`clixad earn\` to open the offerwall — offers pay ${grantLabel(err.grantPerAd)}.`),
      );
      console.log(
        c.yellow(`Credits can also be bought${packsFromClause(err.cheapestPackUsd)}: start \`clixad\` and type /buy.`),
      );
      console.log(c.dim("  Offers you are screened out of pay nothing — that is normal, just start another."));
    } else if (err instanceof AuthError) {
      console.log(c.red(err.message));
    } else if (err instanceof MaintenanceError) {
      console.log(c.yellow(err.message));
    } else {
      console.log(c.red(`error: ${(err as Error).message}`));
    }
    return undefined;
  }
}

/**
 * Claim today's streak and print it, if there is anything to say.
 *
 * Returns what the gateway answered so a caller that wants the fresher balance
 * can use it; `null` means an older gateway, a cold one, or an unreachable one,
 * and in all three cases the right amount of output is none. `claimStreak` never
 * throws for that reason.
 */
async function showStreak(client: GatewayClient): Promise<StreakInfo | null> {
  const streak = await client.claimStreak();
  const line = streak && streakLabel(streak);
  if (!line) return streak;
  // Green only when it actually granted something — the "already counted"
  // phrasing is context, not an event, and colouring it would make every
  // command of the day look like a win.
  console.log(streak!.claimed ? c.green(`  ${line}`) : c.dim(`  ${line}`));
  return streak;
}

async function safeWallet(client: GatewayClient, opts: { premium?: boolean } = {}) {
  try {
    return await client.wallet(undefined, opts);
  } catch {
    return undefined;
  }
}

/**
 * The two reads the REPL opens with, together, and said out loud while they take.
 *
 * They used to run one after the other, in front of a blank terminal: the
 * streak claim, then the wallet. On a warm gateway that was a second of nothing
 * after pressing enter; on one that Render had spun down it was up to a minute
 * of nothing, which reads as a hung program. Now both go out at once, and if
 * they have not answered by `CONNECTING_AFTER_MS` a line says what is
 * happening, and a second one after `WAKING_AFTER_MS` says why it can take a
 * while. The screen is cleared when the REPL opens, so neither line outlives
 * the wait.
 *
 * The claim used to go first so the banner's balance would include today's
 * grant. Run together, the wallet may be read either side of the claim, so the
 * claim's own balance wins whenever it granted something: it is the balance
 * after the grant, whichever order the two reads happened in.
 */
const CONNECTING_AFTER_MS = 700;
const WAKING_AFTER_MS = 6_000;

async function startupReads(client: GatewayClient, gatewayUrl: string) {
  const host = (() => {
    try {
      return new URL(gatewayUrl).host;
    } catch {
      return gatewayUrl;
    }
  })();
  // Only on a terminal: a status line in a redirected stream is noise.
  const say = (text: string) => {
    if (process.stdout.isTTY) console.log(c.dim(text));
  };
  const timers = [
    setTimeout(() => say(`  connecting to ${host}…`), CONNECTING_AFTER_MS),
    setTimeout(
      () => say("  still waiting: the server sleeps after a quiet spell and takes up to a minute to wake. ctrl+c cancels."),
      WAKING_AFTER_MS,
    ),
  ];
  try {
    // The wallet with premium access (2026-10-04), so `/model` and the cost
    // preview know from the first frame whether premium models are open. One
    // read of the account's ledger per REPL start, never on a poll.
    // The account's preferences ride along, so a model or an
    // effort chosen in the browser is the one this REPL opens on.
    const [streak, wallet, settings] = await Promise.all([
      client.claimStreak(),
      safeWallet(client, { premium: true }),
      client.getSettings(),
    ]);
    const balance = streak?.claimed ? streak.balance : wallet?.balance;
    return {
      streak,
      settings,
      wallet: wallet && balance !== undefined ? { ...wallet, balance } : wallet,
    };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

/**
 * The command list, laid out by measuring rather than by hand-counted spaces.
 *
 * It was one template literal with the padding typed in, and three rows had
 * drifted a column or two out of line. It also led with `login` and `logout`
 * and put the thing almost everybody runs, bare `clixad`, in the last two rows,
 * and it never mentioned `/buy` at all.
 */
function printHelp() {
  const rows: [string, string, string][] = [
    ["", "", "start the interactive coding agent here (signs you in if needed)"],
    ['"<task>"', "", "the same, with a task already running"],
    ["--continue", "", "resume the last session in this directory"],
    ["--resume", "[id]", "list saved sessions, or resume one"],
    ["-p", '"<task>"', "headless agent run (read-only tools)"],
    ["ask", '"<prompt>"', "one-shot answer, no tools"],
    ["models", "", "models with credit prices, and which are free today"],
    ["model", "<id>", "set the default model"],
    ["wallet", "", "balance, offers today, recent activity"],
    ["earn", "", "open the offer wall to earn credits"],
    ["refer", "", "your invite code, and what it has earned"],
    ["redeem", "<code>", "spend a code you were given"],
    ["login", "[email]", "sign in or create an account (--invite <code> if you have one)"],
    ["logout", "", "forget the stored token"],
    ["whoami", "", "account and balance"],
    ["code", '["<task>"]', "launch the Kimi CLI coding agent on this directory"],
    ["--version", "", "print the version and exit"],
  ];
  const plain = (name: string, arg: string) => `clixad${name ? ` ${name}` : ""}${arg ? ` ${arg}` : ""}`;
  const width = Math.max(...rows.map(([name, arg]) => plain(name, arg).length)) + 2;
  const lines = rows.map(([name, arg, desc]) => {
    const shown = `${c.cyan("clixad")}${name ? ` ${c.cyan(name)}` : ""}${arg ? ` ${arg}` : ""}`;
    return `  ${shown}${" ".repeat(width - plain(name, arg).length)}${desc}`;
  });
  console.log(`${c.bold("clixad")}: free AI coding in your terminal, funded by ads

${lines.join("\n")}

  Inside the agent, ${c.cyan("/help")} lists everything else, including ${c.cyan("/buy")} for credit packs.
  ${c.dim("Discord: https://discord.gg/bD6FYdJfcy (bugs and feature requests are read there)")}`);
}

main().catch((err) => {
  console.error(c.red((err as Error).message));
  process.exitCode = 1;
});
