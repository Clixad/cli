/**
 * `@path` references, expanded into the message actually sent.
 *
 * The completion menu has always offered files for `@`, but picking one only
 * ever inserted the *path* — so the model read a filename, called `read_file`,
 * and the user paid for a round-trip to fetch something they had already
 * pointed at. On a metered product that is not a rough edge, it is the bill.
 *
 * The typed line is what stays on screen and in the shell history; the
 * expansion goes only into the model's copy, appended once, at submit time.
 * Attaching at submit rather than per turn is deliberate: the file the user
 * meant is the one that existed when they asked, and re-reading it later would
 * quietly change a message they can still see above them.
 *
 * Contents come back through `TOOLS.read_file`, so an attachment is byte for
 * byte what the model would have got by reading it itself — same numbering,
 * same caps, same workspace confinement — and there is no second formatter to
 * drift.
 */
import { TOOLS, safeResolve } from "./tools.ts";
import { jsonBytes } from "./room.ts";
import type { ImageAttachment } from "./client.ts";

/** Characters that end a mention but are not part of a path. */
const TRAILING = /[),;:]+$/;

/**
 * Total JSON bytes of attached file content in one message, on a model whose
 * window takes it; the REPL passes less for a smaller one (`mentionRoom`).
 */
export const MAX_MENTION_CHARS = 120_000;

/**
 * Where the attached files start in a message, after what was typed. A
 * resumed transcript shows the message up to here, as it was on screen.
 */
export const MENTIONS_HEADING = "\n\n# Files the user referenced\n";

/**
 * The `@path` tokens in `text`, in order, without duplicates.
 *
 * `@` counts at the start of a word only, which is the same rule the completion
 * menu uses (`suggest.ts`), so an email address mid-sentence is not a file.
 */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = match[1]!.replace(TRAILING, "");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export interface ExpandResult {
  /** What to send to the model: the typed text, plus any attachments. */
  text: string;
  /** Paths that were attached, for the notice in the TUI. */
  attached: string[];
  /**
   * Attachments that stop before the end of their file because the rest did
   * not fit the message: which lines went in, so the TUI can say so. The model
   * is told the same in the attachment, with where to read on.
   */
  partial: { path: string; from: number; to: number; total: number }[];
  /**
   * Images among them, which cannot be appended as text.
   *
   * They travel as their own content parts on the same user message, so
   * `@screenshot.png` means the model *sees* the screenshot rather than reading
   * a sentence about a file it cannot open.
   */
  images: ImageAttachment[];
}

/**
 * Append the contents of every `@path` that resolves to a readable workspace
 * file. A mention that does not — a typo, a directory, something outside the
 * workspace — is left exactly as typed: the model can still act on the name,
 * and refusing the whole message over one bad token would be worse than
 * ignoring it.
 */
export function expandMentions(text: string, root: string, limit = MAX_MENTION_CHARS): ExpandResult {
  const mentions = findMentions(text);
  if (mentions.length === 0) return { text, attached: [], partial: [], images: [] };

  const blocks: string[] = [];
  const attached: string[] = [];
  const partial: ExpandResult["partial"] = [];
  const images: ImageAttachment[] = [];
  let used = 0;

  for (const path of mentions) {
    if (used >= limit) break;
    let body: string;
    try {
      safeResolve(root, path); // same confinement the tools use, not a copy of it
      // An image collected here rather than described: `read_file` hands the
      // bytes to `attach` and returns the sentence that goes with them, which
      // is exactly the shape a user message needs. A text file is read up to
      // the room left, at a whole line, with where to read on said at its end.
      body = TOOLS.read_file({ root, room: limit - used, attach: (image) => images.push(image) }, { path });
    } catch {
      continue; // missing, a directory, an oversized image, or outside the workspace
    }
    const room = limit - used;
    const clipped =
      jsonBytes(body) > room ? `${body.slice(0, room)}\n… [attachment truncated — read the rest with read_file]` : body;
    used += jsonBytes(clipped);
    attached.push(path);
    const stops = /\n… showing lines (\d+)-(\d+) of (\d+)[.:]/.exec(clipped.slice(-300));
    if (stops) partial.push({ path, from: Number(stops[1]), to: Number(stops[2]), total: Number(stops[3]) });
    blocks.push(`--- ${path} ---\n${clipped}`);
  }

  if (blocks.length === 0) return { text, attached: [], partial: [], images: [] };
  return {
    text:
      `${text}${MENTIONS_HEADING}` +
      "Their contents are below, already read for you — do not call read_file on them again, " +
      "except to read on where one says it stops.\n\n" +
      blocks.join("\n\n"),
    attached,
    partial,
    images,
  };
}
