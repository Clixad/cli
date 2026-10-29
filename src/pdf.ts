/**
 * PDF text extraction, with no dependency and no network.
 *
 * A PDF that reaches an agent is usually a spec, an invoice or an API document
 * somebody dropped in the repo, and the question is always "what does it say".
 * Answering that needs the *text layer*, which is what this file reads: content
 * streams (`FlateDecode`d, which is what every producer since Acrobat 4 emits),
 * scanned for the four text-showing operators.
 *
 * Two things it deliberately is not.
 *
 * It is **not a renderer**. Position operators become line breaks, so a
 * two-column layout comes out interleaved and a table loses its columns. That is
 * the honest ceiling of reading a page description without laying it out, and it
 * is still the difference between "I can't open this" and an answerable question.
 *
 * It is **not an OCR**. A scanned page is an image with no text layer at all, and
 * every extractor in the world returns nothing for it. So a result that comes
 * back empty says *which* of the two happened (`note`), because "no text" and
 * "text we could not decode" send the reader to completely different next steps.
 *
 * Why not a library: `apps/cli` ships standalone through npx, and the two real
 * options are a 10 MB wasm bundle or a package with a startup file read. Neither
 * is worth it for a feature whose failure mode is "ask the user to paste it".
 */
import { inflateSync } from "node:zlib";

/** Most decompressed content-stream bytes we will walk, over the whole file. */
const MAX_STREAM_BYTES = 24_000_000;
/** Most characters of text returned, before the caller's own cap. */
const MAX_TEXT_CHARS = 400_000;
/** How far back from `stream` to look for the dictionary that describes it. */
const DICT_LOOKBACK = 4_000;

export interface PdfText {
  text: string;
  /** Pages found in the document, or 0 when the structure could not be read. */
  pages: number;
  /** Present when the text is absent or suspect — always say which. */
  note?: string;
}

/** True for the `%PDF-` magic. Cheap enough to call before anything else. */
export function looksLikePdf(data: Buffer): boolean {
  return data.length > 4 && data.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * The text layer of `data`, page breaks preserved as blank lines.
 *
 * Never throws: a malformed file, a stream that will not inflate and a font we
 * cannot decode all come back as a `note`, because the caller is a tool result
 * and an exception there reads to the model as "the file does not exist".
 */
export function extractPdfText(data: Buffer, maxChars = MAX_TEXT_CHARS): PdfText {
  if (!looksLikePdf(data)) return { text: "", pages: 0, note: "not a PDF (no %PDF- header)" };

  // latin1 maps one byte to one char, so string offsets are byte offsets. Any
  // other encoding would make `indexOf` disagree with `subarray`.
  const bin = data.toString("latin1");
  const pages = countPages(bin);

  if (/\/Encrypt\b/.test(bin)) {
    return { text: "", pages, note: "the PDF is encrypted — its text cannot be read without the password" };
  }

  const chunks: string[] = [];
  let budget = MAX_STREAM_BYTES;
  let streams = 0;
  let undecodable = 0;

  for (let at = bin.indexOf("stream", 0); at !== -1; at = bin.indexOf("stream", at + 6)) {
    if (budget <= 0) break;
    // `endstream` and `endobj` both contain the word; only a standalone keyword
    // opens a stream.
    if (bin.startsWith("endstream", at - 3)) continue;

    const dict = bin.slice(Math.max(0, at - DICT_LOOKBACK), at);
    if (!isTextStream(dict)) continue;

    // The keyword is followed by CRLF or LF, per the spec; some producers emit
    // a bare CR. Anything else means this was not a stream keyword after all.
    let from = at + 6;
    if (bin[from] === "\r") from++;
    if (bin[from] === "\n") from++;
    else if (bin[from - 1] !== "\r") continue;

    const end = bin.indexOf("endstream", from);
    if (end === -1) break;

    const raw = data.subarray(from, end);
    let content: Buffer;
    if (/\/FlateDecode/.test(dict)) {
      try {
        content = inflateSync(raw);
      } catch {
        // A stream that will not inflate is not a reason to abandon the file —
        // the next one usually carries the same page's text.
        undecodable++;
        at = end;
        continue;
      }
    } else if (/\/Filter/.test(dict)) {
      // LZW, RunLength, JBIG2 and friends. Counted, not guessed at.
      undecodable++;
      at = end;
      continue;
    } else {
      content = raw;
    }

    budget -= content.length;
    streams++;
    const text = readContentStream(content.toString("latin1"));
    if (text.trim()) chunks.push(text);
    at = end;
  }

  const text = tidy(chunks.join("\n\n")).slice(0, maxChars);
  if (!text.trim()) {
    return {
      text: "",
      pages,
      note:
        streams === 0
          ? "no text layer — this looks like a scanned or image-only PDF, so there is nothing to read without OCR"
          : `found ${streams} content stream(s) but no readable text${undecodable ? ` (${undecodable} used a filter we do not decode)` : ""}`,
    };
  }
  // A CID font with no ToUnicode map decodes to bytes that are not letters. The
  // text is then present, wrong, and confidently wrong, which is the one outcome
  // worth naming out loud.
  const note = garbledRatio(text) > 0.3 ? "some text used an embedded font encoding we cannot map — parts of this may be garbled" : undefined;
  return { text, pages, ...(note ? { note } : {}) };
}

/** Pages declared in the document, best effort. */
function countPages(bin: string): number {
  // `/Type /Page` (not `/Pages`) is one page object each.
  const matches = bin.match(/\/Type\s*\/Page(?![s\w])/g);
  if (matches?.length) return matches.length;
  const count = /\/Count\s+(\d+)/.exec(bin);
  return count ? Number(count[1]) : 0;
}

/** Whether a stream dictionary describes something that could hold text. */
function isTextStream(dict: string): boolean {
  // The dictionary for *this* stream is the last one before it.
  const start = dict.lastIndexOf("<<");
  const d = start === -1 ? dict : dict.slice(start);
  if (/\/Subtype\s*\/Image\b/.test(d)) return false;
  if (/\/(DCT|JPX|JBIG2|CCITTFax)Decode\b/.test(d)) return false;
  // Fonts, colour profiles and metadata carry no showable text.
  if (/\/Type\s*\/(Font|Metadata|XRef|ObjStm)\b/.test(d)) return false;
  if (/\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)\b/.test(d)) return false;
  return true;
}

