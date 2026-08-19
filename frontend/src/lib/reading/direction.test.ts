// Which way a chapter runs, decided once. Two screens used to each decide it
// in their own words; this is the rule both of them now read.

import { describe, it, expect } from "vitest";
import { leadFromView, leadingViewX, pageDirFromSide, readingAxisOf } from "./direction";

describe("which axis a chapter runs on", () => {
  it("runs down when scrolled and horizontal", () => {
    expect(readingAxisOf("scroll", "horizontal")).toBe("y");
  });

  it("runs across when paged", () => {
    expect(readingAxisOf("paged", "horizontal")).toBe("x");
    expect(readingAxisOf("paged", "vertical")).toBe("x-rtl");
  });

  it("runs across when vertical (古籍), even scrolled — from the right", () => {
    expect(readingAxisOf("scroll", "vertical")).toBe("x-rtl");
  });
});

describe("which way a side of the page turns", () => {
  it("reads a horizontal page as a Western book", () => {
    expect(pageDirFromSide("right", "horizontal")).toBe(1);
    expect(pageDirFromSide("left", "horizontal")).toBe(-1);
  });

  it("reads a vertical page as a classical book", () => {
    // Next column is to the left.
    expect(pageDirFromSide("left", "vertical")).toBe(1);
    expect(pageDirFromSide("right", "vertical")).toBe(-1);
  });
});

describe("where the reading-start of the view is", () => {
  const view = { left: 0, right: 800, top: 0, bottom: 600 } as DOMRect;

  it("is the left of a horizontal page and the right of a 古籍 column", () => {
    expect(leadingViewX(view, "x")).toBe(8);
    expect(leadingViewX(view, "x-rtl")).toBe(792);
  });

  it("measures a box from that start, so x-rtl lead is not a left-edge delta", () => {
    const box = { left: 200, right: 240, top: 40, bottom: 400 } as DOMRect;
    expect(leadFromView(view, box, "x")).toBe(200);
    expect(leadFromView(view, box, "x-rtl")).toBe(560);
    expect(leadFromView(view, box, "y")).toBe(40);
  });
});
