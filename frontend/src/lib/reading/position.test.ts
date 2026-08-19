// The point of an axis is that the answers do not change with it. So every
// question is asked twice here, once down and once across, over scrollers with
// the same numbers on their own axis — and has to give the same answer.
//
// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  atEnd,
  atStart,
  hasMoved,
  isAcross,
  leadingIndex,
  metrics,
  offsetForRatio,
  offsetOf,
  ratioOf,
  scrollTo,
  setRtlScrollTypeForTest,
  settle,
  span,
  stepFor,
  type ReadingAxis,
} from "./position";

/** A scroller with given numbers on the axis it runs, and nothing on the
 *  other — which is what the real ones look like. */
function scroller(axis: ReadingAxis, at: number, view: number, total: number) {
  const el = document.createElement("div");
  const set = (k: string, v: number) =>
    Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
  if (axis === "y") {
    el.scrollTop = at;
    set("clientHeight", view);
    set("scrollHeight", total);
    el.scrollLeft = 0;
    set("clientWidth", 0);
    set("scrollWidth", 0);
  } else {
    el.scrollLeft = at;
    set("clientWidth", view);
    set("scrollWidth", total);
    el.scrollTop = 0;
    set("clientHeight", 0);
    set("scrollHeight", 0);
  }
  return el;
}

const AXES: ReadingAxis[] = ["y", "x"];

describe("reading position, on either axis", () => {
  for (const axis of AXES) {
    const label = axis === "y" ? "scrolled" : "paged";

    it(`${label}: reports how far through the chapter it is`, () => {
      const m = metrics(scroller(axis, 0, 800, 4000), axis);
      expect(ratioOf(m)).toBe(0);
      expect(ratioOf(metrics(scroller(axis, 3200, 800, 4000), axis))).toBe(1);
      expect(ratioOf(metrics(scroller(axis, 1600, 800, 4000), axis))).toBe(0.5);
      expect(span(m)).toBe(3200);
    });

    // Both modes must answer this the same way, or a book opened in the other
    // one would jump on every chapter shorter than its window.
    it(`${label}: says 0 for a chapter with nowhere to go`, () => {
      const m = metrics(scroller(axis, 0, 800, 800), axis);
      expect(ratioOf(m)).toBe(0);
      expect(span(m)).toBe(0);
      expect(offsetForRatio(m, 0.7)).toBe(0);
      // And a chapter with nowhere to go is at both ends of itself at once,
      // which is what makes the chapter dock appear on a short chapter.
      expect(atStart(m)).toBe(true);
      expect(atEnd(m)).toBe(true);
    });

    it(`${label}: comes back to the position a ratio came from`, () => {
      const m = metrics(scroller(axis, 0, 800, 4000), axis);
      for (const r of [0, 0.25, 0.5, 1]) {
        const to = offsetForRatio(m, r);
        expect(ratioOf({ ...m, at: to })).toBeCloseTo(r, 10);
      }
    });

    it(`${label}: survives a ratio that is not a number`, () => {
      const m = metrics(scroller(axis, 0, 800, 4000), axis);
      expect(offsetForRatio(m, NaN)).toBe(0);
      expect(offsetForRatio(m, -3)).toBe(0);
      expect(offsetForRatio(m, 9)).toBe(3200);
    });

    it(`${label}: knows the ends`, () => {
      expect(atStart(metrics(scroller(axis, 0, 800, 4000), axis))).toBe(true);
      expect(atStart(metrics(scroller(axis, 40, 800, 4000), axis))).toBe(false);
      expect(atEnd(metrics(scroller(axis, 3200, 800, 4000), axis))).toBe(true);
      expect(atEnd(metrics(scroller(axis, 1000, 800, 4000), axis))).toBe(false);
      // A sub-pixel short of the end is the end to a reader.
      expect(atEnd(metrics(scroller(axis, 3199.4, 800, 4000), axis))).toBe(true);
    });

    it(`${label}: knows when the reader has left the top`, () => {
      expect(hasMoved(metrics(scroller(axis, 0, 800, 4000), axis))).toBe(false);
      expect(hasMoved(metrics(scroller(axis, 3, 800, 4000), axis))).toBe(false);
      expect(hasMoved(metrics(scroller(axis, 60, 800, 4000), axis))).toBe(true);
    });

    it(`${label}: writes a position back on its own axis`, () => {
      const el = scroller(axis, 0, 800, 4000);
      const to = vi.fn();
      el.scrollTo = to as unknown as typeof el.scrollTo;
      scrollTo(el, axis, 1600, true);
      expect(to).toHaveBeenCalledWith(
        axis === "y"
          ? { top: 1600, left: 0, behavior: "smooth" }
          : { left: 1600, top: 0, behavior: "smooth" },
      );
    });

    // jsdom has no Element.scrollTo at all, so a move routed through it would
    // do nothing in every test and every test would pass. A move with no
    // animation is an assignment.
    it(`${label}: moves without animation by assigning, not by asking`, () => {
      const el = scroller(axis, 0, 800, 4000);
      const to = vi.fn();
      el.scrollTo = to as unknown as typeof el.scrollTo;
      scrollTo(el, axis, 900);
      expect(to).not.toHaveBeenCalled();
      expect(axis === "y" ? el.scrollTop : el.scrollLeft).toBe(900);
    });

    it(`${label}: still moves where the engine has no scrollTo`, () => {
      const el = scroller(axis, 0, 800, 4000);
      Object.defineProperty(el, "scrollTo", { value: undefined, configurable: true });
      scrollTo(el, axis, 900, true);
      expect(axis === "y" ? el.scrollTop : el.scrollLeft).toBe(900);
    });
  }
});

