/**
 * Session + history persistence. HOME/USERPROFILE are redirected to a temp dir
 * *before* importing the module (it resolves ~/.clixad once, at load time), so
 * the test never touches the real config directory.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/client.ts";

let home: string;
let session: typeof import("../src/session.ts");
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "adg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  session = await import("../src/session.ts");
});

afterAll(() => {
  process.env.HOME = realHome.HOME;
  process.env.USERPROFILE = realHome.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

const messages: ChatMessage[] = [
  { role: "user", content: "rename foo to bar" },
  { role: "assistant", content: "done" },
];

describe("sessions", () => {
  it("saves and reloads a conversation", () => {
    const id = session.newSessionId();
    session.saveSession({
      id,
      started: "2026-07-23T10:00:00.000Z",
      updated: "2026-07-23T10:05:00.000Z",
      cwd: "/work/project",
      model: "gemini-2.5-flash-lite",
      title: "rename foo to bar",
      messages,
    });

    const back = session.loadSession(id);
    expect(back?.messages).toEqual(messages);
    expect(back?.title).toBe("rename foo to bar");
  });

  it("lists newest first and filters by directory", () => {
    const base = {
      started: "2026-07-23T10:00:00.000Z",
      model: "m",
      title: "t",
      messages,
    };
    session.saveSession({ ...base, id: "s-old", updated: "2026-07-01T10:00:00.000Z", cwd: "/work/a" });
    session.saveSession({ ...base, id: "s-new", updated: "2026-07-22T10:00:00.000Z", cwd: "/work/a" });
    session.saveSession({ ...base, id: "s-other", updated: "2026-07-23T10:00:00.000Z", cwd: "/work/b" });

    const inA = session.listSessions("/work/a").map((s) => s.id);
    expect(inA).toEqual(["s-new", "s-old"]);
    expect(session.latestSession("/work/a")?.id).toBe("s-new");
    expect(session.latestSession("/work/nothing-here")).toBeUndefined();
  });

  it("round-trips input history newest-first", () => {
    session.saveHistory(["third", "second", "first"]);
    expect(session.loadHistory()).toEqual(["third", "second", "first"]);
  });
});

describe("images in a saved session", () => {
  it("are not written to disk, but leave a trace that they were there", () => {
    // A session file was text until screenshots could reach a conversation.
    // Fifty of them carrying base64 is a directory nobody asked for — and
    // handing a screenshot from three days ago back to the model is not what
    // resuming is for. What must survive is that an image was *discussed*, or a
    // resumed turn reads "look at this" with nothing after it.
    const id = session.newSessionId();
    session.saveSession({
      id,
      started: "2026-08-21T10:00:00.000Z",
      updated: "2026-08-21T10:05:00.000Z",
      cwd: "/work/project",
      model: "gemini-2.5-flash-lite",
      title: "look at the screenshot",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "why does this look wrong?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAABBBBCCCC" } },
          ],
        },
      ],
    });

    const raw = readFileSync(join(home, ".clixad", "sessions", `${id}.json`), "utf8");
    expect(raw).not.toContain("AAAABBBBCCCC");

    const back = session.loadSession(id)!;
    expect(back.messages[0]!.content).toContain("why does this look wrong?");
    expect(back.messages[0]!.content).toContain("image not kept in the saved session: image/png");
  });
});

describe("finding and deleting sessions (0.0.1-beta.45)", () => {
  const base = { started: "2026-11-05T10:00:00.000Z", model: "m", title: "t", messages };

  it("deletes one session by id, and nothing else", () => {
    session.saveSession({ ...base, id: "del-keep", updated: "2026-11-05T10:00:00.000Z", cwd: "/work/del" });
    session.saveSession({ ...base, id: "del-go", updated: "2026-11-05T11:00:00.000Z", cwd: "/work/del" });
    expect(session.deleteSession("del-go")).toBe(true);
    expect(session.loadSession("del-go")).toBeUndefined();
    expect(session.listSessions("/work/del").map((s) => s.id)).toEqual(["del-keep"]);
    // Gone is gone: a second delete says so rather than pretending.
    expect(session.deleteSession("del-go")).toBe(false);
  });

  it("never turns a typed id into a path outside the session directory", () => {
    // `/resume <id>` and `/resume delete <id>` take the id as typed.
    for (const id of ["../config", "..", "a/b", "a\\b", "", ".hidden", "x".repeat(65)]) {
      expect(session.isSessionId(id), id).toBe(false);
      expect(session.loadSession(id), id).toBeUndefined();
      expect(session.deleteSession(id), id).toBe(false);
    }
    expect(session.isSessionId(session.newSessionId())).toBe(true);
  });

  it("says how many messages each one holds", () => {
    session.saveSession({ ...base, id: "count-me", updated: "2026-11-05T12:00:00.000Z", cwd: "/work/count" });
    expect(session.listSessions("/work/count")[0]?.messageCount).toBe(messages.length);
  });

  it("files a directory written with a trailing separator under the same directory", () => {
    session.saveSession({ ...base, id: "slash", updated: "2026-11-05T13:00:00.000Z", cwd: "/work/slash/" });
    expect(session.listSessions("/work/slash").map((s) => s.id)).toEqual(["slash"]);
    expect(session.hasSessionIn("/work/slash")).toBe(true);
    expect(session.hasSessionIn("/work/slash-not")).toBe(false);
  });

  it("compares directories without case on Windows, where the drive letter's case varies", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(session.sameDirectory("C:\\work\\app", "c:\\work\\app")).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    // Everywhere else case is part of the name.
    expect(session.sameDirectory("/work/App", "/work/app")).toBe(process.platform === "win32");
  });

  it("keeps far more than fifty conversations", () => {
    expect(session.MAX_SESSIONS).toBeGreaterThanOrEqual(200);
  });
});
