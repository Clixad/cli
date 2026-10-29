/**
 * Background commands.
 *
 * Real child processes, because every property worth testing here is about a
 * real one: that a command which does not exit still hands back an id, that
 * reading twice does not re-read, that killing it actually stops it, and that
 * nothing survives the registry.
 *
 * `node -e` is the command throughout — it is the one interpreter this repo can
 * assume on every platform it runs on, and it makes the fixtures readable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FINISHED_SHELLS, MAX_SHELLS, ShellError, ShellRegistry } from "../src/shells.ts";

const NODE = process.execPath;
const registries: ShellRegistry[] = [];

function registry(): ShellRegistry {
  const r = new ShellRegistry();
  registries.push(r);
  return r;
}

afterEach(() => {
  for (const r of registries.splice(0)) r.killAll();
});

/** Wait until `check` is true, or give up. Beats a fixed sleep on a slow CI box. */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for the condition");
}

describe("ShellRegistry", () => {
  it("returns before the command has finished", async () => {
    const r = registry();
    const started = r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>console.log('tick'),20)"`);
    expect(started.status).toBe("running");
    expect(started.id).toMatch(/^bash_\d+$/);
    await until(() => r.read(started.id).output.includes("tick"));
  });

  it("reads only what is new, so polling a log costs the new lines", async () => {
    const r = registry();
    const { id } = r.start(
      process.cwd(),
      `"${NODE}" -e "console.log('first');setTimeout(()=>console.log('second'),300)"`,
    );

    // Read is a cursor, not a dump: the first read takes "first" and leaves the
    // cursor after it, which is the whole reason watching a server is cheap.
    let seen = "";
    await until(() => {
      seen += r.read(id).output;
      return seen.includes("first");
    });
    expect(seen).not.toContain("second");

    await until(() => r.list().some((s) => s.id === id && s.status === "exited"));
    const after = r.read(id).output;
    expect(after).toContain("second");
    expect(after).not.toContain("first");

    // And nothing is left to re-read.
    expect(r.read(id).output).toBe("");
  });

  it("reports the exit code once it is over", async () => {
    const r = registry();
    const { id } = r.start(process.cwd(), `"${NODE}" -e "process.exit(3)"`);
    await until(() => exited(r, id));
    expect(r.read(id).snapshot.exitCode).toBe(3);
  });

  it("filters lines with a regular expression, and says how many it dropped", async () => {
    const r = registry();
    const { id } = r.start(
      process.cwd(),
      `"${NODE}" -e "console.log('info a');console.log('ERROR b');console.log('info c')"`,
    );
    await until(() => exited(r, id));
    const read = r.read(id, { filter: "ERROR" });
    expect(read.output).toContain("ERROR b");
    expect(read.output).not.toContain("info a");
    expect(read.filtered?.kept).toBe(1);
  });

  it("rejects a filter that is not a regular expression", async () => {
    const r = registry();
    const { id } = r.start(process.cwd(), `"${NODE}" -e "console.log('x')"`);
    await until(() => exited(r, id));
    expect(() => r.read(id, { filter: "([" })).toThrow(ShellError);
  });

  it("says when output scrolled out of the buffer instead of losing it silently", async () => {
    // A watcher printing a line a second for an hour is normal, so the buffer
    // is a window over the tail — and the model has to be told it is one.
    const r = registry();
    const { id } = r.start(
      process.cwd(),
      `"${NODE}" -e "for(let i=0;i<20000;i++)console.log('line '+i+' '.repeat(20))"`,
    );
    await until(() => exited(r, id), 20_000);
    const read = r.read(id);
    expect(read.missed).toBeGreaterThan(0);
    expect(read.output).toContain("line 19999");
    expect(read.output).not.toContain("line 0 ");
  }, 25_000);

  it("kills a command that would otherwise run forever", async () => {
    const r = registry();
    const { id } = r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>{},1000)"`);
    expect(r.kill(id).status).toBe("killed");
    // Killing a dead one is not an error: the model may have raced its exit.
    expect(() => r.kill(id)).not.toThrow();
  });

  it("names the ids it knows when asked for one it does not", () => {
    const r = registry();
    expect(() => r.read("bash_99")).toThrow(/none have been started/);
    r.start(process.cwd(), `"${NODE}" -e "0"`);
    expect(() => r.read("bash_99")).toThrow(/bash_1/);
  });

  it("refuses to start more than the cap, naming what is already running", () => {
    const r = registry();
    for (let i = 0; i < MAX_SHELLS; i++) r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>{},1000)"`);
    expect(() => r.start(process.cwd(), `"${NODE}" -e "0"`)).toThrow(/already running/);
  });

  it("reports a command that could not start rather than pretending it runs", async () => {
    const r = registry();
    const { id } = r.start(process.cwd(), "definitely-not-a-real-binary-xyz");
    await until(() => r.list().some((s) => s.id === id && s.status !== "running"));
    // A shell reports a missing binary on stderr and exits non-zero; either
    // route is fine, so long as it does not sit there claiming to be running.
    expect(["exited", "failed"]).toContain(r.read(id).snapshot.status);
  });

  it("killAll stops everything and is safe to call twice", () => {
    const r = registry();
    r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>{},1000)"`);
    r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>{},1000)"`);
    r.killAll();
    r.killAll();
    expect(r.list().every((s) => s.status !== "running")).toBe(true);
  });
});

describe("the registry does not grow without bound", () => {
  /**
   * `MAX_SHELLS` bounds only what is *running*, so nothing bounded finished
   * commands at all: a session that ran one after another kept every one of
   * them, each holding up to `MAX_SHELL_BUFFER` characters, for as long as the
   * REPL was open.
   */
  it("keeps the most recent finished commands and forgets the older ones", async () => {
    const r = registry();
    const ids: string[] = [];
    for (let i = 0; i < MAX_FINISHED_SHELLS + 4; i++) {
      ids.push(r.start(process.cwd(), `"${NODE}" -e "0"`).id);
      await until(() => exited(r, ids[ids.length - 1]!));
    }
    // Starting one more is the moment the registry grows, so it is the moment
    // it prunes.
    const last = r.start(process.cwd(), `"${NODE}" -e "0"`).id;

    const kept = r.list().map((s) => s.id);
    expect(kept.length).toBeLessThanOrEqual(MAX_FINISHED_SHELLS + 1);
    expect(kept).toContain(last);
    expect(kept).not.toContain(ids[0]);
  });

  it("never forgets a running command, however many have finished", async () => {
    const r = registry();
    const live = r.start(process.cwd(), `"${NODE}" -e "setInterval(()=>{},1000)"`).id;
    for (let i = 0; i < MAX_FINISHED_SHELLS + 4; i++) {
      const id = r.start(process.cwd(), `"${NODE}" -e "0"`).id;
      await until(() => exited(r, id));
    }
    r.start(process.cwd(), `"${NODE}" -e "0"`);
    // Still listed, and still readable — which is the whole point of keeping it.
    expect(r.list().map((s) => s.id)).toContain(live);
    expect(r.read(live).snapshot.status).toBe("running");
  });
});

/**
 * Whether a shell has finished, without consuming its output.
 *
 * `read` advances the cursor, so polling with it eats exactly the output the
 * test is about to assert on. `list` is the non-destructive view.
 */
function exited(r: ShellRegistry, id: string): boolean {
  return r.list().some((s) => s.id === id && s.status === "exited");
}