// The one place the axes differ, and it is a decision rather than a mechanism.
describe("how far one press moves", () => {
  it("leaves a couple of lines of overlap down a scrolled chapter", () => {
    const m = metrics(scroller("y", 0, 800, 4000), "y");
    expect(stepFor(m, "y", 28)).toBe(800 - 56);
  });

  it("moves exactly one page across a paged one", () => {
    // A page that overlapped the last one would not be a page.
    const m = metrics(scroller("x", 0, 744, 53504), "x");
    expect(stepFor(m, "x", 28)).toBe(744);
  });

  it("still moves something in a window too small to take a step", () => {
    const m = metrics(scroller("y", 0, 40, 4000), "y");
    expect(stepFor(m, "y", 28)).toBeGreaterThan(0);
  });
});

describe("finding things inside the scroller", () => {
  /** jsdom has no layout, so the boxes are given. */
  function withBoxes(axis: ReadingAxis, at: number, boxes: number[]) {
    const el = scroller(axis, at, 800, 4000);
    el.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
    const children = boxes.map((offset) => {
      const c = document.createElement("p");
      c.getBoundingClientRect = () =>
        (axis === "y" ? { top: offset - at, left: 0 } : { top: 0, left: offset - at }) as DOMRect;
      el.appendChild(c);
      return c;
    });
    return { el, children };
  }

  for (const axis of AXES) {
    it(`${axis}: measures an element from the start of the content`, () => {
      const { el, children } = withBoxes(axis, 500, [0, 900, 1800]);
      expect(offsetOf(el, children[1], axis)).toBe(900);
    });

    it(`${axis}: says which one the reader has reached`, () => {
      const { el, children } = withBoxes(axis, 950, [0, 900, 1800]);
      expect(leadingIndex(el, children, axis)).toBe(1);
    });

    it(`${axis}: says none before the first is reached`, () => {
      const { el, children } = withBoxes(axis, 0, [400, 900]);
      expect(leadingIndex(el, children, axis)).toBe(-1);
    });

    it(`${axis}: does not skip ahead to one further down`, () => {
      const { el, children } = withBoxes(axis, 950, [0, 900, 1800]);
      expect(leadingIndex(el, children, axis)).not.toBe(2);
    });
  }
});

