/**
 * Syntax colour for code blocks in answers. Hand-rolled, like `diff.ts` and
 * `pdf.ts`: the CLI ships through npx, and the libraries that do this properly
 * add a megabyte and a startup cost to every install for a feature that only
 * has to make code *readable* rather than exact.
 *
 * It is a scanner, not a parser. It knows comments, strings, numbers, a
 * keyword list and a function call per language family, and it carries one
 * thing from line to line: whether a block comment or a triple-quoted string
 * is still open. That is the only state a line-by-line renderer needs, and it
 * is what lets a code block be committed to the scrollback one line at a time
 * while the model is still writing it.
 *
 * Plain identifiers keep the terminal's own colour, so a light theme still
 * reads; only the tokens that carry structure are coloured.
 */

const KEYWORD = "\x1b[38;2;255;123;114m";
const STRING = "\x1b[38;2;165;214;255m";
const NUMBER = "\x1b[38;2;121;192;255m";
const CONSTANT = "\x1b[38;2;121;192;255m";
const FUNC = "\x1b[38;2;210;168;255m";
const PROPERTY = "\x1b[38;2;126;231;135m";
const VARIABLE = "\x1b[38;2;255;166;87m";
const COMMENT = "\x1b[2m\x1b[3m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
/** Default foreground, and italic and dim off: every token closes itself. */
const OFF = "\x1b[39m\x1b[23m\x1b[22m";

export interface HighlightState {
  /** The closing delimiter of a block comment or string still open. */
  open?: { close: string; kind: "comment" | "string" };
}

interface Spec {
  line?: string[];
  block?: Array<[string, string]>;
  /** Triple-quoted strings that may span lines. */
  triple?: string[];
  quotes: string;
  keywords: Set<string>;
  constants: Set<string>;
  /** Keywords compared in lower case (SQL). */
  caseless?: boolean;
  /** `#` starts a comment only at a word boundary (shell). */
  hashAtBoundary?: boolean;
  /** `$name` and `${…}` are variables (shell, PHP). */
  dollarVars?: boolean;
  /** A string or word followed by `:` is a key (JSON, YAML). */
  keys?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum
  export extends finally for from function get if implements import in infer instanceof interface is keyof let
  module namespace new of private protected public readonly return satisfies set static super switch this throw
  try type typeof var void while with yield`);
const C_KEYWORDS = words(`
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register return short signed sizeof static struct switch typedef union unsigned void volatile while class
  namespace template typename public private protected virtual override final new delete this throw try catch
  using operator friend constexpr nullptr bool include define ifdef ifndef endif pragma`);
const JAVA_KEYWORDS = words(`
  abstract assert boolean break byte case catch char class const continue default do double else enum extends
  final finally float for goto if implements import instanceof int interface long native new package private
  protected public return short static strictfp super switch synchronized this throw throws transient try void
  volatile while var record sealed permits yield val fun when object companion data suspend override open
  internal lateinit`);
const GO_KEYWORDS = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface map package
  range return select struct switch type var`);
const RUST_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut
  pub ref return self Self static struct super trait type unsafe use where while`);
const PY_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in
  is lambda nonlocal not or pass raise return try while with yield match case`);
const SH_KEYWORDS = words(`
  if then else elif fi for while until do done case esac in function return local export readonly declare unset
  set source alias exit break continue`);
const SQL_KEYWORDS = words(`
  select from where and or not insert into values update set delete create table index view drop alter add
  column primary key foreign references join left right inner outer full on as group by order having limit
  offset union all distinct case when then else end is null in exists between like returning with begin commit
  rollback grant revoke function returns language replace if default unique constraint check cascade`);
const CSS_KEYWORDS = words(`important media import supports keyframes font-face`);

const C_CONSTANTS = words(`true false null undefined NaN Infinity nil None True False`);

