/** The permission matrix: modes × allowlist × what the user answers. */
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_BLOCKS_IN_A_ROW,
  createPermit,
  createState,
  decide,
  denyAll,
  modeInstruction,
  nextMode,
  switchMode,
  type PermissionRequest,
  type Reviewer,
} from "../src/permissions.ts";

const write: PermissionRequest = { tool: "write_file", signature: "write:a.ts", summary: "edit a.ts" };
const run: PermissionRequest = { tool: "run_command", signature: "run:npm", summary: "run npm test" };

describe("permission modes", () => {
  it("asks for everything in normal mode", () => {
    const state = createState("normal");
    expect(decide(state, write).kind).toBe("ask");
    expect(decide(state, run).kind).toBe("ask");
  });

  it("waves edits through in acceptEdits, but still asks for shell commands", () => {
    const state = createState("acceptEdits");
    expect(decide(state, write).kind).toBe("allow");
    expect(decide(state, run).kind).toBe("ask");
  });

  it("refuses everything in plan mode and tells the model why", () => {
    const state = createState("plan");
    const verdict = decide(state, write);
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") expect(verdict.reason).toContain("plan mode");
  });

  it("remembers an 'always' answer for the rest of the session", async () => {
    const state = createState("normal");
    const ask = vi.fn(async () => "always" as const);
    const permit = createPermit(() => state, ask);

    expect(await permit(run)).toEqual({ allowed: true });
    expect(await permit(run)).toEqual({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(1); // the second call never reached the user
    expect(state.allowed.has("run:npm")).toBe(true);
  });

  it("does not remember a plain 'once'", async () => {
    const state = createState("normal");
    const ask = vi.fn(async () => "once" as const);
    const permit = createPermit(() => state, ask);
    await permit(write);
    await permit(write);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("reports a denial with a reason the model can act on", async () => {
    const permit = createPermit(() => createState("normal"), async () => "deny");
    const res = await permit(write);
    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.notice).toBe("denied by you");
    expect(res.reason).toContain("the user denied edit a.ts");
    // Stated as a fact about the world, not just a verdict: a refused call that
    // reads like a pending one is how a model ends up carrying it forward and
    // running it off the back of the user's next message.
    expect(res.reason).toContain("It did not happen");
    expect(res.reason).toContain("Do not retry it");
  });

  it("cycles modes in a stable order", () => {
    expect(nextMode("normal")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("plan");
    // Auto comes after plan, so two presses still land on plan mode and the
    // most permissive mode is never one press away from the default.
    expect(nextMode("plan")).toBe("auto");
    expect(nextMode("auto")).toBe("normal");
    // On a model auto mode is not offered on, the cycle leaves it out.
    expect(nextMode("plan", false)).toBe("normal");
    expect(nextMode("auto", false)).toBe("normal");
  });

  it("denies everything when nobody can be asked", async () => {
    const res = await denyAll(write);
    expect(res.allowed).toBe(false);
  });
});

describe("auto mode", () => {
  const root = process.cwd();
  const cmd = (command: string): PermissionRequest => ({
    tool: "run_command",
    signature: `run:${command}`,
    summary: `run ${command}`,
    preview: command,
    command,
    root,
  });
  const edit = (path: string): PermissionRequest => ({
    tool: "edit_file",
    signature: `write:${path}`,
    summary: `edit ${path}`,
    path,
    root,
  });

  it("sorts what it can without asking anybody", () => {
    const state = createState("auto");
    expect(decide(state, edit("src/a.ts")).kind).toBe("allow");
    expect(decide(state, cmd("npm test")).kind).toBe("allow");
    expect(decide(state, cmd("sudo rm -rf /")).kind).toBe("block");
    expect(decide(state, cmd("npm install")).kind).toBe("review");
    expect(decide(state, { tool: "kill_shell", signature: "kill:bg1", summary: "stop bg1" }).kind).toBe("allow");
    // What an MCP tool does is the server's business, so it is always reviewed.
    expect(decide(state, { tool: "mcp__gh__create_issue", signature: "mcp:x", summary: "create_issue" }).kind).toBe("review");
  });

  it("asks before an edit to a file that is not code, and says why", () => {
    const verdict = decide(createState("auto"), edit(".mcp.json"));
    expect(verdict.kind).toBe("ask");
    if (verdict.kind === "ask") expect(verdict.note).toContain(".mcp.json");
  });

  it("runs what the reviewer allows, and does not pay to review it twice", async () => {
    const state = createState("auto");
    const ask = vi.fn(async () => "deny" as const);
    const review = vi.fn<Reviewer>(async () => ({ decision: "allow" }));
    const permit = createPermit(() => state, ask);

    expect(await permit(cmd("npm install"), review)).toEqual({ allowed: true });
    expect(await permit(cmd("npm install"), review)).toEqual({ allowed: true });
    expect(review).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    // The reviewer's word is not the user's: it is kept apart from "always".
    expect(state.allowed.has("run:npm install")).toBe(false);
  });

  it("refuses what the reviewer blocks, as a fact the model is told not to work around", async () => {
    const ask = vi.fn(async () => "once" as const);
    const permit = createPermit(() => createState("auto"), ask);
    const res = await permit(cmd("git push --force"), async () => ({ decision: "block", reason: "it rewrites shared history" }));
    expect(res.allowed).toBe(false);
    if (res.allowed) throw new Error("unreachable");
    expect(res.notice).toBe("auto mode blocked this: it rewrites shared history");
    expect(res.reason).toContain("It did not happen");
    expect(res.reason).toContain("Do not retry it");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks the user whenever the review cannot be had, and never lets it through on its own", async () => {
    const notes: (string | undefined)[] = [];
    const permit = createPermit(
      () => createState("auto"),
      async (_req, note) => {
        notes.push(note);
        return "deny";
      },
    );
    const unavailable = await permit(cmd("npm install"), async () => ({ decision: "unavailable", why: "the gateway could not be reached" }));
    expect(unavailable.allowed).toBe(false);
    const noReviewer = await permit(cmd("npm install"));
    expect(noReviewer.allowed).toBe(false);
    expect(notes[0]).toContain("the gateway could not be reached");
    expect(notes[1]).toContain("up to you");
  });

  it("stops quietly on esc during a review, without asking", async () => {
    const ask = vi.fn(async () => "once" as const);
    const res = await createPermit(() => createState("auto"), ask)(cmd("npm install"), async () => ({ decision: "stopped" }));
    expect(res.allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks instead of refusing once it has refused enough in a row", async () => {
    const state = createState("auto");
    const ask = vi.fn(async (_req: PermissionRequest, _note?: string) => "once" as const);
    const permit = createPermit(() => state, ask);
    const block: Reviewer = async () => ({ decision: "block", reason: "no" });

    for (let i = 0; i < AUTO_BLOCKS_IN_A_ROW; i++) expect((await permit(cmd(`x${i}`), block)).allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();

    // The next would-be refusal goes to the user, with the reason it would have had.
    expect(await permit(cmd("x-next"), block)).toEqual({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![1]).toContain("would block this (no)");
    // The user said yes, so the run of refusals is over and auto mode refuses on its own again.
    expect((await permit(cmd("x-again"), block)).allowed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("starts counting again when somebody switches back into auto mode", () => {
    const state = createState("auto");
    state.autoBlocks = { inARow: 3, total: 19 };
    switchMode(state, "normal");
    switchMode(state, "auto");
    expect(state.autoBlocks).toEqual({ inARow: 0, total: 0 });
  });

  it("tells the model the rule up front", () => {
    const text = modeInstruction("auto");
    expect(text).toContain("# Permission mode: auto");
    expect(text).toContain("A block means the action did not happen");
  });
});