describe("a vertical (古籍) chapter, from the right", () => {
  afterEach(() => setRtlScrollTypeForTest(null));

  it("treats isAcross as true, like any across-running chapter", () => {
    expect(isAcross("x-rtl")).toBe(true);
    expect(isAcross("x")).toBe(true);
    expect(isAcross("y")).toBe(false);
  });

  it("in the default engine, 0 on the left is the end", () => {
    setRtlScrollTypeForTest("default");
    const el = scroller("x", 0, 800, 4000);
    // Physical left (scrollLeft 0) is the last column.
    expect(metrics(el, "x-rtl").at).toBe(3200);
    expect(ratioOf(metrics(el, "x-rtl"))).toBe(1);
    // And the right (scrollLeft = max) is the start.
    el.scrollLeft = 3200;
    expect(metrics(el, "x-rtl").at).toBe(0);
    expect(ratioOf(metrics(el, "x-rtl"))).toBe(0);
  });

  it("writes a logical start back to the physical right", () => {
    setRtlScrollTypeForTest("default");
    const el = scroller("x", 0, 800, 4000);
    scrollTo(el, "x-rtl", 0);
    expect(el.scrollLeft).toBe(3200);
    scrollTo(el, "x-rtl", 3200);
    expect(el.scrollLeft).toBe(0);
  });

  it("in reverse engines (jsdom), scrollLeft is already the reading offset", () => {
    setRtlScrollTypeForTest("reverse");
    const el = scroller("x", 800, 800, 4000);
    expect(metrics(el, "x-rtl").at).toBe(800);
    scrollTo(el, "x-rtl", 1600);
    expect(el.scrollLeft).toBe(1600);
  });

  it("settle snap=false keeps exact offset", () => {
    const m = metrics(scroller("x", 0, 800, 4000), "x-rtl");
    expect(settle(m, "x-rtl", 1234, "nearest", false)).toBe(1234);
  });

  it("in a negative engine, logical at is -scrollLeft; scrollTo writes negative", () => {
    setRtlScrollTypeForTest("negative");
    const el = scroller("x", -800, 800, 4000);
    expect(metrics(el, "x-rtl").at).toBe(800);
    scrollTo(el, "x-rtl", 1600);
    expect(el.scrollLeft).toBe(-1600);
  });
});

// Across a paged chapter the positions that exist are multiples of a viewport.
// Every jump the reader does not make by hand — a link into the chapter, a
// heading from the contents, the sentence being read aloud, being put back
// after a reflow — went through an offset that was none of them, and landed
// showing half of one page and half of the next.
describe("where a position can actually be", () => {
  const paged = metrics(scroller("x", 0, 744, 7440), "x");
  const scrolled = metrics(scroller("y", 0, 800, 4000), "y");

  it("leaves a scrolled chapter alone", () => {
    expect(settle(scrolled, "y", 1234)).toBe(1234);
    expect(settle(scrolled, "y", 1234, "contain")).toBe(1234);
  });

  it("puts a paged one on a page", () => {
    expect(settle(paged, "x", 744 * 3)).toBe(744 * 3);
    expect(settle(paged, "x", 744 * 3 + 20)).toBe(744 * 3);
    expect(settle(paged, "x", 744 * 3 + 700)).toBe(744 * 4);
  });

  it("snaps a fractional viewport to a whole pixel page", () => {
    const odd = metrics(scroller("x", 0, 743.6, 7436), "x");
    expect(settle(odd, "x", 743.6)).toBe(744);
    expect(settle(odd, "x", 743.6 * 2 + 0.2)).toBe(744 * 2);
  });

  // Rounding up would scroll past the very thing being brought into view.
  it("shows the page a thing is on, not the one after it", () => {
    expect(settle(paged, "x", 744 * 3 + 700, "contain")).toBe(744 * 3);
    expect(settle(paged, "x", 744 * 3, "contain")).toBe(744 * 3);
  });

  it("stays inside the chapter", () => {
    expect(settle(paged, "x", 744 * 99)).toBe(744 * 9);
    expect(settle(paged, "x", -500)).toBe(0);
    expect(settle(paged, "x", NaN)).toBe(0);
  });

  it("agrees with the page number counted beside it", () => {
    // The status line counts pages from the ratio; the view is put where
    // `settle` says. They have to be the same page or the number lies.
    for (const p of [0, 1, 5, 9]) {
      const at = settle(paged, "x", p * 744 + 100);
      expect(Math.round(at / 744)).toBe(p);
    }
  });
});