const FAMILIES: Array<[string[], Spec]> = [
  [
    ["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs", "mts", "cts"],
    { line: ["//"], block: [["/*", "*/"]], quotes: `'"\``, keywords: JS_KEYWORDS, constants: C_CONSTANTS },
  ],
  [
    ["c", "h", "cpp", "cc", "cxx", "hpp", "c++", "cs", "csharp", "objc", "swift", "dart", "php", "scala"],
    { line: ["//"], block: [["/*", "*/"]], quotes: `'"`, keywords: C_KEYWORDS, constants: C_CONSTANTS, dollarVars: true },
  ],
  [
    ["java", "kotlin", "kt", "kts", "groovy", "gradle"],
    { line: ["//"], block: [["/*", "*/"]], quotes: `'"`, keywords: JAVA_KEYWORDS, constants: C_CONSTANTS },
  ],
  [["go", "golang"], { line: ["//"], block: [["/*", "*/"]], quotes: `'"\``, keywords: GO_KEYWORDS, constants: C_CONSTANTS }],
  [["rs", "rust"], { line: ["//"], block: [["/*", "*/"]], quotes: `"`, keywords: RUST_KEYWORDS, constants: C_CONSTANTS }],
  [
    ["py", "python", "python3", "pyi"],
    { line: ["#"], triple: [`"""`, `'''`], quotes: `'"`, keywords: PY_KEYWORDS, constants: C_CONSTANTS },
  ],
  [
    ["sh", "bash", "zsh", "shell", "console", "shellscript", "fish", "ps1", "powershell", "dockerfile", "makefile", "make"],
    { line: ["#"], quotes: `'"`, keywords: SH_KEYWORDS, constants: words("true false"), hashAtBoundary: true, dollarVars: true },
  ],
  [["json", "jsonc", "json5"], { line: ["//"], quotes: `"`, keywords: words(""), constants: words("true false null"), keys: true }],
  [["yaml", "yml", "toml", "ini", "env"], { line: ["#"], quotes: `'"`, keywords: words(""), constants: words("true false null yes no on off"), keys: true, hashAtBoundary: true }],
  [["css", "scss", "sass", "less"], { line: ["//"], block: [["/*", "*/"]], quotes: `'"`, keywords: CSS_KEYWORDS, constants: words("") }],
  [["sql", "psql", "pgsql", "postgres", "mysql", "sqlite"], { line: ["--"], block: [["/*", "*/"]], quotes: `'`, keywords: SQL_KEYWORDS, constants: words("true false null"), caseless: true }],
  [["lua"], { line: ["--"], quotes: `'"`, keywords: words("and break do else elseif end for function goto if in local not or repeat return then until while"), constants: words("true false nil") }],
  [["rb", "ruby"], { line: ["#"], quotes: `'"`, keywords: words("alias and begin break case class def do else elsif end ensure for if in module next not or redo rescue retry return self super then unless until when while yield require attr_accessor"), constants: words("true false nil") }],
];

const SPECS = new Map<string, Spec>();
for (const [names, spec] of FAMILIES) for (const name of names) SPECS.set(name, spec);

const MARKUP = new Set(["html", "htm", "xml", "svg", "vue", "svelte", "jsx-html", "xhtml", "astro"]);

/** Whether a fence's language is one this file colours (anything else is shown plain). */
export function knownLanguage(lang: string): boolean {
  const l = lang.toLowerCase();
  return SPECS.has(l) || MARKUP.has(l) || l === "diff" || l === "patch";
}

const paint = (style: string, text: string) => (text ? `${style}${text}${OFF}` : "");

/**
 * One line of code, coloured. `state` is what the line before left open; the
 * returned state is what this one leaves open for the next.
 */
export function highlightLine(line: string, lang: string, state: HighlightState = {}): { text: string; state: HighlightState } {
  const l = lang.toLowerCase();
  if (l === "diff" || l === "patch") return { text: diffLine(line), state: {} };
  if (MARKUP.has(l)) return markupLine(line, state);
  const spec = SPECS.get(l);
  if (!spec) return { text: line, state: {} };
  return codeLine(line, spec, state);
}

function diffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return paint("\x1b[1m", line);
  if (line.startsWith("+")) return paint(GREEN, line);
  if (line.startsWith("-")) return paint(RED, line);
  if (line.startsWith("@@")) return paint(CYAN, line);
  return line;
}

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUM = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/;

