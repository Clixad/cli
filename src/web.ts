/**
 * Reading a page off the web, and turning it into something worth spending
 * context on.
 *
 * The agent had no way to reach the internet at all, which is why it answered
 * "I can't research that" — correctly, since nothing in the tool schema could.
 * This is the fetching half (`web_fetch`); the searching half goes through the
 * gateway, because a search API needs a key and the CLI holds none.
 *
 * Everything here is bounded, because the caller is a metered context: a 4 MB
 * marketing page converted verbatim is a bill, not an answer. The wire read is
 * capped, the converted text is capped, and the cap is *stated* in the result —
 * a silently shortened page read as a whole one is how an agent concludes a
 * documented option does not exist.
 *
 * HTML becomes Markdown rather than bare text, and links keep their targets.
 * Research is rarely one page: the model reads a docs index and needs to be able
 * to say "now fetch that one", which it cannot do if the hrefs were thrown away.
 */
import { extractPdfText, looksLikePdf } from "./pdf.ts";

/** Most bytes read from the wire before we stop and use what we have. */
export const MAX_FETCH_BYTES = 5_000_000;
/** Most characters handed back to the model. */
export const MAX_TEXT_CHARS = 60_000;
/** Whole-request timeout, including the body read. */
export const FETCH_TIMEOUT_MS = 20_000;

export interface FetchedPage {
  /** Where we ended up — redirects included, so the model cites the real page. */
  url: string;
  status: number;
  contentType: string;
  /** Converted, capped body. */
  text: string;
  truncated: boolean;
  /** Set when the body was not text and could not be converted. */
  note?: string;
}

export class WebError extends Error {}

/**
 * Normalise what a model typed into a URL we are willing to open.
 *
 * `http:` and `https:` only. Everything else — `file:`, `data:`, `ftp:`,
 * `javascript:` — is either a way to read the disk without going past
 * `safeResolve` or a way to smuggle content in as if it had come from the
 * network, and neither is what this tool is for.
 */
export function normalizeUrl(input: string): URL {
  const raw = (input ?? "").trim();
  if (!raw) throw new WebError("web_fetch needs a url");
  // A bare host is what people (and models) type; assume https rather than
  // failing on it, which is what every browser does.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WebError(`not a valid url: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(`only http and https urls can be fetched (got ${url.protocol})`);
  }
  return url;
}

/**
 * Fetch a URL and convert whatever comes back into text.
 *
 * Never throws for an HTTP status: a 404 page often says why, and handing the
 * model the status plus the body is more useful than an exception it has to
 * guess at. It throws only when there is nothing to hand back at all — a bad
 * URL, a refused connection, a timeout.
 */
