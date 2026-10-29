/**
 * The sponsored status line: what it may say, when it may appear, and the two
 * ways it is switched off.
 *
 * The four things asserted here are the four ways this feature could stop being
 * acceptable rather than merely broken — it renders into a log, it wraps and
 * shoves the input box off the screen, it ignores the off switch, or it repeats
 * itself until it reads as nagging. A rendering bug is a bug; any of those is
 * the product behaving like spam.
 *
 * The fifth is the one no rendering test can see: a credit figure typed into the
 * inventory by hand. The CLI cannot import the pricing engine (the published
 * bundle marks every bare specifier external, so only npm packages resolve), so
 * nothing *stops* someone writing `40,000` into a line — it would look right,
 * ship, and slowly stop being true. The defence is to read the source and
 * refuse the literal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { visibleLength } from "../src/banner.ts";
import { AD_MARK, AD_TEXT, MANGO, MANGO_BRIGHT, MODE_STYLE, SLATE } from "../src/tui/views.tsx";
import { HOUSE_LINES, LINE_BUDGET } from "../src/sponsor/lines.ts";
import {
  adtentionSource,
  houseSource,
  sponsorSource,
  SPONSOR_PROVIDERS,
} from "../src/sponsor/provider.ts";
import {
  AD_FULL_PREFIX_MIN_COLS,
  AD_LABEL,
  AD_MIN_COLS,
  adColorEnabled,
  adFitsWidth,
  joinSponsorRow,
  sponsorEnabled,
  sponsorRow,
  sponsorText,
  SPONSOR_MARKER,
  SPONSOR_SIGIL,
} from "../src/sponsor/render.ts";
import { createSponsorSlot, sponsorLineText } from "../src/sponsor/network.ts";
import { createTally, recordImpression, tallyReport } from "../src/sponsor/counter.ts";
import type { Sponsor } from "@adtention/sdk";
import type { ImpressionReport } from "../src/client.ts";

/** One impression's receipt, as the SDK reports it. */
const IMPRESSION: ImpressionReport = {
  impressionId: "imp_0001",
  adId: "c_acme",
  billable: true,
  fromCache: false,
  credit: 0.0002,
};

/** Both figures in hand, i.e. a fully-fetched session. */
const FACTS = {
  grant: "~51,000 credits on completion (median)",
  adsPerTask: "~18 ads/task on completion (median)",
};

/**
 * The widest either figure realistically gets, for the budget check.
 *
 * Deliberately roomier than what the gateway serves today — a three-digit
 * ads/task on a frontier model, a seven-figure grant — because the point of the
 * budget is that a line still fits when the numbers grow, not that it fits the
 * numbers we happen to have this quarter.
 */
const WIDEST_FACTS = {
  grant: "~3,000,000 credits on completion (median)",
  adsPerTask: "~180 ads/task on completion (median)",
};