function codeLine(line: string, spec: Spec, state: HighlightState): { text: string; state: HighlightState } {
  let out = "";
  let i = 0;
  let open = state.open;

  if (open) {
    const end = line.indexOf(open.close);
    const style = open.kind === "comment" ? COMMENT : STRING;
    if (end === -1) return { text: paint(style, line), state: { open } };
    out += paint(style, line.slice(0, end + open.close.length));
    i = end + open.close.length;
    open = undefined;
  }

  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i]!;
    const prev = i > 0 ? line[i - 1]! : " ";

    const block = spec.block?.find(([o]) => rest.startsWith(o));
    if (block) {
      const end = line.indexOf(block[1], i + block[0].length);
      if (end === -1) {
        out += paint(COMMENT, rest);
        return { text: out, state: { open: { close: block[1], kind: "comment" } } };
      }
      out += paint(COMMENT, line.slice(i, end + block[1].length));
      i = end + block[1].length;
      continue;
    }

    const lineComment = spec.line?.find((c) => rest.startsWith(c));
    if (lineComment && (!spec.hashAtBoundary || lineComment !== "#" || /\s/.test(prev) || i === 0)) {
      out += paint(COMMENT, rest);
      break;
    }

    const triple = spec.triple?.find((t) => rest.startsWith(t));
    if (triple) {
      const end = line.indexOf(triple, i + 3);
      if (end === -1) {
        out += paint(STRING, rest);
        return { text: out, state: { open: { close: triple, kind: "string" } } };
      }
      out += paint(STRING, line.slice(i, end + 3));
      i = end + 3;
      continue;
    }

    if (spec.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const str = line.slice(i, Math.min(line.length, j + 1));
      const after = line.slice(j + 1);
      const isKey = spec.keys && /^\s*:/.test(after);
      out += paint(isKey ? PROPERTY : STRING, str);
      i = j + 1;
      continue;
    }

    if (spec.dollarVars && ch === "$") {
      const m = /^\$(?:\{[^}]*\}|[A-Za-z_][\w]*|[0-9@#?$!*-])/.exec(rest);
      if (m) {
        out += paint(VARIABLE, m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (/\d/.test(ch) && !/[\w$]/.test(prev)) {
      const m = NUM.exec(rest);
      if (m) {
        out += paint(NUMBER, m[0]);
        i += m[0].length;
        continue;
      }
    }

    const ident = IDENT.exec(rest);
    if (ident && !/[\w$]/.test(prev)) {
      const word = ident[0];
      const key = spec.caseless ? word.toLowerCase() : word;
      const after = line.slice(i + word.length);
      if (spec.keys && /^\s*:(?!:)/.test(after) && /^\s*$/.test(line.slice(0, i).replace(/^[\s-]*/, ""))) {
        out += paint(PROPERTY, word);
      } else if (spec.keywords.has(key)) {
        out += paint(KEYWORD, word);
      } else if (spec.constants.has(word)) {
        out += paint(CONSTANT, word);
      } else if (/^\s*\(/.test(after) && !spec.keys) {
        out += paint(FUNC, word);
      } else {
        out += word;
      }
      i += word.length;
      continue;
    }

    out += ch;
    i++;
  }
  return { text: out, state: open ? { open } : {} };
}

/** HTML and XML: comments, tags, attribute names and their values. */
function markupLine(line: string, state: HighlightState): { text: string; state: HighlightState } {
  let out = "";
  let i = 0;
  if (state.open) {
    const end = line.indexOf("-->");
    if (end === -1) return { text: paint(COMMENT, line), state };
    out += paint(COMMENT, line.slice(0, end + 3));
    i = end + 3;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith("<!--")) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        out += paint(COMMENT, rest);
        return { text: out, state: { open: { close: "-->", kind: "comment" } } };
      }
      out += paint(COMMENT, line.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    const tag = /^<\/?[A-Za-z][\w:.-]*/.exec(rest);
    if (tag) {
      out += paint(KEYWORD, tag[0]);
      i += tag[0].length;
      continue;
    }
    const attr = /^([A-Za-z_:@][\w:.-]*)(=)("[^"]*"|'[^']*')?/.exec(rest);
    if (attr && /\s/.test(line[i - 1] ?? "")) {
      out += paint(PROPERTY, attr[1]!) + attr[2] + (attr[3] ? paint(STRING, attr[3]) : "");
      i += attr[0].length;
      continue;
    }
    out += line[i];
    i++;
  }
  return { text: out, state: {} };
}
