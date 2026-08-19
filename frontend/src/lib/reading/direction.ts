// Which way a chapter runs — the one decision every axis consumer shares.
//
// A scrolled chapter runs down, a paged one runs across, and a vertical (古籍)
// one runs across even when it is not paged. TextReader used to decide this in
// its own computed and HighlightLayer re-decided it from the same two settings
// in its own words — two copies of one rule that could drift. This is the one
// copy: read the two settings, get the axis.

import type { ReadingAxis } from "./position";

export function readingAxisOf(
  pageMode: "scroll" | "paged",
  orientation: "horizontal" | "vertical",
): ReadingAxis {
  // Vertical (古籍) starts on the right: the x axis still, but origin flipped.
  if (orientation === "vertical") return "x-rtl";
  return pageMode === "paged" ? "x" : "y";
}

/** Viewport x of the reading-start edge.
 *
 *  A horizontal page starts on the left; a vertical (古籍) column starts on
 *  the right. Speech, highlights, and "the sentence at the head of the view"
 *  all want that edge, not the physical left. */
export function leadingViewX(view: DOMRect, axis: ReadingAxis, inset = 8): number {
  return axis === "x-rtl" ? view.right - inset : view.left + inset;
}

/** Distance from the reading-start of the view to the reading-start of a box.
 *
 *  Added to `metrics.at` this is where the scroller must go to put that box
 *  on the leading edge — the same number on every axis, including x-rtl,
 *  where the start is the right. Mixing `box.left - view.left` into an
 *  x-rtl `at` used to send the voice the wrong way. */
export function leadFromView(view: DOMRect, box: DOMRect, axis: ReadingAxis): number {
  if (axis === "y") return box.top - view.top;
  if (axis === "x-rtl") return view.right - box.right;
  return box.left - view.left;
}

/** Physical left/right of the page → which way to turn.
 *
 *  A horizontal page is a Western book: the right edge is forward.
 *  A vertical (古籍) page is a classical book: columns run right-to-left,
 *  so the next column is on the left and a click (or arrow) there goes on. */
export function pageDirFromSide(
  side: "left" | "right",
  orientation: "horizontal" | "vertical",
): 1 | -1 {
  if (orientation === "vertical") return side === "left" ? 1 : -1;
  return side === "right" ? 1 : -1;
}
