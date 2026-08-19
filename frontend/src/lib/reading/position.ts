// Where the reader is in a chapter, without caring which way it runs.
//
// A scrolled chapter runs down and a paged one runs across, and that is very
// nearly the whole difference between them. Progress is how far along the
// scroller is; turning a page is moving by one viewport; the end of the
// chapter is the end of the scroller. Seven places in the reader ask those
// questions — the progress bar, the section tracker, auto-scroll, the voice,
// in-book links, the keyboard, the chrome that hides as you read — and every
// one of them used to ask `scrollTop`.
//
// So this is not two implementations. It is one, over an axis. A paged chapter
// is a horizontal scroller whose viewport is exactly one page plus one gutter
// wide, which makes a page turn a scroll of one viewport and lands every turn
// on a column boundary. Measured over a real chapter: 72 pages by scrolling,
// 72 columns laid out, the two agreeing exactly.
//
// The element is passed in per call rather than held, because the reader
// swaps it as chapters open and a captured one goes stale.

export type ReadingAxis = "y" | "x" | "x-rtl";

/** Runs across the page — paged, or vertical (古籍). */
export function isAcross(axis: ReadingAxis): boolean {
  return axis !== "y";
}

/** A vertical (古籍) chapter: reading starts on the right, so the physical
 *  left of the scroller is the end. `at` is still distance from the start. */
export function isRtlX(axis: ReadingAxis): boolean {
  return axis === "x-rtl";
}

/** How an RTL / vertical-rl scroller reports `scrollLeft`.
 *
 *  `default`  — 0 is the physical left (the end). Chrome, modern Safari.
 *  `negative` — 0 is the start; the value goes negative toward the end.
 *  `reverse`  — 0 is the start; the value grows toward the end. Classic WebKit,
 *               and jsdom, which has no real RTL overflow to measure.
 *
 *  Probed once: the convention is a property of the engine, not the chapter. */
type RtlScroll = "default" | "negative" | "reverse";
let rtlScroll: RtlScroll | null = null;

/** Test hook: the probe is an engine property and jsdom has none. */
export function setRtlScrollTypeForTest(v: RtlScroll | null): void {
  rtlScroll = v;
}

export function rtlScrollType(): RtlScroll {
  if (rtlScroll) return rtlScroll;
  if (typeof document === "undefined" || !document.body) return "reverse";
  const scroller = document.createElement("div");
  const inner = document.createElement("div");
  scroller.appendChild(inner);
  scroller.style.cssText =
    "position:absolute;left:-9999px;width:10px;height:10px;overflow:scroll;direction:rtl";
  inner.style.width = "20px";
  inner.style.height = "1px";
  document.body.appendChild(scroller);
  // No layout (jsdom): treat it as reverse so tests that write scrollLeft as
  // a logical offset keep meaning what they say.
  if (scroller.scrollWidth <= scroller.clientWidth) {
    document.body.removeChild(scroller);
    return (rtlScroll = "reverse");
  }
  if (scroller.scrollLeft > 0) rtlScroll = "default";
  else {
    scroller.scrollLeft = 1;
    rtlScroll = scroller.scrollLeft === 0 ? "negative" : "reverse";
  }
  document.body.removeChild(scroller);
  return rtlScroll;
}

function maxX(el: Element): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

/** Physical scrollLeft ↔ distance from the reading start. */
function logicalX(el: Element): number {
  const raw = el.scrollLeft;
  switch (rtlScrollType()) {
    case "default":
      return maxX(el) - raw;
    case "negative":
      return -raw;
    default:
      return raw;
  }
}

function physicalX(el: Element, at: number): number {
  switch (rtlScrollType()) {
    case "default":
      return maxX(el) - at;
    case "negative":
      return -at;
    default:
      return at;
  }
}

/** The scroller's three numbers on whichever axis it runs. */
export interface AxisMetrics {
  /** How far along it is. */
  readonly at: number;
  /** How much is shown at once. */
  readonly view: number;
  /** How much there is in total. */
  readonly total: number;
}

export function metrics(el: Element, axis: ReadingAxis): AxisMetrics {
  if (axis === "y") {
    return { at: el.scrollTop, view: el.clientHeight, total: el.scrollHeight };
  }
  return {
    at: isRtlX(axis) ? logicalX(el) : el.scrollLeft,
    view: el.clientWidth,
    total: el.scrollWidth,
  };
}

/** The furthest the scroller can go. */
export function span(m: AxisMetrics): number {
  return Math.max(0, m.total - m.view);
}

/** How far through the chapter, 0–1.
 *
 *  A chapter that fits in one view reports 0 rather than 1: there is nowhere
 *  in it to be. Both modes have to answer this the same way or a book read in
 *  both would jump on every short chapter. */
export function ratioOf(m: AxisMetrics): number {
  const max = span(m);
  return max > 0 ? Math.min(1, Math.max(0, m.at / max)) : 0;
}

/** Where to put the scroller for a ratio. */
export function offsetForRatio(m: AxisMetrics, ratio: number): number {
  const max = span(m);
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return max > 0 ? r * max : 0;
}

