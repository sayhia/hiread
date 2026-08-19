// The reading settings are only worth anything if they reach the page, so
// these drive the store the way the panel does and check what the app would
// stamp on the document from it.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useUi, READER_BOUNDS } from "./ui";
import { READER_DEFAULTS } from "../lib/readerSettings";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("reading settings", () => {
  it("starts at the values the reader has always had", () => {
    const ui = useUi();
    // Same source as the Aa panel's reset — store boot and panel reset agree.
    expect(ui.readerTracking).toBe(READER_DEFAULTS.readerTracking);
    expect(ui.readerParaGap).toBe(READER_DEFAULTS.readerParaGap);
    expect(ui.readerPadX).toBe(READER_DEFAULTS.readerPadX);
    expect(ui.readerPadY).toBe(READER_DEFAULTS.readerPadY);
    expect(ui.readerPaper).toBe(READER_DEFAULTS.readerPaper);
    expect(ui.readerJustify).toBe(READER_DEFAULTS.readerJustify);
    expect(ui.readerWarmth).toBe(READER_DEFAULTS.readerWarmth);
  });

  it("clamps every value to its bounds rather than trusting the caller", () => {
    const ui = useUi();
    ui.setReader({
      readerTracking: 9999,
      readerParaGap: -50,
      readerPadX: 0,
      readerPadY: 9999,
      readerWarmth: 300,
    });
    expect(ui.readerTracking).toBe(READER_BOUNDS.tracking.max);
    expect(ui.readerParaGap).toBe(READER_BOUNDS.paraGap.min);
    expect(ui.readerPadX).toBe(READER_BOUNDS.padX.min);
    expect(ui.readerPadY).toBe(READER_BOUNDS.padY.max);
    expect(ui.readerWarmth).toBe(100);
  });

  it("keeps every setting across a restart", () => {
    const ui = useUi();
    ui.setReader({ readerTracking: 4, readerParaGap: 32, readerPadX: 88, readerPadY: 68, readerWarmth: 25 });
    ui.setReaderPaper("sepia");
    ui.setReaderJustify(true);
    ui.setReaderGrayscale(true);

    setActivePinia(createPinia());
    const fresh = useUi();
    expect(fresh.readerTracking).toBe(4);
    expect(fresh.readerParaGap).toBe(32);
    expect(fresh.readerPadX).toBe(88);
    expect(fresh.readerPadY).toBe(68);
    expect(fresh.readerWarmth).toBe(25);
    expect(fresh.readerPaper).toBe("sepia");
    expect(fresh.readerJustify).toBe(true);
    expect(fresh.readerGrayscale).toBe(true);
  });

  // A value written by an older build, or edited by hand, must not reach the
  // CSS: "readerPaper: chartreuse" would match no rule and leave the page in
  // whatever the last one was.
  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem("readerPaper", "chartreuse");
    localStorage.setItem("readerTracking", "not a number");
    const ui = useUi();
    expect(ui.readerPaper).toBe("theme");
    expect(ui.readerTracking).toBe(0);
  });
});

// A dense reference book wants a different measure from a novel. The rule that
// makes this unambiguous: the panel always changes what you are looking at.
describe("per-book reading settings", () => {
  it("leaves the global set alone while a book keeps its own", () => {
    const ui = useUi();
    ui.setReader({ readerSize: 18, readerWidth: 700 });

    ui.setPerBook(7, true);
    expect(ui.perBook).toBe(true);
    // Turning it on changes nothing yet: the book starts from what was on
    // screen.
    expect(ui.readerSize).toBe(18);
    expect(ui.readerWidth).toBe(700);

    ui.setReader({ readerSize: 22, readerWidth: 520 });
    expect(ui.readerSize).toBe(22);

    // Close the book: the global set is exactly where it was left.
    ui.useBookProfile(null);
    expect(ui.perBook).toBe(false);
    expect(ui.readerSize).toBe(18);
    expect(ui.readerWidth).toBe(700);

    // Open it again and its own settings come back.
    ui.useBookProfile(7);
    expect(ui.readerSize).toBe(22);
    expect(ui.readerWidth).toBe(520);
  });

  it("gives each book its own, and every other book the global set", () => {
    const ui = useUi();
    ui.setReader({ readerSize: 16 });

    ui.setPerBook(1, true);
    ui.setReader({ readerSize: 21 });
    ui.setReaderPaper("sepia");

    ui.useBookProfile(2); // no settings of its own
    expect(ui.perBook).toBe(false);
    expect(ui.readerSize).toBe(16);
    expect(ui.readerPaper).toBe("theme");

    ui.useBookProfile(1);
    expect(ui.readerSize).toBe(21);
    expect(ui.readerPaper).toBe("sepia");
  });

  it("falls back to the global set when a book's own settings are turned off", () => {
    const ui = useUi();
    ui.setReader({ readerSize: 15 });
    ui.setPerBook(3, true);
    ui.setReader({ readerSize: 22 });
    ui.setReaderJustify(true);

    ui.setPerBook(3, false);
    expect(ui.perBook).toBe(false);
    expect(ui.readerSize).toBe(15);
    expect(ui.readerJustify).toBe(false);

    // And nothing is left behind to come back on the next open.
    ui.useBookProfile(3);
    expect(ui.perBook).toBe(false);
    expect(ui.readerSize).toBe(15);
  });

  it("survives a restart, book settings and all", () => {
    const ui = useUi();
    ui.setReader({ readerSize: 17 });
    ui.setPerBook(9, true);
    ui.setReader({ readerSize: 20, readerPadX: 100 });

    setActivePinia(createPinia());
    const fresh = useUi();
    expect(fresh.readerSize).toBe(17); // the global set, no book open
    fresh.useBookProfile(9);
    expect(fresh.readerSize).toBe(20);
    expect(fresh.readerPadX).toBe(100);
  });
});

