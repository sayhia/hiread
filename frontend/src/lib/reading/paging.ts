// Turning a page, as arithmetic.
//
// A paged chapter is one long row of pages, each as wide as the reading measure
// and as tall as the window, with a view over it that moves by whole pages.
// Everything about that is arithmetic, and all of it is the kind that goes
// quietly wrong at the ends: a chapter exactly one page long, a chapter whose
// last page is half empty, a window resized while the reader is on page forty
// of seventy.
//
// It lives apart from the DOM so those ends can be checked without one.
//
// Two things learned in a harness over a real chapter, both of which this
// arithmetic depends on:
//
//   `column-width` is a hint, not an instruction. Ask for 680px columns in a
//   680px box and the browser may lay out 574px ones — it fits what it likes
//   and distributes the rest. Page geometry computed from the setting was
//   wrong by 15% and nothing said so. `column-count` on a box that is exactly
//   one page wide is exact: the gaps between column starts come out at the
//   page width plus the gutter, every time, in one column and in two.
//
//   The element that owns the columns must not also own the clipping. An
//   element that clips carries its own window with it when it is translated,
//   so the page turns, the view turns with it, and nothing appears to happen.

/** How far the view moves for one page: the page itself, plus the gutter
 *  before the next one.
 *
 *  Note what is *not* here: the number of columns. A page is one box, and
 *  `column-count` divides it — two columns make the page's halves, not two
 *  pages side by side. */
export function pageStep(pageWidth: number, gap: number): number {
  return Math.max(1, pageWidth + gap);
}

/** How many pages a laid-out chapter comes to.
 *
 *  A column layout's width is `pages * pageWidth + (pages - 1) * gap` — every
 *  page but the last is followed by a gutter — so adding one gutter back makes
 *  it divide exactly. It is rounded rather than ceilinged because it *is*
 *  exact: rounding absorbs sub-pixel measurement, ceiling would invent a blank
 *  final page out of a third of a pixel. */
export function pageCount(totalWidth: number, step: number, gap: number): number {
  if (!(step > 0)) return 1;
  return Math.max(1, Math.round((totalWidth + gap) / step));
}

/** Clamp a page into a chapter that has this many. */
export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.round(page)), Math.max(0, pages - 1));
}

/** Where the view sits for a page. */
export function offsetOfPage(page: number, step: number): number {
  return page * step;
}

/** Which page an offset is showing — the nearest, so a view a pixel past a
 *  boundary is still on the page it looks like it is on. */
export function pageOfOffset(offset: number, step: number, pages: number): number {
  if (!(step > 0)) return 0;
  return clampPage(offset / step, pages);
}

/** A chapter's progress, on the same 0–1 scale a scrolled chapter reports, so
 *  a position saved in one mode opens in the other.
 *
 *  A chapter of one page reports 0, which is what the scrolled reader already
 *  reports for a chapter shorter than the window: there is nowhere in it to
 *  be, and the two modes have to agree or a book read in both would jump. */
export function ratioOfPage(page: number, pages: number): number {
  if (pages <= 1) return 0;
  return clampPage(page, pages) / (pages - 1);
}

/** A scrolled vertical (古籍) chapter counted in screens: it has no pages, so
 *  the viewport itself is the unit — which screenful it is on, called a column
 *  because that is what a screenful is in 竖排, one column of text at a time.
 *
 *  Ceiled, not rounded: a trailing half-screen is still a column the reader
 *  can be on. The 0-based column is clamped into the chapter. */
export function columnOf(at: number, view: number, total: number): { col: number; cols: number } {
  const v = view > 0 ? view : 1;
  const cols = Math.max(1, Math.ceil(total / v));
  const col = Math.min(Math.max(0, Math.floor(at / v)), cols - 1);
  return { col, cols };
}

/** And back. Rounds to the nearest page rather than the one containing the
 *  ratio: reopening at 0.51 of a two-page chapter means the second page, which
 *  is where the reader was. */
export function pageOfRatio(ratio: number, pages: number): number {
  if (pages <= 1) return 0;
  const r = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return clampPage(r * (pages - 1), pages);
}

/** Where to land after the geometry changes under the reader — a resized
 *  window, a larger type size, a second column.
 *
 *  By ratio rather than by page number: page 40 of 70 is not page 40 of 30,
 *  and a reader who resized a window has not asked to be moved. */
export function pageAfterReflow(page: number, before: number, after: number): number {
  return pageOfRatio(ratioOfPage(page, before), after);
}
