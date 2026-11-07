/**
 * How long a line or a place stayed on screen (`sponsor/visibility.ts`), and
 * the row a booked line is drawn in where its printed address is the only way
 * to open it (`sponsorRow` with the address required). Both decide what an
 * advertiser is told: an impression counts after ten unbroken seconds, and a
 * click rate is read against the lines that could be clicked.
 */
import { describe, expect, it } from "vitest";
import { VisibilityClock, placeKey } from "../src/sponsor/visibility.ts";
import { MIN_LINKED_COPY_COLS, joinSponsorRow, sponsorRow } from "../src/sponsor/render.ts";
import { visibleLength } from "../src/banner.ts";

describe("the clock", () => {
  it("measures a stretch still on screen up to now", () => {
    const clock = new VisibilityClock();
    clock.observe(["a"], 1_000);
    expect(clock.longest("a", 13_500)).toBe(12_500);
  });

  it("ends a stretch when a frame stops drawing it, and keeps the longest one", () => {
    const clock = new VisibilityClock();
    clock.observe(["a"], 0);
    clock.observe([], 6_000);
    clock.observe(["a"], 7_000);
    clock.observe([], 15_000);
    clock.observe(["a"], 16_000);
    // 6 s, then 8 s, then 2 s and still going: never added up.
    expect(clock.longest("a", 18_000)).toBe(8_000);
  });

  it("does not count time before `from`", () => {
    const clock = new VisibilityClock();
    clock.observe([placeKey("top_bar")], 0);
    expect(clock.longest(placeKey("top_bar"), 20_000, 5_000)).toBe(15_000);
    expect(clock.longest(placeKey("top_bar"), 20_000, 25_000)).toBe(0);
  });

  it("knows nothing about a key it never saw, and forgets everything on reset", () => {
    const clock = new VisibilityClock();
    expect(clock.longest("never", 10_000)).toBe(0);
    clock.observe(["a"], 0);
    clock.reset();
    expect(clock.longest("a", 10_000)).toBe(0);
  });

  it("keeps a line and its place apart", () => {
    const clock = new VisibilityClock();
    clock.observe(["direct:1:top_bar", placeKey("top_bar")], 0);
    // The booked line is replaced; the place stays filled.
    clock.observe([placeKey("top_bar")], 4_000);
    expect(clock.longest("direct:1:top_bar", 20_000)).toBe(4_000);
    expect(clock.longest(placeKey("top_bar"), 20_000)).toBe(20_000);
  });
});

describe("a booked line whose address is the only way to open it", () => {
  const LINE = "Rehearsal GmbH: deploy previews for every pull request today";
  const ADDRESS = "app.clixad.io/a/k3p9xq";

  it("keeps the address and cuts the copy, in one row of the terminal's width", () => {
    const row = sponsorRow(LINE, 80, "network", ADDRESS, true)!;
    expect(row.link).toBe(ADDRESS);
    expect(row.body.endsWith("…")).toBe(true);
    expect(visibleLength(joinSponsorRow(row))).toBeLessThanOrEqual(80);
  });

  it("is the line as it always was when everything fits", () => {
    const row = sponsorRow(LINE, 160, "network", ADDRESS, true)!;
    expect(row).toMatchObject({ body: LINE, link: ADDRESS });
  });

  it("drops the address rather than leave less copy than a brand and a word", () => {
    // The narrowest an advertisement is drawn at, where the address would leave too little.
    const row = sponsorRow(LINE, 38, "network", ADDRESS, true)!;
    expect(row.link).toBeNull();
    expect(MIN_LINKED_COPY_COLS).toBe(12);
  });

  it("is not how an affiliate line is drawn: its address goes before its offer does", () => {
    const row = sponsorRow(LINE, 80, "network", ADDRESS)!;
    expect(row.link).toBeNull();
  });
});
