/**
 * What a turn leaves in the scrollback, drawn by ink against a terminal it
 * believes is real (`helpers/terminal.tsx`).
 *
 * The transcript used to be an answer that stayed raw and clipped at the
 * bottom of the screen until the model finished, tool rows that printed the
 * model's own results (the first lines of every file read, `exit 0`), and no
 * trace of what an edit changed. These pin the replacement: the answer reaches
 * the scrollback a line at a time, rendered; a tool row says what was done and
 * how it went; an edit shows its diff; a failed command is marked as one.
 */
import React from "react";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import {
  clearCount,
  fakeStdin,
  fakeTerminal,
  isFrame,
  plain,
  restoreProcessStdout,
  screenOf,
  settle,
  tallestFrameRows,
  type FakeTerminal,
} from "./helpers/terminal.tsx";

vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import type { CliConfig } from "../src/config.ts";
import type { ChatMessage, ChatOptions, ChatTurn, GatewayClient, WalletInfo } from "../src/client.ts";

const config: CliConfig = {
  gatewayUrl: "http://127.0.0.1:8787",
  dashboardUrl: "http://127.0.0.1:8788",
  token: "adg_test",
  login: "FlosGit",
  model: "gemini-2.5-flash-lite",
};
const wallet: WalletInfo = {
  balance: 4988,
  ads_today: 0,
  earned_usd_today: 0,
  max_reward_usd_per_day: 0.8,
  grant_per_ad: 1800,
  ledger: [],
};
const catalog = [{ id: "gemini-2.5-flash-lite", tier: "cheap", est_ads_per_task: 1.2 }];

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const turn = (content: string | null, tool_calls?: unknown[]): ChatTurn =>
  ({
    message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) },
    finishReason: tool_calls ? "tool_calls" : "stop",
    creditsCharged: 7,
    balance: 4981,
  }) as ChatTurn;

async function say(opts: ChatOptions, text: string, size = 5) {
  for (let i = 0; i < text.length; i += size) {
    opts.onDelta?.(text.slice(i, i + size));
    await settle(4);
  }
}

const mounted: Array<{ unmount: () => void }> = [];
function mount(term: FakeTerminal, client: GatewayClient) {
  const stdin = fakeStdin();
  const app = render(<App client={client} config={config} wallet={wallet} />, {
    stdout: term as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  mounted.push(app);
  return stdin;
}
async function type(stdin: ReturnType<typeof fakeStdin>, text: string) {
  stdin.send(text);
  await settle(60);
  stdin.send("\r");
}
/** What ink wrote to the scrollback, as opposed to the frame it repaints. */
const committed = (term: FakeTerminal) => plain(term.writes.filter((w) => !isFrame(w)).join(""));
const everything = (term: FakeTerminal) => {
  const s = screenOf(term);
  return [...s.scrollback, ...s.rows].join("\n");
};

let root: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-transcript-"));
  cwd = process.cwd();
  process.chdir(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/math.ts"),
    Array.from({ length: 30 }, (_, i) => (i === 11 ? "export function add(a, b) { return a - b; }" : `// line ${i + 1}`)).join("\n") + "\n",
  );
});
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount();
  await settle(20);
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
  restoreProcessStdout();
});

describe("a streamed answer", () => {
  it("reaches the scrollback a line at a time, rendered, before the turn ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
        const head = "## The plan\n\nFirst we read **the file**.\n\n";
        await say(opts, head);
        await gate;
        const tail = "Then we fix it.";
        await say(opts, tail);
        return turn(head + tail);
      },
    } as unknown as GatewayClient;
    const term = fakeTerminal(24, 80);
    const stdin = mount(term, client);
    await settle(200);
    await type(stdin, "go");
    await settle(400);

    // Mid-turn, the finished lines are already scrollback, rendered: the
    // heading without its `##`, the bold without its asterisks.
    const during = committed(term);
    expect(during).toContain("⏺ The plan");
    expect(during).toContain("First we read the file.");
    expect(during).not.toContain("**");
    expect(during).not.toContain("##");

    release();
    await settle(400);
    const after = committed(term);
    expect(after).toContain("Then we fix it.");
    // Written once: the committed lines are not repeated when the turn ends.
    expect(after.split("First we read the file.").length - 1).toBe(1);
  });

  for (const [rows, cols] of [
    [20, 80],
    [15, 40],
  ] as const) {
    it(`never overflows ${cols}x${rows} while long markdown streams`, async () => {
      const text = [
        "Here is what I found, in some detail, so that this wraps a few times on a narrow terminal.",
        "",
        "| file | lines | note |",
        "|---|---:|---|",
        "| src/a.ts | 120 | the entry point |",
        "| src/b.ts | 40 | helpers |",
        "",
        "```ts",
        ...Array.from({ length: 30 }, (_, i) => `const value${i} = compute(${i}, "a string that is long enough to wrap");`),
        "```",
        "",
        ...Array.from({ length: 10 }, (_, i) => `- point ${i}: something worth saying about it`),
      ].join("\n");
      const client = {
        models: async () => catalog,
        wallet: async () => wallet,
        async chatStream(_m: ChatMessage[], _model: string, opts: ChatOptions): Promise<ChatTurn> {
          await say(opts, text, 23);
          return turn(text);
        },
      } as unknown as GatewayClient;
      const term = fakeTerminal(rows, cols);
      const stdin = mount(term, client);
      await settle(200);
      await type(stdin, "go");
      await settle(1500);
      expect(clearCount(term)).toBe(0);
      expect(tallestFrameRows(term)).toBeLessThanOrEqual(rows);
      const out = everything(term);
      expect(out).toContain("const value29");
      expect(out).toContain("point 9");
    });
  }
});

