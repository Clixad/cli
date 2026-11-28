/**
 * The three places this CLI shows an advertisement.
 *
 *  - `top_bar`      the line above the input box, the sponsored line as it has
 *                   always been, with our own tip in it when nothing else is.
 *  - `sidebar_card` two rows to the right of the working line, on a terminal
 *                   wide enough that the working line keeps its room.
 *  - `status_bar`   a row of its own under the status line.
 *
 * All three are drawn in the bottom re-rendered region, only while a model call
 * runs, and never beside or inside anything the model wrote.
 *
 * A copy of the gateway's own list, deliberately: this program is bundled for
 * npm and may import nothing but npm packages. The wire
 * names are the contract between the two, and the gateway refuses one it does
 * not know rather than guessing at it.
 */
export const AD_FORMATS = ["top_bar", "sidebar_card", "status_bar"] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

/** The two places beyond the top bar, which have no house content. */
export const EXTRA_AD_FORMATS = ["sidebar_card", "status_bar"] as const;
export type ExtraAdFormat = (typeof EXTRA_AD_FORMATS)[number];

export function isAdFormat(value: unknown): value is AdFormat {
  return typeof value === "string" && (AD_FORMATS as readonly string[]).includes(value);
}
