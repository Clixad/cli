/**
 * PDF text extraction.
 *
 * The fixtures are built here, byte by byte, rather than committed: a binary
 * blob in the repo is a test nobody can read, and the point of every case below
 * is *which construct* it exercises — a Flate stream, a hex string, a CID font,
 * an image-only page. Built means the construct is visible in the test.
 *
 * The one property that matters more than accuracy is that nothing throws. The
 * caller is a tool result, and an exception there reads to the model as "the
 * file does not exist" — so a PDF we cannot read has to come back as a sentence
 * saying so.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractPdfText, looksLikePdf } from "../src/pdf.ts";

/** A one-page PDF whose content stream is `body`, optionally Flate-compressed. */
function pdf(body: string, opts: { compress?: boolean; extraDict?: string } = {}): Buffer {
  const raw = Buffer.from(body, "latin1");
  const stream = opts.compress === false ? raw : deflateSync(raw);
  const dict = `<< /Length ${stream.length}${opts.compress === false ? "" : " /Filter /FlateDecode"}${opts.extraDict ?? ""} >>`;
  return Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n" +
        `4 0 obj ${dict}\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}

describe("looksLikePdf", () => {
  it("is the magic bytes and nothing else", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(looksLikePdf(Buffer.from("not a pdf"))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });
});

describe("extractPdfText", () => {
  it("reads a Flate-compressed text stream", () => {
    const doc = pdf("BT /F1 12 Tf 72 720 Td (Hello Clixad) Tj 0 -14 Td (second line) Tj ET");
    const out = extractPdfText(doc);
    expect(out.text).toContain("Hello Clixad");
    expect(out.text).toContain("second line");
    expect(out.pages).toBe(1);
    expect(out.note).toBeUndefined();
  });

  it("reads an uncompressed stream too", () => {
    const out = extractPdfText(pdf("BT (plain bytes) Tj ET", { compress: false }));
    expect(out.text).toContain("plain bytes");
  });

  it("counts pages without counting the /Pages node", () => {
    // `/Type /Page` and `/Type /Pages` differ by one letter, and reading the
    // tree node as a page makes every document one page longer than it is.
    expect(extractPdfText(pdf("BT (x) Tj ET")).pages).toBe(1);
  });

  it("keeps parentheses that are part of the text", () => {
    // The reason this is a scanner and not a regex: `\(([^)]*)\)` finds the
    // wrong end of the very first string that contains a bracket.
    const out = extractPdfText(pdf("BT (call foo\\(bar\\) now) Tj ET"));
    expect(out.text).toContain("call foo(bar) now");
  });

  it("handles nested parentheses and octal escapes", () => {
    const out = extractPdfText(pdf("BT ((nested) text) Tj (\\101\\102) Tj ET"));
    expect(out.text).toContain("(nested) text");
    expect(out.text).toContain("AB");
  });

  it("decodes hex strings, including two-byte CID text", () => {
    // `<48656C6C6F>` is plain bytes; `<00480065>` is UTF-16BE, which is what a
    // word processor's embedded font emits for ordinary Latin text.
    const out = extractPdfText(pdf("BT <48656C6C6F> Tj <00480065> Tj ET"));
    expect(out.text).toContain("Hello");
    expect(out.text).toContain("He");
  });

  it("turns a wide kerning gap into a space", () => {
    const out = extractPdfText(pdf("BT [(one)-300(two)] TJ ET"));
    expect(out.text).toContain("one two");
  });

  it("does not turn a small kerning adjustment into a space", () => {
    const out = extractPdfText(pdf("BT [(kern)-20(ing)] TJ ET"));
    expect(out.text.replace(/\n/g, "")).toContain("kerning");
  });

  it("says a scanned page has no text layer instead of returning nothing", () => {
    // The distinction the note exists for: "there is no text" and "we could not
    // read the text" send the reader to completely different next steps.
    const scanned = pdf("\xff\xd8\xff\xe0 jpeg bytes", {
      compress: false,
      extraDict: " /Subtype /Image /Filter /DCTDecode",
    });
    const out = extractPdfText(scanned);
    expect(out.text).toBe("");
    expect(out.note).toContain("no text layer");
  });

  it("refuses an encrypted document by name", () => {
    const doc = Buffer.concat([pdf("BT (secret) Tj ET"), Buffer.from("\n/Encrypt 9 0 R\n")]);
    const out = extractPdfText(doc);
    expect(out.note).toContain("encrypted");
    expect(out.text).toBe("");
  });

  it("says so rather than throwing when the bytes are not a PDF", () => {
    const out = extractPdfText(Buffer.from("just some text"));
    expect(out.note).toContain("not a PDF");
  });

  it("survives a truncated file and a stream that will not inflate", () => {
    const broken = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj << /Length 40 /Filter /FlateDecode >>\nstream\n"),
      Buffer.from("this is not deflate data at all"),
      Buffer.from("\nendstream"),
    ]);
    expect(() => extractPdfText(broken)).not.toThrow();
    expect(extractPdfText(broken).text).toBe("");
  });

  it("respects the character cap", () => {
    const long = `BT ${Array.from({ length: 200 }, (_, i) => `(line ${i} of text) Tj`).join(" ")} ET`;
    expect(extractPdfText(pdf(long), 100).text.length).toBeLessThanOrEqual(100);
  });
});