describe("tool rows", () => {
  it("say what was done, show an edit's diff, and mark a failed command", async () => {
    const turns = [
      turn(null, [call("1", "read_file", { path: "src/math.ts" })]),
      turn(null, [call("2", "edit_file", { path: "src/math.ts", old_string: "return a - b;", new_string: "return a + b;" })]),
      turn(null, [call("3", "run_command", { command: "echo broken; exit 3" })]),
      turn("Done."),
    ];
    let i = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return turns[i++]!;
      },
    } as unknown as GatewayClient;
    const term = fakeTerminal(40, 90);
    const stdin = mount(term, client);
    await settle(200);
    stdin.send("\x1b[Z"); // accept edits, so the edit lands without a dialog
    await settle(60);
    await type(stdin, "fix it");
    await settle(400);
    // The command still asks.
    expect(plain(term.output())).toContain("Run command");
    stdin.send("y");
    await settle(800);

    const out = everything(term);
    expect(out).toContain("⏺ Read(src/math.ts)");
    expect(out).toContain("⎿  Read 30 lines");
    // Not the file itself.
    expect(out).not.toContain("// line 4");
    expect(out).toContain("⏺ Update(src/math.ts)");
    expect(out).toContain("⎿  Updated src/math.ts with 1 addition and 1 removal");
    expect(out).toMatch(/12 - export function add\(a, b\) \{ return a - b; \}/);
    expect(out).toMatch(/12 \+ export function add\(a, b\) \{ return a \+ b; \}/);
    expect(out).toContain("⏺ Bash(echo broken; exit 3)");
    expect(out).toContain("⎿  Exit code 3");
    expect(out).toContain("broken");
    expect(out).not.toContain("allowed:");
    expect(readFileSync(join(root, "src/math.ts"), "utf8")).toContain("return a + b;");
  });

  it("are answered from the numbered dialog by number and by arrows", async () => {
    const turns = [
      turn(null, [call("1", "write_file", { path: "one.txt", content: "1" })]),
      turn(null, [call("2", "write_file", { path: "two.txt", content: "2" })]),
      turn("Done."),
    ];
    let i = 0;
    const client = {
      models: async () => catalog,
      wallet: async () => wallet,
      async chatStream(): Promise<ChatTurn> {
        return turns[i++]!;
      },
    } as unknown as GatewayClient;
    const term = fakeTerminal(30, 80);
    const stdin = mount(term, client);
    await settle(200);
    await type(stdin, "write two files");
    await settle(400);
    expect(plain(term.output())).toContain("Do you want to create one.txt?");
    stdin.send("3"); // No
    await settle(400);
    expect(plain(term.output())).toContain("Do you want to create two.txt?");
    stdin.send("\x1b[B"); // down: "Yes, and don't ask again"
    await settle(60);
    stdin.send("\x1b[A"); // up: back to "Yes"
    await settle(60);
    stdin.send("\r");
    await settle(500);

    const out = everything(term);
    expect(out).toContain("⏺ Write(one.txt)");
    expect(out).toContain("⎿  Denied by you");
    expect(out).toContain("⎿  Wrote 1 line to two.txt");
    expect(() => readFileSync(join(root, "one.txt"), "utf8")).toThrow();
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("2");
  });
});
