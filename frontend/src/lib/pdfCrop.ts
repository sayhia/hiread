// Trimming a printed page's margins.
//
// A book laid out for paper carries margins for thumbs and binding. On paper
// they are necessary; on screen they are half the page. In the book this was
// built against the text occupies 51% of each sheet — a hundred points of
// white down either side of a 612-point page — so trimming them makes the type
// 1.4× larger in the same window, which is the difference between reading it
// and squinting at it.
//
// The box is measured from the text's own geometry rather than by scanning
// pixels: the lines are already extracted for the search and the prose view,
// and a rectangle derived from them costs nothing.
//
// One box for the whole book, not one per page. A chapter opening whose text
// stops halfway down has an ink box half the height of the others, and
// trimming each page to its own would make the type jump between pages.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a page contributes: where its text begins and ends, in page units
 *  measured from the bottom left, as PDF space has them. */
export interface PageInk {
  page: number;
  left: number;
  right: number;
  /** Highest inked point. */
  top: number;
  /** Lowest inked point. */
  bottom: number;
}

export interface CropOptions {
  /** Kept outside the text on every side, so a descender or a stray rule is
   *  not shaved off. */
  pad?: number;
  /** How far into the observed margins to trust. Taking the narrowest margin
   *  seen would let one unsampled page with a wide figure be clipped; a low
   *  percentile keeps the crop honest without chasing outliers. */
  percentile?: number;
  /** Below this share of the page, a crop is not worth the surprise. */
  minGain?: number;
}

/** Where a page's text sits, from its lines. */
export function inkOfPage(
  lines: readonly { x: number; right: number; y: number; size: number; page: number; text: string }[],
  page: number,
): PageInk | null {
  let left = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const l of lines) {
    if (l.page !== page || !l.text.trim()) continue;
    left = Math.min(left, l.x);
    right = Math.max(right, l.right);
    top = Math.max(top, l.y + l.size);
    bottom = Math.min(bottom, l.y);
  }
  return Number.isFinite(left) && right > left ? { page, left, right, top, bottom } : null;
}

function at(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
}

/**
 * The box to trim every page to, or null when there is not enough margin to be
 * worth it — a page already set edge to edge should be left alone rather than
 * shaved by a few points for nothing.
 */
export function cropBox(
  inks: readonly PageInk[],
  pageWidth: number,
  pageHeight: number,
  opts: CropOptions = {},
): Box | null {
  const pad = opts.pad ?? 8;
  const p = opts.percentile ?? 0.1;
  const minGain = opts.minGain ?? 0.12;
  // A page with almost nothing on it says nothing about where the margins are.
  const useful = inks.filter((i) => i.right - i.left > pageWidth * 0.2);
  if (useful.length < 2) return null;

  // The narrowest margin any page needs, near enough — measured as the
  // outermost edge the text reaches on each side.
  const left = at(useful.map((i) => i.left), p);
  const right = at(useful.map((i) => i.right), 1 - p);
  const bottom = at(useful.map((i) => i.bottom), p);
  const top = at(useful.map((i) => i.top), 1 - p);

  const x = Math.max(0, left - pad);
  const y = Math.max(0, bottom - pad);
  const width = Math.min(pageWidth - x, right + pad - x);
  const height = Math.min(pageHeight - y, top + pad - y);
  if (width <= 0 || height <= 0) return null;

  // Worth doing only if it buys real room.
  const gain = 1 - (width * height) / (pageWidth * pageHeight);
  return gain >= minGain ? { x, y, width, height } : null;
}
