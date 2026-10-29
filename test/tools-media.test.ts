/**
 * `read_file` on something that is not source code.
 *
 * Three outcomes, and the whole design is in which one you get. A PDF becomes
 * its text layer. An image becomes an *attachment plus a sentence*, because an
 * OpenAI-compatible `tool` message carries a string and nothing else — so the
 * bytes have to travel as their own user message and the tool result's job is to
 * tell the model to look there. Anything else binary is refused by name, rather
 * than poured into a metered context as several hundred kilobytes of mojibake.
 */
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, ToolError, type ToolContext } from "../src/tools.ts";
import { expandMentions } from "../src/mentions.ts";
import type { ImageAttachment } from "../src/client.ts";

let root: string;
let ctx: ToolContext;
let attached: ImageAttachment[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clixad-media-"));
  attached = [];
  ctx = { root, attach: (image) => attached.push(image) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Magic bytes plus padding — `imageType` sniffs, it does not decode. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);

function write(name: string, data: Buffer | string): string {
  writeFileSync(join(root, name), data);
  return name;
}

function pdf(body: string): Buffer {
  const stream = deflateSync(Buffer.from(body, "latin1"));
  return Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n3 0 obj << /Type /Page >> endobj\n" +
        `4 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from("\nendstream endobj\n%%EOF\n", "latin1"),
  ]);
}

describe("read_file on an image", () => {
  it("attaches the bytes and tells the model where they are", () => {
    const out = TOOLS.read_file(ctx, { path: write("shot.png", PNG) });
    expect(attached).toHaveLength(1);
    expect(attached[0]!.mimeType).toBe("image/png");
    expect(attached[0]!.data).toBe(PNG.toString("base64"));
    // Without this sentence a model reads "attached" and describes the filename.
    expect(out).toContain("The image itself follows this tool result");
  });

  it("sniffs the format rather than trusting the extension", () => {
    // A .txt that is really a JPEG is still a JPEG; a .png that is really text
    // is still text.
    TOOLS.read_file(ctx, { path: write("actually-a-photo.txt", JPEG) });
    expect(attached[0]!.mimeType).toBe("image/jpeg");

    attached = [];
    const out = TOOLS.read_file(ctx, { path: write("not-really.png", "just words\n") });
    expect(attached).toHaveLength(0);
    expect(out).toContain("just words");
  });

  it("refuses one that is too large to re-send every round", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(5_000_000, 1)]);
    expect(() => TOOLS.read_file(ctx, { path: write("huge.png", huge) })).toThrow(/over the .* MB limit/);
  });

  it("says images cannot be shown when the run has nowhere to put them", () => {
    // `clixad -p` and any caller that wired no `attach`.
    expect(() => TOOLS.read_file({ root }, { path: write("a.png", PNG) })).toThrow(ToolError);
    expect(() => TOOLS.read_file({ root }, { path: write("a.png", PNG) })).toThrow(/cannot show images/);
  });
});

describe("read_file on a PDF", () => {
  it("reads the text layer and says how many pages there are", () => {
    const out = TOOLS.read_file(ctx, { path: write("spec.pdf", pdf("BT (the retry count is 5) Tj ET")) });
    expect(out).toContain("the retry count is 5");
    expect(out).toContain("1 page");
  });

  it("explains an image-only PDF instead of returning an empty string", () => {
    const scanned = Buffer.from("%PDF-1.4\n3 0 obj << /Type /Page >> endobj\n%%EOF\n", "latin1");
    const out = TOOLS.read_file(ctx, { path: write("scan.pdf", scanned) });
    expect(out).toContain("no text layer");
  });
});

describe("read_file on anything else binary", () => {
  it("refuses by name rather than returning mojibake", () => {
    const blob = Buffer.concat([Buffer.from("ELF\0"), Buffer.alloc(4000, 0)]);
    expect(() => TOOLS.read_file(ctx, { path: write("a.bin", blob) })).toThrow(/binary file/);
  });

  it("still reads ordinary text, including a file with no trailing newline", () => {
    expect(TOOLS.read_file(ctx, { path: write("a.txt", "one\ntwo") })).toBe("    1\tone\n    2\ttwo");
  });

  it("does not mistake source with unicode in it for binary", () => {
    const source = 'const label = "Sponsored — 40,000–300,000 credits ✔";\n'.repeat(50);
    expect(TOOLS.read_file(ctx, { path: write("a.ts", source) })).toContain("Sponsored");
  });
});

describe("@mentions of an image", () => {
  it("attach the picture, not a sentence about a file the model cannot open", () => {
    write("bug.png", PNG);
    const out = expandMentions("why does @bug.png look wrong?", root);
    expect(out.attached).toEqual(["bug.png"]);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mimeType).toBe("image/png");
  });

  it("leave a mention that cannot be read exactly as typed", () => {
    const out = expandMentions("see @nope.png", root);
    expect(out.text).toBe("see @nope.png");
    expect(out.images).toEqual([]);
  });

  it("carry text and images together", () => {
    write("notes.txt", "hello from the file");
    write("shot.png", PNG);
    const out = expandMentions("compare @notes.txt with @shot.png", root);
    expect(out.text).toContain("hello from the file");
    expect(out.images).toHaveLength(1);
    expect(out.attached).toEqual(["notes.txt", "shot.png"]);
  });
});
