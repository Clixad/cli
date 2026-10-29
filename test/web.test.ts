/**
 * `web_fetch`'s two halves: what we are willing to open, and what we make of
 * what comes back.
 *
 * No network anywhere — `fetchPage` takes a `fetchImpl`, and the responses are
 * real `Response` objects so the streaming read is exercised rather than
 * stubbed around.
 *
 * The conversion is not a parser and never will be, so the tests are about the
 * properties that decide whether the output is worth paying to put in a context:
 * script and style are gone, the reading order survives, links keep their
 * targets (research is rarely one page), and truncation is *stated*.
 */
import { describe, expect, it } from "vitest";
import { decodeEntities, fetchPage, htmlToText, normalizeUrl, WebError, MAX_TEXT_CHARS } from "../src/web.ts";

const reply = (body: string | Buffer, contentType: string, status = 200, url = "https://example.com/page") =>
  Object.defineProperty(new Response(body, { status, headers: { "content-type": contentType } }), "url", {
    value: url,
  });

describe("normalizeUrl", () => {
  it("assumes https for a bare host, as every browser does", () => {
    expect(normalizeUrl("example.com/docs").toString()).toBe("https://example.com/docs");
  });

  it("keeps an explicit http url", () => {
    expect(normalizeUrl("http://127.0.0.1:3000/health").toString()).toBe("http://127.0.0.1:3000/health");
  });

  it("refuses every scheme that is not http(s)", () => {
    // `file:` would be a way to read the disk without going past safeResolve,
    // and `data:` a way to smuggle content in as if it came from the network.
    for (const url of ["file:///etc/passwd", "data:text/html,<b>hi", "javascript:alert(1)", "ftp://x/y"]) {
      expect(() => normalizeUrl(url), url).toThrow(WebError);
    }
  });

  it("refuses an empty or unparseable url", () => {
    expect(() => normalizeUrl("")).toThrow(WebError);
    expect(() => normalizeUrl("http://")).toThrow(WebError);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex forms", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x2014; d &hellip;")).toBe("a & b 'c' — d …");
  });

  it("leaves something that is not an entity exactly as written", () => {
    // Prose about shell variables and prices is full of ampersands.
    expect(decodeEntities("run a & b &notanentity; 100&")).toBe("run a & b &notanentity; 100&");
  });

  it("does not turn a broken numeric entity into a replacement character", () => {
    expect(decodeEntities("&#xD800; &#999999999;")).toBe("&#xD800; &#999999999;");
  });
});

describe("htmlToText", () => {
  it("drops script and style, keeps the prose", () => {
    const html = `<html><head><title>Docs</title><style>b{color:red}</style></head>
      <body><script>var secret = 1;</script><p>Install with npm.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("# Docs");
    expect(text).toContain("Install with npm.");
    expect(text).not.toContain("var secret");
    expect(text).not.toContain("color:red");
  });

  it("drops an unclosed script at the end of a truncated page", () => {
    expect(htmlToText("<p>hi</p><script>leaked()")).not.toContain("leaked()");
  });

  it("keeps headings as levels and list items as bullets", () => {
    const text = htmlToText("<h2>Options</h2><ul><li>alpha</li><li>beta</li></ul>");
    expect(text).toContain("## Options");
    expect(text).toContain("- alpha");
    expect(text).toContain("- beta");
  });

  it("keeps links, resolved against the page they were found on", () => {
    // Without this an index page is useless: the model reads a list of titles
    // and has nothing to fetch next.
    const text = htmlToText('<a href="/api/v2">API</a>', "https://example.com/docs/index.html");
    expect(text).toContain("[API](https://example.com/api/v2)");
  });

  it("drops the target of an in-page or javascript link but keeps the words", () => {
    const text = htmlToText('<a href="#top">Back to top</a> <a href="javascript:x()">Run</a>', "https://e.com/");
    expect(text).toContain("Back to top");
    expect(text).toContain("Run");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("](#top)");
  });

  it("separates blocks so the reading order survives", () => {
    const text = htmlToText("<div>one</div><div>two</div><p>three</p>");
    expect(text.split("\n").filter(Boolean)).toEqual(["one", "two", "three"]);
  });
});

describe("fetchPage", () => {
  it("converts HTML and reports where it ended up", async () => {
    const page = await fetchPage("example.com/page", {
      fetchImpl: async () => reply("<title>T</title><p>body text</p>", "text/html; charset=utf-8"),
    });
    expect(page.status).toBe(200);
    expect(page.contentType).toBe("text/html");
    expect(page.url).toBe("https://example.com/page");
    expect(page.text).toContain("body text");
  });

  it("pretty-prints JSON", async () => {
    const page = await fetchPage("https://api.example.com/v1", {
      fetchImpl: async () => reply('{"a":1,"b":[2,3]}', "application/json"),
    });
    expect(page.text).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("falls back to the raw body when a JSON content-type is a lie", async () => {
    const page = await fetchPage("https://api.example.com/v1", {
      fetchImpl: async () => reply("<html>oops</html>", "application/json"),
    });
    expect(page.text).toContain("oops");
  });

  it("reads HTML that was served without a content-type", async () => {
    const page = await fetchPage("https://example.com", {
      fetchImpl: async () => reply("<html><body><p>sniffed</p></body></html>", ""),
    });
    expect(page.text).toContain("sniffed");
  });

  it("hands back a 404's body rather than throwing, because it usually says why", async () => {
    const page = await fetchPage("https://example.com/missing", {
      fetchImpl: async () => reply("<p>No such version</p>", "text/html", 404),
    });
    expect(page.status).toBe(404);
    expect(page.text).toContain("No such version");
  });

  it("says when it truncated, rather than shortening in silence", async () => {
    const long = `<p>${"word ".repeat(50_000)}</p>`;
    const page = await fetchPage("https://example.com/long", {
      fetchImpl: async () => reply(long, "text/html"),
    });
    expect(page.truncated).toBe(true);
    expect(page.text).toContain("[page truncated");
    expect(page.text.length).toBeLessThan(MAX_TEXT_CHARS + 200);
  });

  it("honours a caller's smaller cap", async () => {
    const page = await fetchPage("https://example.com/long", {
      maxChars: 50,
      fetchImpl: async () => reply(`<p>${"x".repeat(500)}</p>`, "text/html"),
    });
    expect(page.text).toContain("[page truncated at 50 characters]");
  });

  it("describes a binary body instead of dumping it", async () => {
    const page = await fetchPage("https://example.com/logo.png", {
      fetchImpl: async () => reply(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"),
    });
    expect(page.text).toBe("");
    expect(page.note).toContain("image/png");
  });

  it("reports an unreachable host as something the model can act on", async () => {
    await expect(
      fetchPage("https://nope.example", {
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/could not reach nope.example/);
  });

  it("lets the caller's abort travel as an abort", async () => {
    // Esc has to stop the turn, not tell the model the network failed.
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchPage("https://example.com", {
        signal: ac.signal,
        fetchImpl: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