/**
 * The text-showing operators of one content stream, in order.
 *
 * A hand-written scanner rather than a regex: PDF strings nest parentheses and
 * escape them, so `\(([^)]*)\)` finds the wrong end of the very first string
 * that talks about a smiley.
 */
function readContentStream(s: string): string {
  let out = "";
  let pending = "";
  let i = 0;
  // Inside a `[ ... ] TJ` array a number below this is a kerning gap wide enough
  // to be a space. 100 is the conventional threshold (thousandths of an em).
  const SPACE_GAP = -100;

  const flush = () => {
    if (!pending) return;
    out += pending;
    pending = "";
  };

  while (i < s.length) {
    const ch = s[i]!;

    if (ch === "(") {
      const [text, next] = readLiteral(s, i);
      pending += text;
      i = next;
      continue;
    }
    if (ch === "<" && s[i + 1] !== "<") {
      const [text, next] = readHex(s, i);
      pending += text;
      i = next;
      continue;
    }
    if (ch === "<" && s[i + 1] === "<") {
      // An inline dictionary (e.g. a marked-content property list). Skip it
      // whole so its keys are never read as text.
      const end = s.indexOf(">>", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "-" || ch === "." || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < s.length && /[-+.\d]/.test(s[j]!)) j++;
      const value = Number(s.slice(i, j));
      if (Number.isFinite(value) && value <= SPACE_GAP && pending && !pending.endsWith(" ")) pending += " ";
      i = j;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9*'"]/.test(s[j]!)) j++;
      const op = s.slice(i, j);
      i = j;
      switch (op) {
        case "Tj":
        case "TJ":
          flush();
          break;
        // `'` and `"` show a string *and* move to the next line.
        case "'":
        case '"':
          flush();
          out += "\n";
          break;
        case "Td":
        case "TD":
        case "T*":
        case "TL":
          flush();
          out += "\n";
          break;
        case "ET":
          flush();
          out += "\n";
          break;
        case "BT":
          flush();
          break;
        default:
          // Any other operator ends whatever string was being built, or a
          // resource name would run into the next word.
          if (pending && !pending.endsWith(" ")) pending += " ";
          break;
      }
      continue;
    }
    i++;
  }
  flush();
  return out;
}

/** A `( ... )` string literal, with escapes and nesting. Returns [text, nextIndex]. */
function readLiteral(s: string, start: number): [string, number] {
  let out = "";
  let depth = 1;
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      const next = s[i + 1];
      i += 2;
      switch (next) {
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "(": out += "("; break;
        case ")": out += ")"; break;
        case "\\": out += "\\"; break;
        case "\r":
          // A backslash before a newline is a line continuation, not a char.
          if (s[i] === "\n") i++;
          break;
        case "\n": break;
        default:
          if (next && next >= "0" && next <= "7") {
            let oct = next;
            while (oct.length < 3 && s[i] && s[i]! >= "0" && s[i]! <= "7") oct += s[i++]!;
            out += String.fromCharCode(parseInt(oct, 8));
          } else if (next !== undefined) {
            out += next;
          }
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return [out, i + 1];
    }
    out += ch;
    i++;
  }
  return [out, s.length];
}

/**
 * A `< ... >` hex string. Returns [text, nextIndex].
 *
 * Two-byte codes with a zero high byte are a CID font addressing Latin text —
 * common enough (every PDF produced from a modern word processor) that reading
 * them as UTF-16BE is right far more often than reading them as bytes.
 */
function readHex(s: string, start: number): [string, number] {
  const end = s.indexOf(">", start + 1);
  const body = (end === -1 ? s.slice(start + 1) : s.slice(start + 1, end)).replace(/[^0-9A-Fa-f]/g, "");
  const next = end === -1 ? s.length : end + 1;
  const padded = body.length % 2 ? body + "0" : body;

  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) bytes.push(parseInt(padded.slice(i, i + 2), 16));

  const wide =
    bytes.length >= 2 &&
    bytes.length % 2 === 0 &&
    bytes.filter((_, i) => i % 2 === 0).every((b) => b === 0);
  if (wide) {
    let out = "";
    for (let i = 1; i < bytes.length; i += 2) out += String.fromCharCode(bytes[i]!);
    return [out, next];
  }
  return [bytes.map((b) => String.fromCharCode(b)).join(""), next];
}

/** Collapse the whitespace a page description produces into readable lines. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Share of characters that are neither printable nor ordinary whitespace. */
function garbledRatio(text: string): number {
  const sample = text.slice(0, 4000);
  if (!sample) return 0;
  let bad = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0)!;
    const ok = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160;
    if (!ok) bad++;
  }
  return bad / sample.length;
}