// A setting is either the book's or the machine's, and the schema is where
// that is written down. Before it was, the answer was decided one setter at a
// time — and one of them decided wrong.
describe("settings a book does not get to keep", () => {
  it("keeps the auto-scroll speed out of a book's own copy", () => {
    const ui = useUi();
    ui.setPerBook(9, true);
    ui.setReader({ readerAutoSpeed: 120 });

    // The bug: written under the open book's prefix, read back from the plain
    // key, so the change vanished at the next start.
    expect(localStorage.getItem("book9.readerAutoSpeed")).toBeNull();
    expect(localStorage.getItem("readerAutoSpeed")).toBe("120");

    setActivePinia(createPinia());
    const fresh = useUi();
    expect(fresh.readerAutoSpeed).toBe(120);
    fresh.useBookProfile(9);
    expect(fresh.readerAutoSpeed).toBe(120);
  });

  it("keeps click-paging out of it too", () => {
    const ui = useUi();
    ui.setPerBook(9, true);
    ui.setReaderClickPaging(true);

    expect(localStorage.getItem("book9.readerClickPaging")).toBeNull();
    setActivePinia(createPinia());
    expect(useUi().readerClickPaging).toBe(true);
  });

  it("still gives a book its own type", () => {
    const ui = useUi();
    ui.setPerBook(9, true);
    ui.setReader({ readerSize: 21 });
    expect(localStorage.getItem("book9.readerSize")).toBe("21");
  });
});

// "Reset" and "is this already the default?" are the same list asked two ways.
// They were written apart in both places that offer them, and drifted in one.
describe("resetting, by the same list that answers whether to offer it", () => {
  it("agrees with itself over everything a reset touches", () => {
    const ui = useUi();
    expect(ui.isReadingDefault()).toBe(true);

    ui.setReader({ readerAutoSpeed: 200 });
    expect(ui.isReadingDefault()).toBe(false);
    ui.resetReading();
    expect(ui.isReadingDefault()).toBe(true);

    ui.setReaderClickPaging(true);
    expect(ui.isReadingDefault()).toBe(false);
    ui.resetReading();
    expect(ui.isReadingDefault()).toBe(true);
    expect(ui.readerClickPaging).toBe(false);
  });

  it("leaves the reader's own colour alone", () => {
    const ui = useUi();
    ui.setReaderPaperCustom("#123456");
    ui.resetReading();
    // The page stops using it; the colour is still there to go back to.
    expect(ui.readerPaper).toBe(READER_DEFAULTS.readerPaper);
    expect(ui.readerPaperCustom).toBe("#123456");
  });

  it("does not change a global habit from inside a book", () => {
    const ui = useUi();
    ui.setReader({ readerAutoSpeed: 200, readerSize: 21 });
    ui.resetReading("book");
    expect(ui.readerSize).toBe(READER_DEFAULTS.readerSize);
    expect(ui.readerAutoSpeed).toBe(200);
    // And the button offering that reset says there is nothing left to do.
    expect(ui.isReadingDefault("book")).toBe(true);
    expect(ui.isReadingDefault()).toBe(false);
  });
});

