/**
 * `/buy` — the CLI's only purchase surface.
 *
 * It used to be `clixad buy`, a subcommand you had to leave the REPL to reach.
 * That is the wrong shape twice over: the REPL is the default entry point, so
 * almost nobody ever saw the subcommand list, and the moment somebody wants
 * credits is the moment they are sitting at this prompt with an empty wallet —
 * where anything without a leading slash is a prompt, so "run `clixad buy`" was
 * the same dead end "run `clixad login`" was.
 *
 * What these pin is mostly what the dialog *refuses*: this is the one command
 * in the REPL that opens a payment page, and the key that accepts every other
 * dialog here must not be able to reach it.
 */
import React from "react"; // classic JSX transform needs React in scope
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

// A test must not spawn a browser, here or in /earn.
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { matchCommands } from "../src/tui/commands.ts";
import type { CliConfig } from "../src/config.ts";
import type { CreditPackInfo, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};

const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 2,
  earned_usd_today: 0.04,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};

const catalog = [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }];

/**
 * Deliberately not the real pack sizes.
 *
 * The figures on screen have to be the ones the gateway answered — the CLI
 * cannot import the pricing engine, so anything it displays must have travelled
 * over the wire. Packs nobody sells make that checkable: if these appear, they
 * came from the response rather than from a constant somewhere in the CLI.
 */
const PACKS: CreditPackInfo[] = [
  { id: "starter", label: "Starter", credits: 123_000, price_usd: 3 },
  { id: "plus", label: "Plus", credits: 456_000, price_usd: 7.5 },
];

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ARROW_DOWN = "\x1b[B";
const ESC = "\x1b";

function buyClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: { pack: string; consent: Record<string, unknown> }[] = [];
  const client = {
    models: async () => catalog,
    wallet: async () => wallet,
    claimStreak: async () => null,
    creditPacks: async () => ({ enabled: true, packs: PACKS }),
    checkout: async (pack: string, consent: Record<string, unknown>) => {
      calls.push({ pack, consent });
      return {
        url: "https://checkout.stripe.com/c/pay/test_1",
        sessionId: "cs_test_1",
        pack,
        credits: 123_000,
        price_usd: 3,
      };
    },
    ...over,
  } as unknown as GatewayClient;
  return { client, calls };
}

/** Type `/buy`, run it, and wait for the picker. */
async function openPicker(stdin: { write: (s: string) => void }) {
  stdin.write("/buy");
  await tick();
  stdin.write("\r");
  await tick(120);
}

describe("/buy", () => {
  it("is offered by the completion menu, and runs rather than completing", () => {
    const [cmd] = matchCommands("/buy");
    expect(cmd?.name).toBe("buy");
    // No `args` hint, for `/model`'s reason: an arg hint makes enter complete
    // the command instead of running it, and the pack picker is the point.
    expect(cmd?.args).toBeUndefined();
  });

  it("shows the packs the gateway sent, and no figure of its own", async () => {
    const { client } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Buy credits");
    expect(out).toContain("1. Starter");
    expect(out).toContain("123,000 credits");
    expect(out).toContain("$3.00");
    expect(out).toContain("2. Plus");
    expect(out).toContain("456,000 credits");
    expect(out).toContain("$7.50");
    // The offers stay the default, and the picker says so rather than leaving
    // it to the page somewhere else.
    expect(out).toMatch(/credits you earn/i);
  });

  it("says so, and offers the wall, when the gateway has no Stripe key", async () => {
    const { client, calls } = buyClient({ creditPacks: async () => ({ enabled: false, packs: [] }) });
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);

    const out = strip(lastFrame() ?? "");
    expect(out).toMatch(/isn't enabled on this gateway/);
    expect(out).toContain("/earn"); // the path that does work
    expect(out).not.toContain("Buy credits"); // no picker on an empty price list
    expect(calls).toHaveLength(0);
  });

  it("states both withdrawal declarations before anything can be confirmed", async () => {
    const { client } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write("\r");
    await tick(80);

    const out = strip(lastFrame() ?? "");
    // The pack that was actually chosen, with its price.
    expect(out).toContain("Plus");
    expect(out).toContain("456,000 credits");
    expect(out).toContain("$7.50");
    // § 356 (5) BGB: the express request, and the acknowledgment.
    expect(out).toMatch(/request that we deliver the credits immediately/);
    expect(out).toMatch(/14-day withdrawal period/);
    expect(out).toMatch(/right of withdrawal lapses/);
    expect(out).toContain("clixad.io/terms.html");
  });

  it("cannot be accepted by the key that accepts every other dialog", async () => {
    const { client, calls } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write("\r");
    await tick(80);

    // `y` approves an edit at this same spot on the screen several times an
    // hour. Here it is a character in a field, and enter on top of it is a
    // refusal rather than a purchase.
    stdin.write("y");
    await tick();
    stdin.write("\r");
    await tick(80);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("you have not been charged");
    expect(calls).toHaveLength(0);
  });

  it("refuses a bare enter, which is the reflex the dialog above it trains", async () => {
    const { client, calls } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write("\r");
    await tick(80);
    stdin.write("\r");
    await tick(80);

    expect(strip(lastFrame() ?? "")).toContain("you have not been charged");
    expect(calls).toHaveLength(0);
  });

  it("opens Stripe on the typed word, carrying both declarations", async () => {
    const { client, calls } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write("\r");
    await tick(80);
    stdin.write("yes");
    await tick();
    // Echoed, so the answer is visible before it is sent.
    expect(strip(lastFrame() ?? "")).toContain("yes");
    stdin.write("\r");
    await tick(120);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pack).toBe("starter");
    expect(calls[0]!.consent.requestImmediatePerformance).toBe(true);
    expect(calls[0]!.consent.acknowledgeLossOfWithdrawal).toBe(true);
    expect(typeof calls[0]!.consent.at).toBe("string");

    const out = strip(lastFrame() ?? "");
    // Printed as well as opened: `openBrowser` cannot report a desktop with no
    // browser on it, and a checkout nobody can reach is a purchase that
    // silently does not happen.
    expect(out).toContain("checkout.stripe.com");
    expect(out).toContain("waiting for the payment…");
    expect(out).toContain("esc to stop");

    stdin.write(ESC);
    await tick(120);
  });

  it("esc closes the confirmation, and charges nothing", async () => {
    const { client, calls } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write("\r");
    await tick(80);
    stdin.write(ESC);
    await tick(80);

    const out = strip(lastFrame() ?? "");
    expect(out).toContain("you have not been charged");
    expect(out).not.toMatch(/request that we deliver/); // dialog gone
    expect(calls).toHaveLength(0);

    // And the keyboard is back: the next keystroke lands in the editor.
    stdin.write("hi");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("hi");
  });

  it("stops the wait on esc without claiming the payment failed", async () => {
    const { client } = buyClient();
    const { stdin, lastFrame } = render(<App client={client} config={{ ...config }} wallet={wallet} />);
    await openPicker(stdin);
    stdin.write("\r");
    await tick(80);
    stdin.write("yes");
    await tick();
    stdin.write("\r");
    await tick(120);

    stdin.write(ESC);
    await tick(150);

    const out = strip(lastFrame() ?? "");
    // A payment that is still clearing is the ordinary reason to see this, so
    // the wording must not read as a failure — and it must not invite a second
    // attempt at a payment that may already have gone through.
    expect(out).toMatch(/Credits still land when the payment clears/);
    expect(out).toContain("/wallet");
    expect(out).not.toMatch(/error|failed/i);
    expect(out).not.toMatch(/try again|pay again/i);
    expect(out).toContain("ask before edits"); // the box is live again
  });
});
