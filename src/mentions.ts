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
import type { ImageAttachment } from "./client.ts";

/** Characters that end a mention but are not part of a path. */
const TRAILING = /[),;:]+$/;

/** Total characters of attached file content in one message. */
export const MAX_MENTION_CHARS = 120_000;

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
  if (mentions.length === 0) return { text, attached: [], images: [] };

  const blocks: string[] = [];
  const attached: string[] = [];
  const images: ImageAttachment[] = [];
  let used = 0;

  for (const path of mentions) {
    if (used >= limit) break;
    let body: string;
    try {
      safeResolve(root, path); // same confinement the tools use, not a copy of it
      // An image collected here rather than described: `read_file` hands the
      // bytes to `attach` and returns the sentence that goes with them, which
      // is exactly the shape a user message needs.
      body = TOOLS.read_file({ root, attach: (image) => images.push(image) }, { path });
    } catch {
      continue; // missing, a directory, an oversized image, or outside the workspace
    }
    const room = limit - used;
    const clipped =
      body.length > room ? `${body.slice(0, room)}\n… [attachment truncated — read the rest with read_file]` : body;
    used += clipped.length;
    attached.push(path);
    blocks.push(`--- ${path} ---\n${clipped}`);
  }

  if (blocks.length === 0) return { text, attached: [], images: [] };
  return {
    text:
      `${text}\n\n` +
      "# Files the user referenced\n" +
      "Their contents are below, already read for you — do not call read_file on them again.\n\n" +
      blocks.join("\n\n"),
    attached,
    images,
  };
}
