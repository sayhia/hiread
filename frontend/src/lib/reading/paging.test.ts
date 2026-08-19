// The ends are where paging arithmetic goes wrong: a chapter one page long, a
// chapter whose last page is nearly empty, a window resized while the reader
// is in the middle of one. None of those need a browser to check.

import { describe, it, expect } from "vitest";
import {
  clampPage,
  columnOf,
  offsetOfPage,
  pageAfterReflow,
  pageCount,
  pageOfOffset,
  pageOfRatio,
  pageStep,
  ratioOfPage,
} from "./paging";

describe("how far one page is", () => {
  it("is the page plus the gutter before the next", () => {
    expect(pageStep(680, 64)).toBe(744);
  });

  // Measured over a real chapter: one column and two give the same page width
  // and the same step. Two columns divide the page; they do not put two pages
  // side by side. Assuming otherwise is what made the first version of this
  // count 72 pages where the browser had laid out 83 columns.
  it("does not change when the page is split into two columns", () => {
    expect(pageStep(680, 64)).toBe(744);
  });
});

describe("how many pages a chapter comes to", () => {
  // A layout of n pages measures n*pageWidth + (n-1)*gap: every page but the
  // last is followed by a gutter. These are the numbers a real chapter gave.
  it("matches what the browser actually laid out", () => {
    const step = pageStep(680, 64);
    expect(pageCount(53504, step, 64)).toBe(72);   // one column
    expect(pageCount(51272, step, 64)).toBe(69);   // two columns, same pages
  });

  it("does not invent a blank page out of the trailing gutter", () => {
    const step = pageStep(680, 64);
    expect(pageCount(680 * 3 + 64 * 2, step, 64)).toBe(3);
  });

  it("absorbs a sub-pixel measurement rather than rounding up on it", () => {
    const step = pageStep(680, 64);
    expect(pageCount(680 * 3 + 64 * 2 + 0.4, step, 64)).toBe(3);
    expect(pageCount(680 * 3 + 64 * 2 - 0.4, step, 64)).toBe(3);
  });

  it("is one page for a chapter that fits, and never zero", () => {
    expect(pageCount(500, 744, 64)).toBe(1);
    expect(pageCount(0, 744, 64)).toBe(1);
    expect(pageCount(1000, 0, 64)).toBe(1);
  });
});

describe("which page an offset is showing", () => {
  const step = 744;
  it("is the page the view has landed on", () => {
    expect(pageOfOffset(0, step, 10)).toBe(0);
    expect(pageOfOffset(step * 4, step, 10)).toBe(4);
  });

  it("does not fall to the next page for a pixel of overshoot", () => {
    expect(pageOfOffset(step * 4 + 1, step, 10)).toBe(4);
    expect(pageOfOffset(step * 4 - 1, step, 10)).toBe(4);
  });

  it("stays inside the chapter", () => {
    expect(pageOfOffset(step * 99, step, 10)).toBe(9);
    expect(pageOfOffset(-step, step, 10)).toBe(0);
  });

  it("agrees with where a page is put", () => {
    for (const p of [0, 1, 7, 9]) {
      expect(pageOfOffset(offsetOfPage(p, step), step, 10)).toBe(p);
    }
  });
});

describe("progress, on the scale a scrolled chapter reports", () => {
  it("runs 0 to 1 across the pages", () => {
    expect(ratioOfPage(0, 5)).toBe(0);
    expect(ratioOfPage(4, 5)).toBe(1);
    expect(ratioOfPage(2, 5)).toBe(0.5);
  });

  // A chapter of one page reports 0, not 1 — the same as the scrolled reader
  // already reports for a chapter shorter than its window. The two modes have
  // to agree about this or a book read in both would jump on every short
  // chapter.
  it("says nothing about a chapter with one page", () => {
    expect(ratioOfPage(0, 1)).toBe(0);
    expect(pageOfRatio(0.7, 1)).toBe(0);
  });

  it("comes back to the page it came from", () => {
    for (const pages of [1, 2, 5, 72]) {
      for (const p of [0, 1, Math.floor(pages / 2), pages - 1]) {
        expect(pageOfRatio(ratioOfPage(p, pages), pages)).toBe(clampPage(p, pages));
      }
    }
  });

  it("lands on the page the reader was on, not the one before it", () => {
    // Halfway through a two-page chapter is the second page: that is where
    // they were when it was saved.
    expect(pageOfRatio(0.49, 2)).toBe(0);
    expect(pageOfRatio(0.51, 2)).toBe(1);
  });

  it("survives a ratio that is not a number", () => {
    expect(pageOfRatio(NaN, 10)).toBe(0);
    expect(pageOfRatio(-1, 10)).toBe(0);
    expect(pageOfRatio(9, 10)).toBe(9);
  });
});

describe("when the geometry changes under the reader", () => {
  // A resized window, a larger type, a second column: the page count changes
  // and the page number stops meaning anything. Page 40 of 70 is not page 40
  // of 30, and a reader who resized a window has not asked to be moved.
  it("keeps the place rather than the page number", () => {
    expect(pageAfterReflow(40, 71, 31)).toBe(pageOfRatio(40 / 70, 31));
    expect(pageAfterReflow(0, 70, 30)).toBe(0);
    expect(pageAfterReflow(69, 70, 30)).toBe(29);
  });

  it("keeps the last page last, however the count moves", () => {
    for (const [before, after] of [[70, 30], [30, 70], [5, 5], [9, 1]]) {
      expect(pageAfterReflow(before - 1, before, after)).toBe(after - 1);
    }
  });

  it("keeps the first page first", () => {
    for (const [before, after] of [[70, 30], [30, 70], [1, 9]]) {
      expect(pageAfterReflow(0, before, after)).toBe(0);
    }
  });

  // A chapter of one page has no position in it — it reports 0, the same as a
  // scrolled chapter shorter than its window. Growing it to nine pages puts
  // the reader at the start, because that is all 0 can mean.
  it("puts a chapter that had no positions at its start", () => {
    expect(pageAfterReflow(0, 1, 9)).toBe(0);
  });
});

describe("a scrolled vertical (古籍) chapter counted in columns", () => {
  // A screenful is the unit — the scrolled reader has no pages, and the
  // viewport is the column it reads one at a time.
  it("is one screenful per column", () => {
    expect(columnOf(0, 500, 2500)).toEqual({ col: 0, cols: 5 });
    expect(columnOf(499, 500, 2500)).toEqual({ col: 0, cols: 5 });
    expect(columnOf(500, 500, 2500)).toEqual({ col: 1, cols: 5 });
    expect(columnOf(2499, 500, 2500)).toEqual({ col: 4, cols: 5 });
  });

  it("counts a trailing half-screen as a column, not away", () => {
    expect(columnOf(2400, 500, 2600)).toEqual({ col: 4, cols: 6 });
    expect(columnOf(2599, 500, 2600)).toEqual({ col: 5, cols: 6 });
  });

  it("never reports being past the last column, or zero columns", () => {
    expect(columnOf(99999, 500, 2500)).toEqual({ col: 4, cols: 5 });
    expect(columnOf(0, 0, 0)).toEqual({ col: 0, cols: 1 });
  });
});