export async function fetchPage(
  input: string,
  opts: { signal?: AbortSignal; maxChars?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchedPage> {
  const url = normalizeUrl(input);
  const doFetch = opts.fetchImpl ?? fetch;
  const maxChars = opts.maxChars ?? MAX_TEXT_CHARS;

  // Our own deadline, folded together with the caller's Esc. `AbortSignal.any`
  // is the only way to have both without leaking a listener on a long-lived
  // signal, and the timeout has to be cleared on the happy path or the process
  // stays awake for it.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new WebError("timed out")), FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;

  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      signal,
      redirect: "follow",
      headers: {
        // Some sites serve a different (or no) page to a client that does not
        // introduce itself. Ours says what it is and where to complain.
        "User-Agent": "Clixad/1.0 (+https://clixad.io; terminal coding agent)",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en,*;q=0.5",
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    // The caller's abort is theirs to report; ours is a fetch that took too long.
    if (opts.signal?.aborted) throw err;
    if (timer.signal.aborted) throw new WebError(`no response from ${url.host} within ${FETCH_TIMEOUT_MS / 1000}s`);
    throw new WebError(`could not reach ${url.host}: ${(err as Error).message}`);
  }

  try {
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = await readCapped(res, signal);
    const finalUrl = res.url || url.toString();
    const converted = convert(body, contentType, finalUrl, maxChars);
    return {
      url: finalUrl,
      status: res.status,
      contentType: contentType.split(";")[0]?.trim() ?? "",
      ...converted,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Read at most MAX_FETCH_BYTES of a response body. */
async function readCapped(res: Response, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(Buffer.from(value));
        total += value.byteLength;
        // Stop pulling rather than keep the socket open for a body we will
        // throw away — a video URL would otherwise download in full.
        if (total >= MAX_FETCH_BYTES) break;
      }
      if (signal.aborted) break;
    }
  } finally {
    // Cancelling a reader that already finished is a no-op; not cancelling one
    // that has not leaves the connection held open.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts);
}

/** Body bytes → the text we show, given what the server said it is. */
function convert(
  body: Buffer,
  contentType: string,
  url: string,
  maxChars: number,
): { text: string; truncated: boolean; note?: string } {
  const cap = (text: string, note?: string) => {
    const truncated = text.length > maxChars;
    return {
      text: truncated ? `${text.slice(0, maxChars)}\n\n… [page truncated at ${maxChars} characters]` : text,
      truncated,
      ...(note ? { note } : {}),
    };
  };

  // Sniffed rather than trusted: plenty of servers label a PDF as
  // application/octet-stream, and the magic bytes are not ambiguous.
  if (contentType.includes("pdf") || looksLikePdf(body)) {
    const pdf = extractPdfText(body, maxChars);
    const head = `[PDF${pdf.pages ? `, ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}` : ""}]`;
    return cap(pdf.text ? `${head}\n\n${pdf.text}` : head, pdf.note);
  }
  if (contentType.includes("json")) {
    const raw = body.toString("utf8");
    try {
      return cap(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      return cap(raw); // a JSON content-type over something that is not JSON
    }
  }
  if (contentType.includes("html") || contentType.includes("xml")) {
    return cap(htmlToText(body.toString("utf8"), url));
  }
  if (contentType.startsWith("text/") || contentType === "") {
    const raw = body.toString("utf8");
    // An unlabelled body that is full of tags is HTML, whatever the header says.
    return cap(/<\/?(html|body|div|p|h1)\b/i.test(raw.slice(0, 2000)) ? htmlToText(raw, url) : raw);
  }
  return {
    text: "",
    truncated: false,
    note: `the response is ${contentType || "an unknown type"} (${body.length} bytes), which is not text — nothing to read`,
  };
}

/** Block-level tags whose end should become a paragraph break. */
const BLOCK = "address|article|aside|blockquote|details|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|header|hr|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|tr|ul";

/**
 * HTML → Markdown-ish text.
 *
 * Not a parser, and not trying to be one: the goal is the reading order of a
 * page and its links, which tag-level rewriting gets right often enough to be
 * worth a fraction of the cost. Every pattern is lazy and anchored on a tag
 * name, so none of them backtrack over a megabyte of markup.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html;

  // Everything that is markup about the page rather than the page.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // Unclosed <script> at the end of a truncated page would otherwise leave code.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*$/i, " ");

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  // Headings keep their level; that is most of a docs page's structure.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
    const text = stripTags(inner);
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
  });

  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(new RegExp(`</(${BLOCK})\\s*>`, "gi"), "\n\n");
  s = s.replace(new RegExp(`<(${BLOCK})\\b[^>]*>`, "gi"), "\n");
  // A table cell that runs into the next one is unreadable; a space is enough.
  s = s.replace(/<\/(td|th)\s*>/gi, " | ");

  // Links, with their targets resolved. Kept because research is rarely one
  // page: an index whose hrefs were thrown away cannot be followed.
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      const href = (dq ?? sq ?? bare ?? "").trim();
      if (!text) return " ";
      const abs = absolute(href, baseUrl);
      // In-page anchors and javascript: links point at nothing a fetch can use.
      if (!abs || text.length > 120) return ` ${text} `;
      return ` [${text}](${abs}) `;
    });

  s = stripTags(s);
  s = decodeEntities(s);

  const body = s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const heading = title ? `# ${decodeEntities(stripTags(title)).trim()}\n\n` : "";
  return (heading + body).trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Resolve `href` against the page it was found on; undefined if unusable. */
function absolute(href: string, baseUrl?: string): string | undefined {
  if (!href || href.startsWith("#")) return undefined;
  try {
    const url = baseUrl ? new URL(href, baseUrl) : new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", deg: "°", plusmn: "±",
  times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§",
  para: "¶", middot: "·", bull: "•", dagger: "†", permil: "‰", larr: "←", rarr: "→",
  harr: "↔", darr: "↓", uarr: "↑", ne: "≠", le: "≤", ge: "≥", minus: "−", shy: "",
};

/** Decode the entity forms that actually appear in prose. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values throw; a broken entity is better left
      // as the text somebody wrote than turned into a replacement character.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}