describe("the gate", () => {
  const on = { isTTY: true, env: {} };

  it("renders on an interactive terminal by default", () => {
    expect(sponsorEnabled(on)).toBe(true);
  });

  it("renders nothing when stdout is not a TTY", () => {
    // Piped, redirected to a file, or captured by a parent process. This is the
    // case that would otherwise put marketing into somebody's build log.
    expect(sponsorEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(sponsorEnabled({ isTTY: undefined, env: {} })).toBe(false);
  });

  it("stays off when piped even if the env var forces it on", () => {
    // `CLIXAD_SPONSOR=1` exported into a shell months ago must not be the reason
    // a line lands in a log file. The TTY check is the one thing not overridable.
    expect(sponsorEnabled({ isTTY: false, env: { CLIXAD_SPONSOR: "1" } })).toBe(false);
  });

  it("honours NO_COLOR, CI and TERM=dumb", () => {
    expect(sponsorEnabled({ ...on, env: { NO_COLOR: "1" } })).toBe(false);
    expect(sponsorEnabled({ ...on, env: { CI: "true" } })).toBe(false);
    expect(sponsorEnabled({ ...on, env: { TERM: "dumb" } })).toBe(false);
    // Set-but-empty is the documented "not set" for NO_COLOR.
    expect(sponsorEnabled({ ...on, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("honours the config field, and the env var overrides it either way", () => {
    expect(sponsorEnabled({ ...on, configEnabled: false })).toBe(false);
    expect(sponsorEnabled({ ...on, configEnabled: true })).toBe(true);
    // Absent means the default, which is on.
    expect(sponsorEnabled({ ...on, configEnabled: undefined })).toBe(true);

    for (const off of ["0", "false", "off", "no", "OFF"]) {
      expect(sponsorEnabled({ ...on, env: { CLIXAD_SPONSOR: off } }), off).toBe(false);
    }
    // The env var turns it back on for one run without editing the file.
    expect(sponsorEnabled({ ...on, configEnabled: false, env: { CLIXAD_SPONSOR: "1" } })).toBe(true);
    // …and beats NO_COLOR, since it is the more specific request.
    expect(sponsorEnabled({ ...on, env: { CLIXAD_SPONSOR: "1", NO_COLOR: "1" } })).toBe(true);
  });
});

const ORIGINS = ["house", "network"] as const;

describe("width", () => {
  const long = HOUSE_LINES.find((l) => l.text.length > 60)!.text;

  it("never exceeds the terminal width, and never wraps", () => {
    for (const origin of ORIGINS) {
      for (const cols of [24, 40, 60, 80, 120, 200]) {
        const out = sponsorText(long, cols, origin);
        if (out === null) continue;
        expect(visibleLength(out), `${origin} at cols=${cols}`).toBeLessThanOrEqual(cols);
        expect(out).not.toContain("\n");
      }
    }
  });

  it("truncates with an ellipsis rather than cutting silently", () => {
    const out = sponsorText(long, 44, "house")!;
    expect(visibleLength(out)).toBeLessThanOrEqual(44);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain(SPONSOR_MARKER);
  });

  it("says nothing at all when the terminal is too narrow to say anything", () => {
    // A marker and an ellipsis is not content; it is a wasted row.
    expect(sponsorText(long, 20, "house")).toBeNull();
  });

  it("leaves a line that already fits alone", () => {
    expect(sponsorText("/help lists every slash command", 120, "house")).toBe(
      `  ${SPONSOR_MARKER} /help lists every slash command`,
    );
  });
});

describe("rotation", () => {
  it("never shows the same line twice in a row", () => {
    const source = houseSource();
    let prev: string | undefined;
    // Several full laps, so the wrap-around is covered too.
    for (let i = 0; i < HOUSE_LINES.length * 3 + 1; i++) {
      const pick = source.pick(i, prev, FACTS)!;
      expect(pick.id, `impression ${i}`).not.toBe(prev);
      prev = pick.id;
    }
  });

  it("is deterministic — the same counter gives the same line", () => {
    const a = houseSource();
    const b = houseSource();
    for (let i = 0; i < 30; i++) {
      expect(b.pick(i, undefined, FACTS)).toEqual(a.pick(i, undefined, FACTS));
    }
  });

  it("walks the inventory in order, one step per call", () => {
    const source = houseSource();
    const ids: string[] = [];
    let prev: string | undefined;
    for (let i = 0; i < HOUSE_LINES.length; i++) {
      const pick = source.pick(i, prev, FACTS)!;
      ids.push(pick.id);
      prev = pick.id;
    }
    expect(ids).toEqual(HOUSE_LINES.map((l) => l.id));
  });

  it("would rather show nothing than repeat the only line it has", () => {
    const single = houseSource([{ id: "only", text: "one" }]);
    expect(single.pick(0, undefined, FACTS)).toEqual({ id: "only", text: "one" });
    expect(single.pick(1, "only", FACTS)).toBeNull();
  });
});

describe("figures", () => {
  it("skips a line whose figure is not in hand rather than printing the brace", () => {
    const source = houseSource();
    // A wallet that hasn't answered yet and a catalog that hasn't either: both
    // placeholder lines are unresolvable.
    for (let i = 0; i < HOUSE_LINES.length * 2; i++) {
      const pick = source.pick(i, undefined, {});
      if (!pick) continue;
      expect(pick.text).not.toContain("{");
      expect(pick.id).not.toBe("model-cost");
      expect(pick.id).not.toBe("earn");
    }
  });

  it("carries the 'on completion' label with every figure it does show", () => {
    const source = houseSource();
    for (let i = 0; i < HOUSE_LINES.length; i++) {
      const pick = source.pick(i, undefined, FACTS)!;
      const line = HOUSE_LINES.find((l) => l.id === pick.id)!;
      if (!line.needs) continue;
      expect(pick.text, pick.id).toContain("on completion");
      // Both figures rest on the median completed offer, so both say so.
      expect(pick.text, pick.id).toContain("median");
    }
  });

  it("has no credit figure of its own anywhere in the inventory", () => {
    // The check the CLI cannot get from the type system: it may not import the
    // pricing engine, so a hand-typed number here would never be contradicted
    // by anything until it was wrong on a stranger's screen.
    const src = readFileSync(fileURLToPath(new URL("../src/sponsor/lines.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("export const HOUSE_LINES"));
    expect(body).not.toMatch(/\d{1,3}(,\d{3})+/);
    for (const line of HOUSE_LINES) {
      expect(line.text, line.id).not.toMatch(/\d{1,3}(,\d{3})+/);
    }
  });

  it("keeps every line short enough to survive an 80-column terminal", () => {
    // The *rendered* length, placeholder expansion included — the raw text is
    // not what lands on the screen, and a line that only fits before
    // substitution is a line that always arrives truncated.
    const source = houseSource();
    for (let i = 0; i < HOUSE_LINES.length; i++) {
      const pick = source.pick(i, undefined, WIDEST_FACTS)!;
      expect(visibleLength(pick.text), pick.id).toBeLessThanOrEqual(LINE_BUDGET);
      // …and that budget really is what an 80-column terminal leaves. Checked by
      // equality against the whole line rather than by looking for an ellipsis:
      // one of these lines contains a `…` of its own (`clixad -p "…"`), so
      // "contains an ellipsis" would flag it as truncated forever.
      expect(sponsorText(pick.text, 80, "house"), pick.id).toBe(`  ${SPONSOR_MARKER} ${pick.text}`);
    }
  });

  it("has unique ids", () => {
    expect(new Set(HOUSE_LINES.map((l) => l.id)).size).toBe(HOUSE_LINES.length);
  });
});

describe("provider", () => {
  it("has one local implementation and one remote one", () => {
    expect(SPONSOR_PROVIDERS).toEqual(["house", "adtention"]);
    expect(sponsorSource().provider).toBe("house");
    expect(sponsorSource("house").provider).toBe("house");
  });

  it("carries the receipt along with the line", async () => {
    // The impression rides with the line rather than being reported by whoever
    // fetched it, because only the caller knows whether it was ever painted: a
    // line that loses the race against the end of a turn is dropped, and
    // reporting it would bill an advertiser for something nobody saw.
    const source = adtentionSource(async () => ({
      id: "c_acme",
      text: "  Acme ships faster  ",
      impression: IMPRESSION,
    }));
    await expect(source.fetch()).resolves.toEqual({
      id: "c_acme",
      text: "Acme ships faster",
      impression: IMPRESSION,
    });
  });

  it("answers null for every way there is no line, without distinguishing them", async () => {
    // No inventory, no publisher configured, an older gateway, an unreachable
    // one, the network itself refusing: all the same event to a caller, which is
    // "keep showing the house line". A caller that could tell them apart would
    // have nothing to do with the difference.
    await expect(adtentionSource(async () => null).fetch()).resolves.toBeNull();
    // A blank line would render as the marker and nothing else, which reads as a
    // bug in our own TUI rather than as an empty ad slot.
    await expect(
      adtentionSource(async () => ({ id: "c_x", text: "   ", impression: IMPRESSION })).fetch(),
    ).resolves.toBeNull();
  });

  it("never rejects, however the fetcher fails", async () => {
    // Stronger than "should not". The caller starts this with `void` and does
    // not await it, so a rejection is an unhandled one — a Node process exiting
    // over a status line nobody asked for. It matters more since the fetcher
    // became an ad network's SDK rather than one of our own routes.
    await expect(
      adtentionSource(async () => {
        throw new Error("network down");
      }).fetch(),
    ).resolves.toBeNull();
    // And a fetcher that throws *synchronously* never returns the promise a
    // `.catch()` would have been attached to, which is why this is a try/catch.
    await expect(
      adtentionSource((() => {
        throw new Error("thrown before the promise");
      }) as unknown as () => Promise<null>).fetch(),
    ).resolves.toBeNull();
  });
});

describe("serving from the CLI", () => {
  // The serve moved here because the network's SDK is built for client-side
  // serving. What did not move is the money: the gateway decides what an impression is worth and
  // whether to credit it, so nothing in this file has to be trusted.

  it("truncates ad text rather than passing on whatever arrives", () => {
    const long = "x".repeat(500);
    expect(sponsorLineText({ text: long } as Sponsor)!.length).toBe(200);
    expect(sponsorLineText({ text: "  Acme  " } as Sponsor)).toBe("Acme");
    expect(sponsorLineText({ text: "   " } as Sponsor)).toBeUndefined();
    expect(sponsorLineText({} as Sponsor)).toBeUndefined();
  });

  it("locks the slot to serving, so an install can never mint an earning account", () => {
    // `serveOnly` is what stops a fleet of CLIs self-registering publisher
    // accounts nobody can log into. The SDK enforces it at construction, so this
    // asserts the wiring reaches it — and that a slot is built at all, since
    // construction throws without a publisher id.
    const slot = createSponsorSlot({ publisherId: "pub_1", category: "devops" });
    expect(typeof slot.serve).toBe("function");
  });

  it("drops a category it does not recognise rather than serving with it", () => {
    // An older CLI against a gateway that has learned a seventh category. An
    // unknown value would be rejected per serve and look exactly like empty
    // inventory; dropping it falls back to `general`, which always fills.
    expect(() => createSponsorSlot({ publisherId: "pub_1", category: "quantum" })).not.toThrow();
  });
});

describe("counting", () => {
  it("counts in aggregate and records nothing per impression", () => {
    const tally = createTally();
    recordImpression(tally, "help");
    recordImpression(tally, "earn");
    recordImpression(tally, "help");

    const report = tallyReport(tally);
    expect(report).toEqual({ shown: 3, lines: { help: 2, earn: 1 } });
    // No timestamps, no ids, no ordering — nothing that reconstructs a session.
    expect(Object.keys(report).sort()).toEqual(["lines", "shown"]);
    expect(JSON.stringify(report)).not.toMatch(/\d{13}/);
  });
});

/**
 * The slot is one row, and `chromeHeight` in `app.tsx` counts it as one row.
 *
 * The house inventory is ASCII, so `.length` happened to be right for it — but
 * a served line is written by somebody else. Measured in code units, a line of
 * Chinese came back at 141 columns for an 80-column terminal and quietly became
 * two rows, which moves the input box for the length of every model call.
 */
describe("sponsorText measures in columns", () => {
  const CJK = "这是一条中文的赞助信息用来测试宽度".repeat(4);
  const EMOJI = "✅ ship it ❌ or don't ⚠️ either way ".repeat(4);

  for (const [name, line] of [["chinese", CJK], ["emoji", EMOJI]] as const) {
    for (const cols of [120, 80, 60, 40, 30]) {
      it(`${name} fits ${cols} columns`, () => {
        const out = sponsorText(line, cols, "network");
        if (out === null) return; // too narrow to say anything: also one row, or none
        expect(visibleLength(out)).toBeLessThanOrEqual(cols);
        expect(out).not.toContain("\n");
      });
    }
  }

  it("never splits a double-width character in half", () => {
    const out = sponsorText(CJK, 41, "network")!;
    expect(visibleLength(out)).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
  });
});

/**
 * The disclosure.
 *
 * An advertisement has to be recognisable as one *before* it is read, which is
 * why the mark leads the copy rather than trailing it, and why it is the last
 * thing on the row that may be given up. Everything here is about the two ways
 * that could quietly stop being true: the mark drifting onto our own content
 * (which makes it meaningless), and the mark being cut off a narrow terminal
 * (which makes it absent exactly where the row is hardest to read).
 */
describe("marking an advertisement", () => {
  const AD = "Globex: plan sprints in 5 min";
  const MARK = `${AD_LABEL} · `;

  it("marks a network line, ahead of the copy", () => {
    const row = sponsorRow(AD, 80, "network")!;
    expect(row.label).toBe(MARK);
    const line = joinSponsorRow(row);
    expect(line).toBe(`  ${SPONSOR_MARKER} ${MARK}${AD}`);
    // Ahead of it: the mark ends before the copy begins.
    expect(line.indexOf(AD_LABEL)).toBeLessThan(line.indexOf(AD));
  });

  it("does not mark our own content, whatever it says", () => {
    // Including a house line written to read like one — the mark follows the
    // source, never the text.
    for (const text of ["/model lists cheapest-turn-first", "Globex: plan sprints in 5 min"]) {
      const row = sponsorRow(text, 80, "house")!;
      expect(row.label).toBeNull();
      expect(joinSponsorRow(row)).not.toContain(AD_LABEL);
    }
  });

  it("charges the mark's columns to the copy, never to the row's height", () => {
    // Same text, same width: the advertisement gets exactly the mark's width
    // less of it, and both rows stay one row.
    const cols = 52;
    const house = sponsorRow(AD, cols, "house")!;
    const network = sponsorRow(AD, cols, "network")!;
    expect(visibleLength(joinSponsorRow(house))).toBeLessThanOrEqual(cols);
    expect(visibleLength(joinSponsorRow(network))).toBeLessThanOrEqual(cols);
    expect(visibleLength(house.marker)).toBe(visibleLength(network.marker));
    expect(visibleLength(network.label!)).toBe(5);
  });

  it("cuts the copy rather than the mark, at every width", () => {
    for (let cols = 20; cols <= 120; cols++) {
      const row = sponsorRow("a".repeat(300), cols, "network");
      if (!row) continue;
      // The mark survives whole, every time — behind the full prefix where
      // there is room for our name, and behind the sigil alone where there is
      // not. What is never cut is the mark itself.
      expect(row.label, `cols=${cols}`).toBe(MARK);
      expect(joinSponsorRow(row), `cols=${cols}`).toContain(`${SPONSOR_SIGIL} `);
      expect(joinSponsorRow(row), `cols=${cols}`).toContain(MARK);
      expect(visibleLength(joinSponsorRow(row)), `cols=${cols}`).toBeLessThanOrEqual(cols);
    }
  });

  it("drops the whole row before it would drop the mark", () => {
    // The alternative — keeping the copy and losing the disclosure — is the one
    // outcome that is worse than showing nothing.
    let sawDropped = false;
    for (let cols = 1; cols <= 40; cols++) {
      const row = sponsorRow(AD, cols, "network");
      if (row === null) {
        sawDropped = true;
        continue;
      }
      expect(row.label, `cols=${cols}`).not.toBeNull();
    }
    expect(sawDropped).toBe(true); // there really are widths where it is dropped
  });

  it("gives up an advertisement long before it gives up one of our own lines", () => {
    // The asymmetry is the design, and it is not a rounding error: our own
    // content costs nobody anything when it is cut short, and an advertisement
    // that nobody can read is an impression an advertiser paid for.
    const widths = Array.from({ length: 80 }, (_, i) => i + 10);
    const adFrom = widths.find((c) => sponsorRow(AD, c, "network") !== null)!;
    const houseFrom = widths.find((c) => sponsorRow(AD, c, "house") !== null)!;
    expect(adFrom).toBe(AD_MIN_COLS);
    expect(adFrom).toBeGreaterThan(houseFrom);
  });

  it("keeps the mark when the colour is refused", () => {
    // A mark is information, not decoration. Under NO_COLOR the row still says
    // it is an advertisement; it just says it in the same dim as the rest.
    expect(adColorEnabled({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(sponsorRow(AD, 80, "network")!.label).toBe(MARK);
  });
});

/**
 * Whether the accent may be painted at all.
 *
 * `colorEnabled` does almost all of it — see `color.ts`, which is where the
 * rule was written after the audit found the one-shot commands emitting ANSI
 * into pipes. `CI` is the one clause added on top, and the asymmetry is
 * deliberate: coloured diagnostics in a build log are useful, a coloured
 * advertisement in one is not.
 */
describe("adColorEnabled", () => {
  it("paints an interactive terminal", () => {
    expect(adColorEnabled({ isTTY: true, env: {} })).toBe(true);
  });

  it("refuses anything that is not a terminal", () => {
    expect(adColorEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(adColorEnabled({ isTTY: undefined, env: {} })).toBe(false);
  });

  it("refuses NO_COLOR and TERM=dumb", () => {
    expect(adColorEnabled({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(adColorEnabled({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });

  it("refuses CI even where the diagnostics would still be coloured", () => {
    // Reachable only through `CLIXAD_SPONSOR=1`, which overrides the preference
    // half of `sponsorEnabled` — the line is otherwise already silent in CI.
    expect(adColorEnabled({ isTTY: true, env: { CI: "true" } })).toBe(false);
    expect(adColorEnabled({ isTTY: true, env: { CI: "true", FORCE_COLOR: "1" } })).toBe(false);
  });

  it("lets FORCE_COLOR decide outside CI, in both directions", () => {
    expect(adColorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(adColorEnabled({ isTTY: true, env: { FORCE_COLOR: "0" } })).toBe(false);
  });
});

/**
 * The accent is one colour for every advertiser, and it is quieter than our own
 * chrome. Pinned as a **luminance ordering** rather than as three hex strings,
 * so the palette can be retuned without the intent being lost.
 */
describe("the ad accent", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("puts the mark below the copy, and the copy no higher than our own chrome", () => {
    expect(luminance(AD_MARK)).toBeLessThan(luminance(AD_TEXT));
    expect(luminance(AD_TEXT)).toBeLessThanOrEqual(luminance(SLATE));
  });

  it("keeps the mark readable anyway", () => {
    // Taken literally, "darker than the copy, and the copy no brighter than our
    // chrome" put the mark at 2.7:1 on a dark terminal. A disclosure is allowed
    // to be quiet and is not allowed to be invisible.
    expect(contrast(AD_MARK, "#0a1430")).toBeGreaterThanOrEqual(3);
    expect(contrast(AD_TEXT, "#0a1430")).toBeGreaterThanOrEqual(4.5);
  });

  it("is not one of the colours that already mean something else", () => {
    for (const taken of [MANGO, MANGO_BRIGHT, SLATE, MODE_STYLE.plan.color, MODE_STYLE.acceptEdits.color, MODE_STYLE.auto.color]) {
      expect(AD_TEXT).not.toBe(taken);
      expect(AD_MARK).not.toBe(taken);
    }
  });
});

/**
 * How narrow a terminal may be before an advertisement stops being worth one.
 *
 * The complaint that produced this: at 40 columns the old layout left
 * `Nimbus: catch the err…` — a brand and half a word, worthless to the
 * advertiser, noise to the reader, and billed as an impression all the same.
 * Two changes answer it. Our name comes off the prefix where it costs the copy
 * more than it is worth, which buys nine columns; and below a floor nothing is
 * served at all.
 *
 * Both thresholds are derived from one measured number rather than picked for
 * looking round, and this pins the derivation rather than the results — change
 * `SHORT_AD_COLS` and the thresholds move with it.
 */
describe("how narrow an advertisement may go", () => {
  const SHORT_AD = "Globex: plan sprints in 5 min"; // 29 columns, like the other sample
  const LONG_AD = "Nimbus: catch the error before your users do, free for solo devs";

  it("is derived from the width of a short ad, not from a round number", () => {
    // At each threshold, that short ad renders **whole** — which is the rule:
    // our name stays while it is free, and the floor is where the copy itself
    // would start being cut before it had said anything.
    expect(visibleLength(SHORT_AD)).toBe(29);
    for (const cols of [AD_MIN_COLS, AD_FULL_PREFIX_MIN_COLS]) {
      const row = sponsorRow(SHORT_AD, cols, "network")!;
      expect(row, `cols=${cols}`).not.toBeNull();
      expect(row.body, `cols=${cols}`).toBe(SHORT_AD); // whole, no ellipsis
      expect(visibleLength(joinSponsorRow(row))).toBe(cols);
    }
    // And the long prefix costs exactly the nine columns it is worth.
    expect(AD_FULL_PREFIX_MIN_COLS - AD_MIN_COLS).toBe(visibleLength("clixad · "));
  });

  it("fixes the case that prompted it: 40 columns now renders the copy", () => {
    expect(sponsorRow(SHORT_AD, 40, "network")!.body).toBe(SHORT_AD);
    // And the long one gets a proposition rather than a fragment.
    const long = sponsorRow(LONG_AD, 40, "network")!.body;
    expect(long).toBe("Nimbus: catch the error before…");
    expect(visibleLength(long)).toBeGreaterThan(visibleLength("Nimbus: catch the err…"));
  });

  it("keeps our name while it is free and drops it when it is not", () => {
    expect(sponsorRow(SHORT_AD, AD_FULL_PREFIX_MIN_COLS, "network")!.marker).toContain("clixad");
    expect(sponsorRow(SHORT_AD, AD_FULL_PREFIX_MIN_COLS - 1, "network")!.marker).not.toContain("clixad");
    // The mark itself survives the change; only the name goes.
    for (const cols of [AD_FULL_PREFIX_MIN_COLS, AD_FULL_PREFIX_MIN_COLS - 1, AD_MIN_COLS]) {
      const row = sponsorRow(SHORT_AD, cols, "network")!;
      expect(row.marker, `cols=${cols}`).toContain(SPONSOR_SIGIL);
      expect(row.label, `cols=${cols}`).toBe(`${AD_LABEL} · `);
    }
  });

  it("serves nothing below the floor, at any length of copy", () => {
    for (let cols = 0; cols < AD_MIN_COLS; cols++) {
      expect(adFitsWidth(cols), `cols=${cols}`).toBe(false);
      for (const text of [SHORT_AD, LONG_AD, "x"]) {
        expect(sponsorRow(text, cols, "network"), `cols=${cols}`).toBeNull();
      }
    }
    for (let cols = AD_MIN_COLS; cols <= 200; cols++) {
      expect(adFitsWidth(cols), `cols=${cols}`).toBe(true);
      expect(sponsorRow(SHORT_AD, cols, "network"), `cols=${cols}`).not.toBeNull();
    }
  });

  it("leaves our own lines exactly as they were", () => {
    // House content is not billed and costs nobody anything when it is cut, so
    // it keeps the full prefix and the old, much lower floor.
    for (let cols = 10; cols <= 120; cols++) {
      const row = sponsorRow("/model lists cheapest-turn-first", cols, "house");
      if (!row) {
        expect(cols, `cols=${cols}`).toBeLessThan(AD_MIN_COLS);
        continue;
      }
      expect(row.marker, `cols=${cols}`).toBe(`  ${SPONSOR_MARKER} `);
      expect(row.label, `cols=${cols}`).toBeNull();
    }
    // …and it is still shown at widths where an advertisement is refused.
    expect(sponsorRow("/model lists cheapest-turn-first", 30, "house")).not.toBeNull();
    expect(sponsorRow(SHORT_AD, 30, "network")).toBeNull();
  });
});

/**
 * The refusal has to happen before the request, not before the paint.
 *
 * A serve is the billable event on ADtention's side — the impression id comes
 * back from it — so an advertisement fetched into a terminal too narrow to show
 * it is charged to an advertiser and read by nobody. Fetching and then
 * discarding would be the exact failure the floor exists to prevent, carried
 * out one step later.
 *
 * Driven through the SDK's own `fetch` seam, so what is asserted is whether an
 * HTTP request was made at all rather than whether a helper returned null.
 */
describe("the serve is refused, not the render", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Counts requests. Stubbed on `globalThis`, which is where the SDK looks. */
  const countRequests = () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          impression_id: "imp_1",
          ad_id: "c_1",
          text: "Globex: plan sprints in 5 min",
          billable: true,
          credit: 0.00005,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    return calls;
  };

  it("makes no request at all below the floor", async () => {
    const calls = countRequests();
    const slot = createSponsorSlot({ publisherId: "pub_test", category: "devops" });
    for (const cols of [0, 1, 24, 30, AD_MIN_COLS - 1]) {
      expect(await slot.serve(cols), `cols=${cols}`).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("makes one at the floor and above", async () => {
    const calls = countRequests();
    const slot = createSponsorSlot({ publisherId: "pub_test", category: "devops" });
    const served = await slot.serve(AD_MIN_COLS);
    expect(served?.text).toBe("Globex: plan sprints in 5 min");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/serve");
  });
});
