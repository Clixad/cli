/**
 * The shared login flow (`src/login.ts`).
 *
 * It exists because the REPL had no way to sign in: a 401 there printed "Run
 * `clixad login` first", and typing that at the prompt is not a command — it is
 * a prompt, so it went to the model, hit the same 401 and printed the same line
 * again. Fixing that meant the flow had to be runnable from two surfaces, so it
 * moved out of `main.ts` and the outcome became a value instead of console
 * output.
 *
 * What these tests hold onto: the dev-shortcut/device-flow choice, the
 * non-retryable `closed` case surviving as itself, cancellation, and the fact
 * that a completed login mutates the *same* config object the GatewayClient
 * holds — which is what lets the REPL sign in without rebuilding its client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `saveConfig` is spied rather than allowed to write: config.ts resolves
// CONFIG_PATH at module load, so a temp HOME set in beforeEach would arrive too
// late and the real ~/.clixad would be overwritten instead. What matters here is
// that the flow persists the account it just mutated; that the file lands 0600
// at the right path is config.test.ts's job.
const saved: CliConfig[] = [];
vi.mock("../src/config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.ts")>()),
  saveConfig: (c: CliConfig) => void saved.push({ ...c }),
}));
// A test must not spawn a browser.
const opened: string[] = [];
vi.mock("../src/browser.ts", () => ({ openBrowser: (url: string) => opened.push(url) }));

import { parseLoginArgs, performLogin, type LoginReporter } from "../src/login.ts";
import {
  GatewayUnreachableError,
  SignupClosedError,
  type DevicePoll,
  type DeviceStart,
  type GatewayClient,
} from "../src/client.ts";
import { FALLBACK_MODEL, type CliConfig } from "../src/config.ts";

beforeEach(() => {
  opened.length = 0;
  saved.length = 0;
});

const config = (over: Partial<CliConfig> = {}): CliConfig => ({
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8787",
  model: "gemini-2.5-flash-lite",
  ...over,
});

const START: DeviceStart = {
  session: "sess_1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 1,
  expires_in: 900,
};

/** Collects what a surface would have drawn, without drawing it. */
function reporter(): LoginReporter & { starts: DeviceStart[]; ticks: number } {
  const r = {
    starts: [] as DeviceStart[],
    ticks: 0,
    verify(s: DeviceStart) {
      r.starts.push(s);
    },
    tick() {
      r.ticks++;
    },
  };
  return r;
}

/** The config as `saveConfig` was handed it. */
const persisted = () => saved.at(-1)!;

describe("parseLoginArgs", () => {
  it("takes both invite spellings out of the positional list", () => {
    expect(parseLoginArgs(["--invite", "SECRET"])).toEqual({ invite: "SECRET", email: undefined });
    expect(parseLoginArgs(["--invite=SECRET"])).toEqual({ invite: "SECRET", email: undefined });
    expect(parseLoginArgs(["you@dev", "--invite=S"])).toEqual({ invite: "S", email: "you@dev" });
  });

  it("treats an empty or whitespace invite as absent", () => {
    expect(parseLoginArgs(["--invite="]).invite).toBeUndefined();
    expect(parseLoginArgs(["--invite", "  "]).invite).toBeUndefined();
  });

  it("is empty for no arguments — the device-flow case", () => {
    expect(parseLoginArgs([])).toEqual({ invite: undefined, email: undefined });
  });
});

