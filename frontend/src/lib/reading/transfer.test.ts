// A settings file is the one place a reader's preferences meet a text file
// they can edit, an older build, or another machine. So the interesting cases
// are all the malformed ones — and the rule that a file with one bad line is
// still a file with twenty good ones.

import { describe, it, expect } from "vitest";
import { exportReading, importReading } from "./transfer";
import { READING_DEFAULTS, READING_SETTINGS, BOUNDS } from "./schema";

const defaults = (key: string) => (READING_DEFAULTS as Record<string, unknown>)[key];

describe("writing the settings out", () => {
  it("writes every setting there is", () => {
    const file = JSON.parse(exportReading(defaults));
    expect(Object.keys(file.settings).sort()).toEqual(READING_SETTINGS.map((s) => s.key).sort());
    expect(file.kind).toBe("reading-settings");
  });

  it("comes back as what went out", () => {
    const { values, skipped } = importReading(exportReading(defaults));
    expect(skipped).toEqual([]);
    expect(values).toHaveLength(READING_SETTINGS.length);
    for (const { key, value } of values) expect(value).toBe(defaults(key));
  });
});

describe("reading a settings file back", () => {
  const wrap = (settings: Record<string, unknown>) =>
    JSON.stringify({ app: "hiread", kind: "reading-settings", version: 1, settings });

  it("refuses something that is not a settings file", () => {
    expect(() => importReading("not json at all")).toThrow(/not a settings file/);
    expect(() => importReading('{"kind":"bookmarks"}')).toThrow(/not a settings file/);
    expect(() => importReading('{"kind":"reading-settings"}')).toThrow(/not a settings file/);
    expect(() => importReading("null")).toThrow(/not a settings file/);
  });

  // The rule the whole file exists for.
  it("keeps the good lines of a file with a bad one", () => {
    const { values, skipped } = importReading(
      wrap({ readerSize: 20, readerNonsense: 3, readerPaper: "chartreuse" }),
    );
    expect(values).toEqual([{ key: "readerSize", value: 20 }]);
    expect(skipped.sort()).toEqual(["readerNonsense", "readerPaper"]);
  });

  // A file from a build with a wider range still describes the size the reader
  // wanted, and the nearest size this build can set is closer to it than the
  // default is.
  it("brings an out-of-range number to the nearest one it can set", () => {
    const { values, skipped } = importReading(wrap({ readerSize: 400 }));
    expect(values).toEqual([{ key: "readerSize", value: BOUNDS.readerSize.max }]);
    expect(skipped).toEqual([]);
  });

  it("will not take a number that is not one", () => {
    expect(importReading(wrap({ readerSize: "large" })).skipped).toEqual(["readerSize"]);
    expect(importReading(wrap({ readerSize: null })).skipped).toEqual(["readerSize"]);
    expect(importReading(wrap({ readerSize: {} })).skipped).toEqual(["readerSize"]);
  });

  it("will not take a switch that is not one", () => {
    // "true" is a string, and a setting that takes it would be on for anything
    // at all, including "false".
    expect(importReading(wrap({ readerJustify: "true" })).skipped).toEqual(["readerJustify"]);
    expect(importReading(wrap({ readerJustify: 1 })).skipped).toEqual(["readerJustify"]);
    expect(importReading(wrap({ readerJustify: true })).values).toEqual([
      { key: "readerJustify", value: true },
    ]);
  });

  it("takes only a colour that is one", () => {
    expect(importReading(wrap({ readerPaperCustom: "#A1B2C3" })).values).toHaveLength(1);
    expect(importReading(wrap({ readerPaperCustom: "red" })).skipped).toEqual([
      "readerPaperCustom",
    ]);
    expect(importReading(wrap({ readerPaperCustom: "#fff" })).skipped).toEqual([
      "readerPaperCustom",
    ]);
  });

  // A face may be a font installed on the other machine. Resolving a name this
  // build has not heard of is the font layer's job, and it already falls back.
  it("takes a face it has never heard of", () => {
    expect(importReading(wrap({ readerFont: "system:Iowan Old Style" })).values).toEqual([
      { key: "readerFont", value: "system:Iowan Old Style" },
    ]);
    expect(importReading(wrap({ readerFont: "" })).skipped).toEqual(["readerFont"]);
    expect(importReading(wrap({ readerFont: "x".repeat(500) })).skipped).toEqual(["readerFont"]);
  });

  it("says nothing was in an empty one", () => {
    const { values, skipped } = importReading(wrap({}));
    expect(values).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

// The order the values come back in is part of the answer, not a detail of it:
// they are applied one at a time, and one of the setters writes a second
// setting as a side effect.
describe("the order a file is applied in", () => {
  it("leaves the settings another one would overwrite until last", () => {
    const { values } = importReading(exportReading(defaults));
    const keys = values.map((v) => v.key);
    // Writing the custom colour selects it, so the page colour has to be set
    // after it or the file's own choice is lost.
    expect(keys.indexOf("readerPaper")).toBeGreaterThan(keys.indexOf("readerPaperCustom"));
  });

  it("keeps the schema's order among everything else", () => {
    const { values } = importReading(exportReading(defaults));
    // The ink choice is clobbered like the paper choice is: a custom colour
    // writes it, so a file applies the clobbered keys last. Drop them from
    // both sides and the remaining order is the schema's.
    const clobbered = new Set(["readerPaper", "readerInk"]);
    const keys = values.map((v) => v.key).filter((k) => !clobbered.has(k));
    const schemaOrder = READING_SETTINGS.map((s) => s.key).filter((k) => !clobbered.has(k));
    expect(keys).toEqual(schemaOrder);
  });
});