// Settings → Reading also offers the app theme and the chapter aids. Those
// are not a book's, so the in-reader reset must not put them back.
describe("resetting the Settings reading page", () => {
  it("treats the theme and the chapter aids as part of that page", () => {
    const ui = useUi();
    expect(ui.isReadingPageDefault()).toBe(true);

    ui.setTheme("dark");
    expect(ui.isReadingDefault()).toBe(true);
    expect(ui.isReadingPageDefault()).toBe(false);
    ui.resetReadingPage();
    expect(ui.theme).toBe("light");
    expect(ui.isReadingPageDefault()).toBe(true);

    ui.setPref({ trimBlankParagraphs: false });
    expect(ui.isReadingPageDefault()).toBe(false);
    ui.resetReadingPage();
    expect(ui.prefs.trimBlankParagraphs).toBe(true);

    ui.setPref({ showReadingTime: false });
    expect(ui.isReadingPageDefault()).toBe(false);
    ui.resetReadingPage();
    expect(ui.prefs.showReadingTime).toBe(true);

    ui.setPref({ showTransSwitch: true });
    expect(ui.isReadingPageDefault()).toBe(false);
    ui.resetReadingPage();
    expect(ui.prefs.showTransSwitch).toBe(false);
  });

  it("does not put the theme back from the in-reader reset", () => {
    const ui = useUi();
    ui.setTheme("dark");
    ui.resetReading();
    expect(ui.theme).toBe("dark");
    ui.resetReading("book");
    expect(ui.theme).toBe("dark");
    expect(ui.isReadingDefault()).toBe(true);
    expect(ui.isReadingDefault("book")).toBe(true);
  });
});

// The schema's promise is that adding a setting means adding a row. It is only
// true while the store can move every row: a key with no ref behind it reads
// as undefined and writes into nothing, and neither says so.
describe("every setting in the schema is one the store can move", () => {
  it("reads and writes all of them", async () => {
    const { READING_SETTINGS } = await import("../lib/reading/schema");
    const ui = useUi();
    for (const s of READING_SETTINGS) {
      expect(ui.readingValue(s.key), `${s.key} has no value`).toBe(s.default);
      const next =
        s.kind === "boolean" ? !s.default
        : s.kind === "number" ? s.default + 1
        : s.kind === "enum" ? (s.options as readonly string[]).find((o) => o !== s.default) ?? s.default
        : "#123456";
      ui.setReading(s.key, next);
      expect(ui.readingValue(s.key), `${s.key} did not take a new value`).toBe(next);
    }
  });

  it("puts all of them back", () => {
    const ui = useUi();
    ui.setReading("readerPageMode", "paged");
    ui.setReading("readerColumns", 2);
    expect(ui.isReadingDefault()).toBe(false);
    ui.resetReading();
    expect(ui.isReadingDefault()).toBe(true);
    expect(ui.readerPageMode).toBe("scroll");
  });
});

// A settings file is applied one setting at a time, and one of the setters has
// a side effect on another: choosing a colour is also choosing to use it,
// which is right when a reader picks one and wrong when a file is being
// restored. The file says what the page colour was; nothing in it should be
// able to overrule that.
describe("restoring a settings file", () => {
  it("ends with the page colour the file said", async () => {
    const { exportReading, importReading } = await import("../lib/reading/transfer");
    const ui = useUi();

    // A reader who kept a colour they are not using.
    ui.setReaderPaperCustom("#123456");
    ui.setReaderPaper("sepia");
    const file = exportReading((k) => ui.readingValue(k));

    // Somewhere else, or later.
    const fresh = useUi();
    fresh.resetReading();
    for (const { key, value } of importReading(file).values) fresh.setReading(key, value);

    expect(fresh.readerPaper).toBe("sepia");
    expect(fresh.readerPaperCustom).toBe("#123456");
  });

  it("still restores a reader who was using their own colour", async () => {
    const { exportReading, importReading } = await import("../lib/reading/transfer");
    const ui = useUi();
    ui.setReaderPaperCustom("#abcdef"); // selects it, as picking one does
    expect(ui.readerPaper).toBe("custom");
    const file = exportReading((k) => ui.readingValue(k));

    ui.resetReading();
    for (const { key, value } of importReading(file).values) ui.setReading(key, value);

    expect(ui.readerPaper).toBe("custom");
    expect(ui.readerPaperCustom).toBe("#abcdef");
  });
});

// The 古籍 preset once turned the drop cap off as part of going vertical —
// but the vertical column already disables it in CSS, and the forced "off"
// persisted into horizontal reading, where a reader who never chose it found
// their opening paragraph undecorated.
describe("the vertical (古籍) preset", () => {
  it("switches the column on without touching the drop cap", () => {
    const ui = useUi();
    ui.setReading("readerDropCap", "double");
    ui.applyVerticalPreset();

    expect(ui.readerOrientation).toBe("vertical");
    expect(ui.readerColSep).toBe(true);
    expect(ui.readerDropCap).toBe("double");
  });
});