describe("performLogin — device flow", () => {
  it("stores the account and reports it back", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => ({
        status: "complete" as const,
        token: "adg_real",
        userId: "u_1",
        email: "flo@example.com",
        login: "FlosGit",
        balance: 5000,
        created: true,
        signupBonus: 5000,
      }),
    } as unknown as GatewayClient;

    const cfg = config();
    const r = reporter();
    const outcome = await performLogin(client, cfg, {}, r);

    expect(outcome).toEqual({
      status: "ok",
      account: {
        email: "flo@example.com",
        login: "FlosGit",
        balance: 5000,
        created: true,
        signupBonus: 5000,
      },
    });
    // The same object the GatewayClient was constructed with — mutated, not
    // replaced, or the live client would keep sending the old token.
    expect(cfg.token).toBe("adg_real");
    expect(cfg.login).toBe("FlosGit");
    expect(persisted().token).toBe("adg_real");
    // The code is shown before the browser opens, and the browser does open.
    expect(r.starts).toEqual([START]);
    expect(opened).toEqual(["https://github.com/login/device"]);
  });

  // Not folded into `failed`: the gateway authorized the identity and refused it
  // an account. Retrying cannot help and the message is the only actionable part.
  it("surfaces a waitlist refusal as `closed`, with the message intact", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => ({
        status: "closed" as const,
        message: "Clixad is invite-only right now. Join the waitlist at clixad.dev.",
        waitlistUrl: "https://clixad.dev",
      }),
    } as unknown as GatewayClient;

    const cfg = config();
    const outcome = await performLogin(client, cfg, { invite: "NOPE" }, reporter());

    expect(outcome).toEqual({
      status: "closed",
      message: "Clixad is invite-only right now. Join the waitlist at clixad.dev.",
      hadInvite: true,
    });
    expect(cfg.token).toBeUndefined();
    expect(saved).toEqual([]); // nothing was written
  });

  it("reports a refusal on GitHub as failed", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => ({ status: "denied" as const, error: "access_denied" }),
    } as unknown as GatewayClient;
    expect(await performLogin(client, config(), {}, reporter())).toEqual({
      status: "failed",
      error: "access_denied",
    });
  });

  it("gives up when the device code expires", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => {
        throw new Error("must not be polled past the deadline");
      },
    } as unknown as GatewayClient;
    // expires_in 0 → the deadline is already behind us, so the loop never runs
    // and the device code is never polled.
    const expired = { ...START, expires_in: 0 };
    const outcome = await performLogin(
      { ...client, deviceStart: async () => expired } as unknown as GatewayClient,
      config(),
      {},
      reporter(),
    );
    expect(outcome).toEqual({ status: "timeout" });
  }, 1000);

  // The REPL runs this under `runBusy`, whose box says "esc to stop". The poll
  // sleep is where all the wall-clock time goes, so it has to take the signal —
  // otherwise the cancel is felt a full interval late and reads as broken.
  it("stops on an aborted signal without polling", async () => {
    let polls = 0;
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => {
        polls++;
        return { status: "pending" as const };
      },
    } as unknown as GatewayClient;

    const ac = new AbortController();
    const p = performLogin(client, config(), {}, reporter(), ac.signal);
    ac.abort();
    expect(await p).toEqual({ status: "aborted" });
    expect(polls).toBe(0);
  }, 1000);

  // A poll the gateway never answered changes nothing on GitHub. Ending the
  // login on one sent people back to approve a code they had already approved;
  // on 2026-10-01 two of them reported authorizing "multiple times".
  it("polls through a gateway that is briefly unavailable or unreachable", async () => {
    const answers: Array<() => DevicePoll> = [
      () => ({ status: "unavailable", error: "http 503" }),
      () => {
        throw new GatewayUnreachableError("clixad.onrender.com", "ECONNRESET");
      },
      () => ({
        status: "complete",
        token: "adg_real",
        userId: "u_1",
        email: "flo@example.com",
        login: "FlosGit",
        balance: 25000,
        created: false,
        signupBonus: 0,
      }),
    ];
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => answers.shift()!(),
    } as unknown as GatewayClient;

    const cfg = config();
    const outcome = await performLogin(client, cfg, {}, reporter());
    expect(outcome.status).toBe("ok");
    expect(cfg.token).toBe("adg_real");
    expect(answers).toEqual([]);
  }, 5000);

  it("reports a gateway that stays unavailable instead of waiting out the code", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const client = {
        deviceStart: async () => START,
        devicePoll: async () => {
          polls++;
          return { status: "unavailable" as const, error: "http 503" };
        },
      } as unknown as GatewayClient;
      const p = performLogin(client, config(), {}, reporter());
      await vi.advanceTimersByTimeAsync(200_000);
      expect(await p).toEqual({ status: "failed", error: "http 503" });
      // Well short of the 900-second code: three minutes of a gateway that is
      // gone is an outage, not a cold start.
      expect(polls).toBeLessThan(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not swallow an error that is not about reaching the gateway", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => {
        throw new Error("bug");
      },
    } as unknown as GatewayClient;
    await expect(performLogin(client, config(), {}, reporter())).rejects.toThrow("bug");
  }, 5000);

  it("says in words that a restart lost the session, without naming a command", async () => {
    const client = {
      deviceStart: async () => START,
      devicePoll: async () => ({ status: "error" as const, error: "unknown_session" }),
    } as unknown as GatewayClient;
    const outcome = await performLogin(client, config(), {}, reporter());
    expect(outcome.status).toBe("failed");
    const error = (outcome as { error: string }).error;
    expect(error).toMatch(/restarted/);
    // `clixad login` typed at the REPL is a prompt, and `/login` in a shell is
    // nothing: both surfaces print this, so it names neither.
    expect(error).not.toMatch(/clixad login|\/login/);
  }, 5000);

  it("carries the invite code into every poll", async () => {
    const seen: Array<string | undefined> = [];
    const client = {
      deviceStart: async () => START,
      devicePoll: async (_s: string, invite?: string) => {
        seen.push(invite);
        return { status: "denied" as const };
      },
    } as unknown as GatewayClient;
    await performLogin(client, config(), { invite: "SECRET" }, reporter());
    expect(seen).toEqual(["SECRET"]);
  });
});

