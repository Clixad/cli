/**
 * `/update`: which installs it may update, what it runs, how every failure is
 * worded, and the line at startup that points to it.
 *
 * npm is faked throughout: the real one would replace the CLI the suite runs.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { render } from "ink-testing-library";
vi.mock("../src/browser.ts", () => ({ openBrowser: () => undefined }));
import { App } from "../src/tui/app.tsx";
import { helpText } from "../src/tui/commands.ts";
import type { CliConfig } from "../src/config.ts";
import type { GatewayClient } from "../src/client.ts";
import {
  detectInstall,
  npmErrorCode,
  npmErrorDetail,
  runUpdate,
  updateLines,
  updateNotice,
  UPDATE_COMMAND,
  type RunResult,
  type UpdateDeps,
  type UpdateOutcome,
} from "../src/update.ts";
import { frameWith } from "./helpers/wait.ts";

const ROOT = join("/usr", "local", "lib", "node_modules");
const GLOBAL = join(ROOT, "clixad");

/** npm, answering `root -g` with `root` and `install` with `install`, recording each call. */
function fakeNpm(o: { root?: RunResult; install?: RunResult } = {}) {
  const calls: string[][] = [];
  const npm: UpdateDeps["npm"] = async (args) => {
    calls.push([...args]);
    if (args[0] === "root") return o.root ?? { code: 0, stdout: `${ROOT}\n`, stderr: "" };
    return o.install ?? { code: 0, stdout: "changed 1 package\n", stderr: "" };
  };
  return { npm, calls };
}

function deps(over: Partial<UpdateDeps> = {}, installed = "0.0.1-beta.53"): UpdateDeps {
  return {
    packageDir: GLOBAL,
    // No layout on disk unless a test lays one out: this machine may hold a
    // real global clixad at the same path.
    exists: () => false,
    current: "0.0.1-beta.52",
    npm: fakeNpm().npm,
    latest: async () => "0.0.1-beta.53",
    installedVersion: () => installed,
    ...over,
  };
}
const signal = () => new AbortController().signal;

describe("which install it is", () => {
  const root = async () => ROOT;
  const none = () => false;
  it("updates only an install in npm's global folder, as npm itself reports it", async () => {
    expect(await detectInstall(GLOBAL, root, none, "linux")).toEqual({ kind: "npm", dir: ROOT });
    expect(await detectInstall(join("/home", "me", "project", "node_modules", "clixad"), root, none, "linux")).toMatchObject({ kind: "elsewhere" });
    expect(await detectInstall(GLOBAL, async () => undefined, none, "linux")).toMatchObject({ kind: "elsewhere" });
  });

  it("reads a global install from its layout, and names its prefix, whatever npm prints", async () => {
    // npm masks what looks like a secret in its output, a UUID in a path included.
    const masked = async () => "/home/***/lib/node_modules";
    const dir = join("/home", "me", ".nvm", "versions", "node", "v22.0.0", "lib", "node_modules", "clixad");
    const bin = join("/home", "me", ".nvm", "versions", "node", "v22.0.0", "bin", "clixad");
    expect(await detectInstall(dir, masked, (p) => p === bin, "linux")).toEqual({
      kind: "npm",
      dir: join("/home", "me", ".nvm", "versions", "node", "v22.0.0", "lib", "node_modules"),
      prefix: join("/home", "me", ".nvm", "versions", "node", "v22.0.0"),
    });
    // A project's own node_modules has no bin shim where a global one has it.
    const local = join("/home", "me", "project", "lib", "node_modules", "clixad");
    expect(await detectInstall(local, masked, () => false, "linux")).toMatchObject({ kind: "elsewhere" });
  });

  it("leaves npx, a checkout and other package managers alone", async () => {
    expect(await detectInstall(join("/home", "me", ".npm", "_npx", "abc", "node_modules", "clixad"), root, none)).toEqual({ kind: "npx" });
    expect(await detectInstall(join("/home", "me", "Clixad", "apps", "cli"), root)).toMatchObject({ kind: "source" });
    expect(await detectInstall(join("/home", "me", ".bun", "install", "global", "node_modules", "clixad"), root)).toEqual({
      kind: "manager",
      manager: "bun",
    });
    expect(await detectInstall(join("/home", "me", "Library", "pnpm", "global", "5", "node_modules", "clixad"), root)).toEqual({
      kind: "manager",
      manager: "pnpm",
    });
  });
});

