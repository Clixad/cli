/**
 * A command that does not exit.
 *
 * The reason this is a different shape rather than a longer timeout: a dev
 * server never finishes, so waiting for it is either two minutes of a frozen
 * turn or not doing it at all. What the tests pin down is the contract that
 * makes the other shape usable — an id comes back immediately, the gate is
 * still asked, reading is a cursor rather than a dump, and a command that died
 * on startup is reported as dead rather than as started.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, ToolError, type ToolContext } from "../src/tools.ts";
import { ShellRegistry } from "../src/shells.ts";
import type { PermissionRequest } from "../src/permissions.ts";

const NODE = process.execPath;
let root: string;
let registry: ShellRegistry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-bg-"));
  registry = new ShellRegistry();
});
afterEach(() => {
  registry.killAll();
  rmSync(root, { recursive: true, force: true });
});

function recordingPermit(allowed: boolean) {
  const seen: PermissionRequest[] = [];
  return {
    seen,
    permit: async (req: PermissionRequest) => {
      seen.push(req);
      return allowed
        ? ({ allowed: true } as const)
        : ({ allowed: false, reason: "the user denied it", notice: "denied by you" } as const);
    },
  };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ root, shells: registry, ...over });

/** Read until `check` passes, accumulating — `read_output` advances a cursor. */
async function readUntil(id: string, check: (all: string) => boolean, ms = 5_000): Promise<string> {
  const deadline = Date.now() + ms;
  let all = "";
  while (Date.now() < deadline) {
    all += TOOLS.read_output(ctx(), { shell_id: id });
    if (check(all)) return all;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out; saw: ${all.slice(0, 400)}`);
}

const idOf = (out: string) => /as (bash_\d+)/.exec(out)?.[1] ?? "";

describe("run_command with background", () => {
  it("returns an id before the command has finished", async () => {
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "setInterval(()=>console.log('serving'),30)"`,
      background: true,
    });
    expect(out).toMatch(/Started in the background as bash_\d+/);
    expect(out).toContain("read_output");
    const id = idOf(out);
    expect(id).toBeTruthy();
    await readUntil(id, (all) => all.includes("serving"));
  });

  it("reports a command that died on startup as dead, not as started", async () => {
    // The settle window exists for exactly this: a typo, a missing binary or a
    // port already in use, reported before the model builds on top of it.
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "console.error('EADDRINUSE');process.exit(1)"`,
      background: true,
    });
    expect(out).toContain("exited");
    expect(out).toContain("EADDRINUSE");
  });

  it("goes through the gate, and says it is the background it is asking about", async () => {
    const { seen, permit } = recordingPermit(true);
    await TOOLS.run_command(ctx({ permit }), { command: `"${NODE}" -e "0"`, background: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.summary).toContain("run in the background");
  });

  it("uses the same signature as the foreground, so one 'always' covers both", async () => {
    // `npm run dev` is the same command and the same risk either way; asking
    // again because a flag moved would be a dialog nobody reads.
    const { seen, permit } = recordingPermit(true);
    const command = `"${NODE}" -e "0"`;
    await TOOLS.run_command(ctx({ permit }), { command });
    await TOOLS.run_command(ctx({ permit }), { command, background: true });
    expect(seen[0]!.signature).toBe(seen[1]!.signature);
  });

  it("starts nothing when the user says no", async () => {
    const { permit } = recordingPermit(false);
    await expect(
      TOOLS.run_command(ctx({ permit }), { command: `"${NODE}" -e "0"`, background: true }),
    ).rejects.toThrow(ToolError);
    expect(registry.list()).toEqual([]);
  });
});

describe("read_output", () => {
  it("filters with a regular expression", async () => {
    // The command is a file rather than `node -e`, because read_output echoes
    // the command line in its header — asserting that a filtered read does not
    // contain "info" would otherwise trip over the command that printed it.
    const script = join(root, "noisy.mjs");
    // Printed after the settle window run_command waits out, so the preview it
    // returns has not already consumed these two lines.
    writeFileSync(script, "setTimeout(()=>{console.log('quiet one');console.log('LOUD two')},700);", "utf8");
    const out = await TOOLS.run_command(ctx(), { command: `"${NODE}" "${script}"`, background: true });
    const id = idOf(out);

    const deadline = Date.now() + 8_000;
    let filtered = "";
    while (Date.now() < deadline && !filtered.includes("LOUD two")) {
      filtered += TOOLS.read_output(ctx(), { shell_id: id, filter: "^LOUD" });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(filtered).toContain("LOUD two");
    expect(filtered).not.toContain("quiet one");
    expect(filtered).toContain("filter kept");
  }, 20_000);

  it("names the running ids when given one it does not know", () => {
    expect(() => TOOLS.read_output(ctx(), { shell_id: "bash_404" })).toThrow(ToolError);
    expect(() => TOOLS.read_output(ctx(), { shell_id: "" })).toThrow(/needs a shell_id/);
  });

  it("says nothing is new rather than repeating what was already read", async () => {
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "console.log('once')"`,
      background: true,
    });
    const id = idOf(out);
    await readUntil(id, (all) => all.includes("exited"));
    expect(TOOLS.read_output(ctx(), { shell_id: id })).toContain("nothing new since the last read");
  });
});

describe("kill_shell", () => {
  it("stops a command and reports it stopped", async () => {
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "setInterval(()=>{},1000)"`,
      background: true,
    });
    const id = idOf(out);
    expect(await TOOLS.kill_shell(ctx(), { shell_id: id })).toContain("killed");
  });

  it("is gated: stopping the server somebody is using is a side effect", async () => {
    const { seen, permit } = recordingPermit(true);
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "setInterval(()=>{},1000)"`,
      background: true,
    });
    await TOOLS.kill_shell(ctx({ permit }), { shell_id: idOf(out) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.summary).toContain("stop background command");
  });

  it("leaves it running when the user says no", async () => {
    const { permit } = recordingPermit(false);
    const out = await TOOLS.run_command(ctx(), {
      command: `"${NODE}" -e "setInterval(()=>{},1000)"`,
      background: true,
    });
    const id = idOf(out);
    await expect(TOOLS.kill_shell(ctx({ permit }), { shell_id: id })).rejects.toThrow(ToolError);
    expect(registry.list().find((s) => s.id === id)!.status).toBe("running");
  });
});