describe("performLogin — dev shortcut", () => {
  const devClient = () =>
    ({
      deviceStart: async () => {
        throw new Error("device flow must not be started when an email was given");
      },
      signupDev: async (email?: string) => ({
        token: "adg_dev",
        userId: "u_dev",
        email: email ?? "dev@local",
        balance: 5000,
      }),
    }) as unknown as GatewayClient;

  it("takes an explicit email straight to the dev shortcut", async () => {
    const cfg = config();
    const outcome = await performLogin(devClient(), cfg, { email: "you@dev" }, reporter());
    expect(outcome).toEqual({
      status: "ok",
      account: { email: "you@dev", balance: 5000, created: true },
    });
    expect(cfg.token).toBe("adg_dev");
    expect(opened).toEqual([]); // no browser: there is nothing to authorize
  });

  // Without this fallback a gateway with no GITHUB_CLIENT_ID — which is every
  // `npm run gateway:memory` — would have no way in at all.
  it("falls back to it when the gateway has no GitHub configured", async () => {
    const client = {
      deviceStart: async () => null, // the 501 case
      signupDev: async () => ({ token: "adg_dev", userId: "u_dev", email: "dev@local", balance: 42 }),
    } as unknown as GatewayClient;
    expect(await performLogin(client, config(), {}, reporter())).toMatchObject({ status: "ok" });
  });

  // A dev account has no GitHub identity, and the welcome banner greets by
  // `login` — so a leftover one would open the REPL addressed to an account the
  // user just signed out of.
  it("clears a GitHub login left over from a previous account", async () => {
    const cfg = config({ token: "adg_old", login: "FlosGit", email: "flo@example.com" });
    await performLogin(devClient(), cfg, { email: "you@dev" }, reporter());
    expect(cfg.login).toBeUndefined();
    expect(cfg.email).toBe("you@dev");
    expect(persisted().login).toBeUndefined();
  });

  it("surfaces a gated signup as `closed` here too", async () => {
    const client = {
      deviceStart: async () => null,
      signupDev: async () => {
        throw new SignupClosedError("Signups are closed.", "https://clixad.dev");
      },
    } as unknown as GatewayClient;
    expect(await performLogin(client, config(), {}, reporter())).toEqual({
      status: "closed",
      message: "Signups are closed.",
      hadInvite: false,
    });
  });

  // Only SignupClosedError is a result; anything else is a bug or an outage and
  // must not be flattened into a tidy "login failed".
  it("lets an unexpected error out", async () => {
    const client = {
      deviceStart: async () => null,
      signupDev: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as GatewayClient;
    await expect(performLogin(client, config(), {}, reporter())).rejects.toThrow("ECONNREFUSED");
  });
});

describe("performLogin — the model a new account starts on", () => {
  const device = (over: Record<string, unknown>) =>
    ({
      deviceStart: async () => START,
      devicePoll: async () => ({
        status: "complete" as const,
        token: "adg_new",
        userId: "u_9",
        email: "new@example.com",
        login: "newcomer",
        balance: 25_000,
        created: true,
        signupBonus: 25_000,
        ...over,
      }),
    }) as unknown as GatewayClient;

  it("moves a brand-new account onto the model the gateway names, and saves it", async () => {
    const cfg = config({ model: FALLBACK_MODEL });
    const outcome = await performLogin(client(device({ default_model: "deepseek-v4-flash" })), cfg, {}, reporter());
    expect(cfg.model).toBe("deepseek-v4-flash");
    expect(persisted().model).toBe("deepseek-v4-flash");
    expect(outcome).toMatchObject({ status: "ok", account: { model: "deepseek-v4-flash" } });
  });

  it("never moves a returning account, whatever the gateway sends", async () => {
    // The gateway sends no model for a returning login; this holds even if one did.
    const cfg = config({ model: FALLBACK_MODEL });
    const outcome = await performLogin(
      client(device({ created: false, default_model: "deepseek-v4-flash" })),
      cfg,
      {},
      reporter(),
    );
    expect(cfg.model).toBe(FALLBACK_MODEL);
    expect(outcome.status === "ok" && outcome.account.model).toBeFalsy();
  });

  it("keeps a model somebody on this machine already chose", async () => {
    const cfg = config({ model: "claude-sonnet-5.5" });
    await performLogin(client(device({ default_model: "deepseek-v4-flash" })), cfg, {}, reporter());
    expect(cfg.model).toBe("claude-sonnet-5.5");
  });

  it("stays on the fallback against a gateway that names nothing", async () => {
    const cfg = config({ model: FALLBACK_MODEL });
    const outcome = await performLogin(client(device({})), cfg, {}, reporter());
    expect(cfg.model).toBe(FALLBACK_MODEL);
    expect(outcome.status === "ok" && outcome.account.model).toBeFalsy();
  });

  it("refuses a model id that could not be one", async () => {
    const cfg = config({ model: FALLBACK_MODEL });
    await performLogin(client(device({ default_model: "x\u001b[2Jy" })), cfg, {}, reporter());
    expect(cfg.model).toBe(FALLBACK_MODEL);
  });

  it("does the same on the dev shortcut, which only ever creates", async () => {
    const cfg = config({ model: FALLBACK_MODEL });
    const dev = {
      deviceStart: async () => null,
      signupDev: async () => ({
        token: "adg_dev",
        userId: "u_d",
        email: "dev@x",
        balance: 25_000,
        default_model: "deepseek-v4-flash",
      }),
    } as unknown as GatewayClient;
    await performLogin(dev, cfg, {}, reporter());
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  /** Identity, so the call sites read as what they are. */
  function client(c: GatewayClient): GatewayClient {
    return c;
  }
});