describe("runUpdate", () => {
  it("installs the exact newest version with npm and reports what is installed now", async () => {
    const { npm, calls } = fakeNpm();
    const outcome = await runUpdate(deps({ npm, platform: "linux" }), signal());
    expect(outcome).toEqual({ status: "updated", from: "0.0.1-beta.52", to: "0.0.1-beta.53" });
    expect(calls).toEqual([["root", "-g"], ["install", "-g", "clixad@0.0.1-beta.53", "--no-fund", "--no-audit"]]);
  });

  it("tells npm the prefix the running install lives in, when its layout names one", async () => {
    const { npm, calls } = fakeNpm();
    const bin = join("/usr", "local", "bin", "clixad");
    await runUpdate(deps({ npm, exists: (p) => p === bin, platform: "linux" }), signal());
    expect(calls).toEqual([["install", "-g", "clixad@0.0.1-beta.53", "--no-fund", "--no-audit", "--prefix", join("/usr", "local")]]);
  });

  it("does nothing when it is already the newest, and falls back to the gateway's figure when the registry is silent", async () => {
    const { npm, calls } = fakeNpm();
    expect(await runUpdate(deps({ npm, latest: async () => "0.0.1-beta.52" }), signal())).toEqual({
      status: "current",
      version: "0.0.1-beta.52",
    });
    expect(calls).toEqual([["root", "-g"]]);
    expect(await runUpdate(deps({ latest: async () => undefined, gatewayLatest: "0.0.1-beta.52" }), signal())).toMatchObject({
      status: "current",
    });
  });

  it("turns npm's refusals into reasons, each with the command to run by hand", async () => {
    const failing = (stderr: string) => deps({ npm: fakeNpm({ install: { code: 243, stdout: "", stderr } }).npm });
    const eacces = "npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/local/lib/node_modules/clixad\n";
    expect(await runUpdate(failing(eacces), signal())).toEqual({
      status: "failed",
      reason: "permission",
      command: "npm install -g clixad@0.0.1-beta.53",
      dir: ROOT,
    });
    expect(await runUpdate(failing("npm ERR! code ENOTFOUND\n"), signal())).toMatchObject({ reason: "network" });
    expect(await runUpdate(failing("npm error code ETARGET\n"), signal())).toMatchObject({ reason: "not-published" });
    expect(await runUpdate(failing("npm error code EWEIRD\nnpm error something odd happened\n"), signal())).toMatchObject({
      reason: "other",
      detail: "something odd happened",
    });
    const missing = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    expect(
      await runUpdate(deps({ npm: fakeNpm({ root: { code: null, stdout: "", stderr: "", error: missing } }).npm }), signal()),
    ).toMatchObject({ status: "failed", reason: "no-npm" });
  });

  it("says so when npm finished and the running install did not change", async () => {
    expect(await runUpdate(deps({}, "0.0.1-beta.52"), signal())).toMatchObject({ status: "failed", reason: "other" });
  });

  it("does not run npm install for an install it cannot update", async () => {
    const { npm, calls } = fakeNpm();
    const outcome = await runUpdate(deps({ npm, packageDir: join("/home", "me", "Clixad", "apps", "cli") }), signal());
    expect(outcome).toMatchObject({ status: "unsupported", install: { kind: "source" } });
    expect(calls).toEqual([]);
  });
});

describe("what it says", () => {
  it("names the command on every failure and never prints npm's raw output", () => {
    for (const reason of ["permission", "network", "not-published", "other"] as const) {
      const { tone, lines } = updateLines({ status: "failed", reason, command: "npm install -g clixad@0.0.1-beta.53", dir: ROOT });
      expect(tone).toBe("error");
      expect(lines.at(-1)).toBe("  npm install -g clixad@0.0.1-beta.53");
    }
    expect(updateLines({ status: "failed", reason: "permission", command: UPDATE_COMMAND, dir: ROOT }).lines[0]).toContain(ROOT);
    expect(updateLines({ status: "updated", from: "a", to: "b" }).lines.join(" ")).toContain("clixad --continue");
    expect(npmErrorCode("npm ERR! code EPERM")).toBe("EPERM");
    expect(npmErrorDetail("npm error code E1\nnpm error \x1b[31mbad thing\x1b[39m\nnpm error A complete log of this run")).toBe("bad thing");
  });

  it("says the newer version once a day, and not for the version running", () => {
    expect(updateNotice("0.0.1-beta.53", "0.0.1-beta.52", undefined, "2026-11-16")).toEqual({
      text: "clixad 0.0.1-beta.53 is out (you have 0.0.1-beta.52). /update installs it.",
      mark: "0.0.1-beta.53@2026-11-16",
    });
    expect(updateNotice("0.0.1-beta.53", "0.0.1-beta.52", "0.0.1-beta.53@2026-11-16", "2026-11-16")).toBeUndefined();
    expect(updateNotice("0.0.1-beta.53", "0.0.1-beta.52", "0.0.1-beta.53@2026-11-15", "2026-11-16")).toBeDefined();
    expect(updateNotice("0.0.1-beta.52", "0.0.1-beta.52", undefined, "2026-11-16")).toBeUndefined();
  });

  it("lists /update and /undo in /help", () => {
    const help = helpText();
    expect(help).toContain("/update");
    expect(help).toContain("/undo");
    expect(help).toContain("file changes stay");
  });
});

describe("/update in the REPL", () => {
  const config = (): CliConfig => ({
    gatewayUrl: "http://127.0.0.1:8787",
    dashboardUrl: "http://127.0.0.1:8788",
    token: "adg_test",
    model: "deepseek-v4.1-flash",
  });
  const client = { models: async () => [], wallet: async () => ({ balance: 1, ledger: [] }) } as unknown as GatewayClient;
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  it("runs the update and prints the outcome, with the command when it fails", async () => {
    let outcome: UpdateOutcome = { status: "failed", reason: "permission", command: "npm install -g clixad@9.9.9", dir: ROOT };
    const { stdin, lastFrame, unmount } = render(<App client={client} config={config()} update={async () => outcome} />);
    stdin.write("/update");
    await tick();
    stdin.write("\r");
    const frame = await frameWith(lastFrame, "npm install -g clixad@9.9.9");
    expect(frame).toContain("The update did not go through");
    outcome = { status: "updated", from: "0.0.1-beta.52", to: "9.9.9" };
    stdin.write("/update");
    await tick();
    stdin.write("\r");
    await frameWith(lastFrame, "Updated clixad from 0.0.1-beta.52 to 9.9.9.");
    unmount();
  });
});