/** Has the reader moved off the start — what the toolbar's shadow asks. */
export function hasMoved(m: AxisMetrics, slack = 4): boolean {
  return m.at > slack;
}

export function atStart(m: AxisMetrics, slack = 2): boolean {
  return m.at <= slack;
}

/** At the end of the chapter. The slack is generous on purpose: a scroller
 *  one sub-pixel short of its end is at its end to a reader, and the chapter
 *  dock appearing depends on this being true when it looks true. */
export function atEnd(m: AxisMetrics, slack = 2): boolean {
  return m.at + m.view >= m.total - slack;
}

/** How far to move for one press of Space or one page turn.
 *
 *  Down a scrolled chapter that is a screen less a couple of lines, so the
 *  reader keeps their place across the jump; across a paged one it is exactly
 *  one page, because a page that overlapped the last one would not be a page. */
export function stepFor(m: AxisMetrics, axis: ReadingAxis, lineHeight: number): number {
  return isAcross(axis) ? m.view : Math.max(120, m.view - 2 * lineHeight);
}

/** Where a position can actually be.
 *
 *  Down a scrolled chapter, anywhere. Across a paged one, only on a page: the
 *  viewport is exactly one page and one gutter wide, so the positions that
 *  exist are multiples of it, and a jump landing between two of them shows
 *  half of each — the thing the geometry was measured to avoid.
 *
 *  Vertical (古籍) scrolled chapters also run on the x axis; they have no
 *  page grid, but a screenful is still the natural unit for *bringing
 *  something into view* — the column that contains it, the way a page
 *  contains it in paged mode. Restoring a remembered place, by contrast,
 *  wants the exact offset the reader was at: pass snap=false to skip the
 *  grid there.
 *
 *  Two ways to mean it, and they are not interchangeable. Bringing something
 *  into view wants the page that *contains* it, because rounding up would
 *  scroll past the very thing being shown. Putting the reader back at a
 *  remembered place wants the *nearest* page, which is what the page number
 *  beside it is counted with. */
export function settle(
  m: AxisMetrics,
  axis: ReadingAxis,
  to: number,
  mode: "contain" | "nearest" = "nearest",
  snap = true,
): number {
  const at = Math.min(span(m), Math.max(0, Number.isFinite(to) ? to : 0));
  if (axis === "y" || !(m.view > 0) || !snap) return at;
  // Sub-pixel viewports leave a 1px sliver of the next column — a hairline
  // tear when the page is sitting still.
  const view = Math.round(m.view);
  const pages = mode === "contain" ? Math.floor((at + 1e-6) / view) : Math.round(at / view);
  return Math.min(span(m), Math.max(0, pages * view));
}

/** Write a position back, on the right axis.
 *
 *  A move with no animation is an assignment: it takes effect before the next
 *  line runs, needs nothing of the engine, and cannot be quietly dropped —
 *  jsdom has no `Element.scrollTo` at all, so a restore routed through it
 *  would do nothing in every test and pass. Only a smooth move needs the
 *  method, and only where there is one. */
export function scrollTo(el: Element, axis: ReadingAxis, to: number, smooth = false): void {
  const left = isRtlX(axis) ? physicalX(el, to) : to;
  if (smooth && typeof el.scrollTo === "function") {
    el.scrollTo(
      axis === "y"
        ? { top: to, left: 0, behavior: "smooth" }
        : { left, top: 0, behavior: "smooth" },
    );
    return;
  }
  if (axis === "y") {
    if (el.scrollLeft) el.scrollLeft = 0;
    el.scrollTop = to;
  } else {
    if (el.scrollTop) el.scrollTop = 0;
    el.scrollLeft = left;
  }
}

/** Where an element sits, measured from the start of the scroller's content
 *  rather than from the viewport — the number to scroll to in order to bring
 *  it to the leading edge. */
export function offsetOf(el: Element, child: Element, axis: ReadingAxis): number {
  const outer = el.getBoundingClientRect();
  const inner = child.getBoundingClientRect();
  if (axis === "y") return inner.top - outer.top + el.scrollTop;
  if (!isRtlX(axis)) return inner.left - outer.left + el.scrollLeft;
  // Distance from the reading start (the right of the content) to the
  // child's own start (its right edge).
  switch (rtlScrollType()) {
    case "default":
      return el.scrollWidth - (inner.right - outer.left + el.scrollLeft);
    case "negative":
      return outer.right - inner.right - el.scrollLeft;
    default:
      return outer.right - inner.right + el.scrollLeft;
  }
}

/** Which of these is at the leading edge of the view — the section the reader
 *  is in. Returns -1 when none of them has been reached. */
export function leadingIndex(
  el: Element,
  children: readonly Element[],
  axis: ReadingAxis,
  slack = 8,
): number {
  const m = metrics(el, axis);
  let found = -1;
  for (let i = 0; i < children.length; i++) {
    if (offsetOf(el, children[i], axis) <= m.at + slack) found = i;
    else break;
  }
  return found;
}
