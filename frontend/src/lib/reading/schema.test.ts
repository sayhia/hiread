// The schema is only worth having if it is a faithful description of what the
// app already does. Everything downstream is about to be pointed at it, so
// before that happens: every default, every bound, every named step and every
// per-book key it claims has to be the one in force today — including the
// bounds that exist nowhere but inside a `ls.num(...)` call in the store, which
// is exactly the kind of place a second copy hides.
//
// The store reaches the Wails runtime through api.ts on import, so this needs
// a window to exist even though nothing here renders.
//
// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  READING_DEFAULTS,
  RESET_NUMBERS,
  RESET_VALUES,
  PER_BOOK_KEYS,
  BOUNDS,
  STEPS,
  settingsFor,
  groupsFor,
  settingVisible,
  settingOf,
  migrateLeading,
  migrateParaGap,
  migrateTracking,
  READING_SETTINGS,
} from "./schema";
import {
  READER_DEFAULTS,
  READER_RESET_NUMBERS,
  READER_LEADING_STEPS,
  READER_TRACKING_STEPS,
  READER_PARA_STEPS,
  READER_MARGIN_STEPS,
  READER_WIDTH_STEPS,
} from "../readerSettings";
import { READER_BOUNDS, READER_SIZE_STEPS } from "../../stores/ui";

// Read from the project root the way the other source-scraping test does:
// under jsdom `import.meta.url` does not resolve to a path on disk.
const storeSrc = readFileSync("src/stores/ui.ts", "utf8");

