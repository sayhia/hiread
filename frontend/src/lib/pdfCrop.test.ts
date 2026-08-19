import { describe, it, expect } from "vitest";
import { cropBox, inkOfPage, type PageInk } from "./pdfCrop";

const line = (x: number, right: number, y: number, page: number, size = 10, text = "字") => ({
  x, right, y, size, page, text,
});

/** A page of a Letter-sized book with the margins the real one has. */
const typical = (page: number, extra: Partial<PageInk> = {}): PageInk => ({
  page, left: 99, right: 512, top: 721, bottom: 98, ...extra,
});

describe("where a page's text sits", () => {
  it("takes the outermost edges the lines reach", () => {
    const ink = inkOfPage(
      [line(99, 512, 700, 1), line(120, 480, 680, 1), line(0, 600, 700, 2)],
      1,
    );
    expect(ink).toMatchObject({ left: 99, right: 512, bottom: 680, top: 710 });
  });

  it("has nothing to say about a page with no text", () => {
    expect(inkOfPage([line(0, 0, 0, 2)], 1)).toBeNull();
    expect(inkOfPage([], 1)).toBeNull();
  });
});

describe("the box to trim a book to", () => {
  it("trims the margins a printed page carries", () => {
    const box = cropBox(Array.from({ length: 8 }, (_, i) => typical(i + 1)), 612, 792);
    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(91, 0);
    expect(box!.width).toBeCloseTo(429, 0);
    // The gain is what makes it worth doing: about 1.3x on the type.
    const area = (box!.width * box!.height) / (612 * 792);
    expect(Math.sqrt(1 / area)).toBeGreaterThan(1.2);
  });

  // A chapter opening's text stops halfway down the page. Cropping each page
  // to its own ink would make the type jump from page to page.
  it("is not dragged in by a page that is half empty", () => {
    const inks = [...Array.from({ length: 7 }, (_, i) => typical(i + 1)), typical(8, { top: 430 })];
    const box = cropBox(inks, 612, 792)!;
    const full = cropBox(Array.from({ length: 8 }, (_, i) => typical(i + 1)), 612, 792)!;
    expect(box.height).toBeCloseTo(full.height, 0);
  });

  // One page with a figure reaching into the margin must not be shaved.
  it("keeps room for the widest page it saw", () => {
    const inks = [...Array.from({ length: 20 }, (_, i) => typical(i + 1)), typical(21, { left: 40, right: 572 })];
    const box = cropBox(inks, 612, 792, { percentile: 0.02 })!;
    expect(box.x).toBeLessThanOrEqual(40);
    expect(box.x + box.width).toBeGreaterThanOrEqual(572);
  });

  it("leaves a page already set edge to edge alone", () => {
    const tight = Array.from({ length: 8 }, (_, i) => typical(i + 1, { left: 4, right: 608, top: 788, bottom: 4 }));
    expect(cropBox(tight, 612, 792)).toBeNull();
  });

  it("says nothing when it has barely seen the book", () => {
    expect(cropBox([typical(1)], 612, 792)).toBeNull();
    expect(cropBox([], 612, 792)).toBeNull();
  });
});