describe("the reading-settings schema describes what the app already does", () => {
  it("has the same defaults", () => {
    expect(READING_DEFAULTS).toEqual({ ...READER_DEFAULTS });
  });

  // One deliberate difference, and it is the seam the drift came through: the
  // old table left the auto-scroll speed out, so every caller had to remember
  // to add it by hand — `setReader({ ...READER_RESET_NUMBERS, readerAutoSpeed
  // })`. The reset remembered; the "is this still default?" check, which
  // iterated the same table, did not, and greyed itself out over a setting the
  // reader had changed. In the schema a resettable number is simply in the
  // list.
  it("resets the same numbers, plus the globals the old table made callers add", () => {
    // The old table held the numbers a *book* can keep, and every caller had
    // to remember to add the global ones by hand — which the reset did and the
    // "is this still default?" check did not. The two views differ by exactly
    // the global numbers now, whatever they come to be.
    const globals = Object.fromEntries(
      READING_SETTINGS.filter((s) => s.kind === "number" && s.resettable && !s.perBook).map(
        (s) => [s.key, s.default],
      ),
    );
    expect(globals.readerAutoSpeed).toBe(READER_DEFAULTS.readerAutoSpeed);
    expect(RESET_NUMBERS).toEqual({ ...READER_RESET_NUMBERS, ...globals });
  });

  // These two started as "the schema agrees with the store". They are now
  // "the store has nothing left to agree with" — which is the point of the
  // exercise, and a stronger thing to check: a copy that does not exist cannot
  // drift.
  it("is where the per-book key list lives now", () => {
    expect(storeSrc).not.toMatch(/const READING_KEYS = \[/);
    expect(storeSrc).toMatch(/READING_KEYS = PER_BOOK_KEYS/);
    // And the list still has to be the right one.
    expect([...PER_BOOK_KEYS].sort()).toEqual(
      [
        "readerFont", "readerSize", "readerLeading", "readerWidth", "readerTracking",
        "readerParaGap", "readerPadX", "readerPadY", "readerJustify", "readerTypeset",
        "readerDropCap", "readerIndent", "readerEndMark", "readerColSep", "readerOrientation",
        "readerPaper", "readerWarmth", "readerGrayscale", "readerPaperCustom",
        "readerTexture", "readerInk", "readerInkCustom",
      ].sort(),
    );
  });

  it("carries the same named steps", () => {
    expect(STEPS.readerSize).toEqual([...READER_SIZE_STEPS]);
    expect(STEPS.readerLeading).toEqual([...READER_LEADING_STEPS]);
    expect(STEPS.readerTracking).toEqual([...READER_TRACKING_STEPS]);
    expect(STEPS.readerParaGap).toEqual([...READER_PARA_STEPS]);
    expect(STEPS.readerPadX).toEqual([...READER_MARGIN_STEPS]);
    expect(STEPS.readerWidth).toEqual([...READER_WIDTH_STEPS]);
  });

  it("clamps to the same bounds as the exported table", () => {
    for (const [name, b] of Object.entries(READER_BOUNDS)) {
      const key = `reader${name[0].toUpperCase()}${name.slice(1)}`;
      expect(BOUNDS[key], `${key} is missing from the schema`).toEqual({ ...b });
    }
  });

  // Warmth, contrast and the auto-scroll speed used to be clamped by numbers
  // written inline where the ref is created and nowhere else — the kind of
  // second copy that is invisible because it does not look like a table. The
  // schema knows them now, and the store must not carry its own again.
  it("is where the bounds live now", () => {
    const inline = [...storeSrc.matchAll(/ls\.num\("(\w+)",\s*[^,]+,\s*(-?\d+),\s*(-?\d+)\)/g)];
    expect(
      inline.map((m) => m[1]),
      "a reading setting is being clamped by numbers written into the store",
    ).toEqual([]);

    // Every number the schema describes has bounds, and they are the ones in
    // force: READER_BOUNDS is now a view of this table.
    for (const s of READING_SETTINGS) {
      if (s.kind !== "number") continue;
      expect(BOUNDS[s.key], `${s.key} has no bounds`).toEqual({ min: s.min, max: s.max });
    }
    expect(BOUNDS.readerWarmth).toEqual({ min: 0, max: 100 });
    expect(BOUNDS.readerAutoSpeed).toEqual({ min: 8, max: 240 });
  });

  it("reads old thousandths-of-an-em tracking as pixels", () => {
    expect(migrateTracking(3)).toBe(0);
    expect(migrateTracking(-8)).toBe(-1);
    expect(migrateTracking(30)).toBe(2);
    expect(migrateTracking(4)).toBe(4);
    expect(migrateTracking(0)).toBe(0);
    expect(migrateLeading(165)).toBe(28);
    expect(migrateLeading(28)).toBe(28);
    expect(migrateParaGap(105)).toBe(18);
    expect(migrateParaGap(18)).toBe(18);
  });

  it("lets the type get large, and tracks in pixels", () => {
    const size = settingOf("readerSize");
    if (size.kind !== "number") throw new Error("readerSize is not a number setting");
    expect(size.min).toBe(12);
    expect(size.max).toBe(96);
    const track = settingOf("readerTracking");
    if (track.kind !== "number") throw new Error("readerTracking is not a number setting");
    expect(track.default).toBe(0);
    expect(track.min).toBe(-8);
    expect(track.max).toBe(32);
  });

  it("hides the settings that paint nothing on a 古籍 page", () => {
    const drop = settingOf("readerDropCap");
    const cols = settingOf("readerColumns");
    const just = settingOf("readerJustify");
    const sep = settingOf("readerColSep");
    const size = settingOf("readerSize");
    expect(settingVisible(drop, "horizontal")).toBe(true);
    expect(settingVisible(drop, "vertical")).toBe(false);
    expect(settingVisible(cols, "vertical")).toBe(false);
    expect(settingVisible(just, "vertical")).toBe(false);
    expect(settingVisible(sep, "horizontal")).toBe(false);
    expect(settingVisible(sep, "vertical")).toBe(true);
    expect(settingVisible(size, "vertical")).toBe(true);
    const width = settingOf("readerWidth");
    expect(settingVisible(width, "vertical", "scroll")).toBe(false);
    expect(settingVisible(width, "vertical", "paged")).toBe(true);
  });

  it("notches the indent across the whole span", () => {
    // The paragraph lead is 0–4 字, every step — no indent, or anything up
    // to four, with none as the default.
    const indent = settingOf("readerIndent");
    if (indent.kind !== "number") throw new Error("readerIndent is not a number setting");
    expect(indent.default).toBe(0);
    expect(indent.steps?.map((s) => s.value)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("what the schema adds", () => {
  it("knows a reset touches more than numbers", () => {
    // The bug this whole layer exists to prevent: the reset put back booleans
    // and the page colour too, and the check that greys the button out only
    // ever looked at the numbers.
    expect(Object.keys(RESET_VALUES).length).toBeGreaterThan(Object.keys(RESET_NUMBERS).length);
    expect(RESET_VALUES.readerJustify).toBe(false);
    expect(RESET_VALUES.readerPaper).toBe("theme");
    expect(RESET_VALUES.readerClickPaging).toBe(false);
    // Not the reader's own colour, though — a reset stops it being used
    // without throwing it away.
    expect(RESET_VALUES).not.toHaveProperty("readerPaperCustom");
  });

  it("keeps the type settings away from a PDF", () => {
    const pdf = settingsFor("pdf").map((s) => s.key);
    expect(pdf).not.toContain("readerSize");
    expect(pdf).not.toContain("readerFont");
    expect(pdf).not.toContain("readerWidth");
    // Grain belongs to the sheet the text is set on, not to a picture of a page.
    expect(pdf).not.toContain("readerTexture");
    // What a PDF *can* change is the surface around and over it.
    expect(pdf).toEqual(
      expect.arrayContaining(["readerPaper", "readerWarmth", "readerGrayscale"]),
    );
    expect(pdf).toEqual(
      expect.arrayContaining(["readerShowPage", "readerShowClock", "readerShowLeft"]),
    );
  });

  it("offers a PDF the groups that reach a picture of a page, and a book several", () => {
    expect(groupsFor("pdf")).toEqual(["page", "motion", "display"]);
    expect(groupsFor("text")).toEqual(["type", "layout", "page", "motion", "display"]);
  });

  it("refuses a key it does not have", () => {
    expect(() => settingOf("readerNope" as never)).toThrow(/unknown reading setting/);
  });

  it("names every setting exactly once", () => {
    const keys = READING_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
