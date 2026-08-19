// DOM glue for the highlight layer (feature F7).
//
// `anchor.ts` resolves a highlight to a *character range* within the article's
// rendered plain text. This module bridges that abstract range back to the
// live DOM: it walks the body's text nodes, maps plain-text offsets to
// (node, offset) pairs, and wraps the matching run in <mark> elements.
//
// Kept apart from `anchor.ts` so the anchoring algorithm stays DOM-free and
// node-testable; this module is exercised in the running webview.

import { findAnchor, type HighlightAnchor } from "./anchor";
import { highlightBg } from "./highlightColors";
import type { Highlight } from "../types";

/** A text node plus the running plain-text offset at which it starts. */
interface TextSpan {
  node: Text;
  start: number;
}

/**
 * Collect every text node under `root` in document order, each tagged with
 * the cumulative character offset where it begins. The concatenation of the
 * node values is the "plain text" the offsets are measured against.
 *
 * Whether text already inside a <mark> counts depends on who is asking, and
 * the two answers are opposite:
 *
 *   - anchoring a highlight measures against the chapter as it was rendered,
 *     before any marks were laid over it. Counting marked text would shift
 *     every offset after the first highlight, and re-applying would nest
 *     marks inside marks;
 *   - reading it aloud measures against the chapter as it *reads*. Skipping
 *     marked text would have the voice jump silently over precisely the
 *     passages the reader cared enough to mark.
 *
 * `exclude` is an optional CSS selector of subtrees to leave out entirely —
 * bilingual view puts the translation under `.bi-tr`, and reading both sides
 * would speak every sentence twice.
 */
function collectTextSpans(
  root: HTMLElement,
  includeMarked = false,
  exclude?: string,
): { spans: TextSpan[]; text: string } {
  const spans: TextSpan[] = [];
  const parts: string[] = [];
  // `text.length` inside the loop would re-measure the whole buffer per node
  // (O(N²) on a long chapter); track the running length instead and join once.
  let len = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (exclude && parent?.closest(exclude)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (includeMarked) return NodeFilter.FILTER_ACCEPT;
      if (parent && parent.closest("mark[data-hl]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    spans.push({ node: t, start: len });
    parts.push(t.data);
    len += t.data.length;
    n = walker.nextNode();
  }
  return { spans, text: parts.join("") };
}

/** DOM ranges covering the character span [start, end) of the plain text.
 *
 *  A span crossing several text nodes yields one range per node. Unlike
 *  applyHighlights this puts nothing into the document — the caller paints
 *  with them (CSS.highlights) or scrolls to them, which is what reading aloud
 *  needs: the <mark>s belong to the reader's own highlights, and a MutationObserver
 *  is watching for anything else that touches the body.
 *
 *  `exclude` must match whatever readingText was called with, or the ranges
 *  land on the wrong characters.
 */
export function rangesFor(
  root: HTMLElement,
  start: number,
  end: number,
  exclude?: string,
): Range[] {
  // Marks included: these are the offsets readingText produced.
  const { spans } = collectTextSpans(root, true, exclude);
  const out: Range[] = [];
  for (const span of spans) {
    const nodeEnd = span.start + span.node.data.length;
    if (nodeEnd <= start || span.start >= end) continue;
    const localStart = Math.max(0, start - span.start);
    const localEnd = Math.min(span.node.data.length, end - span.start);
    if (localEnd <= localStart) continue;
    const range = document.createRange();
    range.setStart(span.node, localStart);
    range.setEnd(span.node, localEnd);
    out.push(range);
  }
  return out;
}

/** The character offset of whatever is at a point on screen.
 *
 *  Used to start reading aloud from the line the reader is looking at rather
 *  than from the top of the chapter. Estimating it from the scroll ratio does
 *  not survive a chapter with pictures in it — the text is not spread evenly
 *  down the page — so this asks the layout directly.
 *
 *  Returns null where the browser offers neither caret API, and the caller
 *  falls back to the estimate. `exclude` matches readingText's.
 */
export function offsetAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
  exclude?: string,
): number | null {
  // Measured the way the reading text is measured, marks included.
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else {
    return null;
  }
  if (!node || !root.contains(node)) return null;

  for (const span of collectTextSpans(root, true, exclude).spans) {
    if (span.node === node) return span.start + Math.min(offset, span.node.data.length);
  }
  return null;
}

/** The plain text the anchor offsets in stored highlights refer to — the
 *  chapter as it was rendered, before any highlight was laid over it. */
export function plainText(root: HTMLElement, exclude = ".bi-tr"): string {
  return collectTextSpans(root, false, exclude).text;
}

/** The chapter as it reads, highlighted passages and all. What is spoken, and
 *  what rangesFor and offsetAtPoint measure against.
 *
 *  `exclude` drops a subtree (e.g. `.bi-tr` in the bilingual view) so the
 *  voice does not read every sentence twice. */
export function readingText(root: HTMLElement, exclude?: string): string {
  return collectTextSpans(root, true, exclude).text;
}

/**
 * Wrap the character range `[start, end)` of the plain text in <mark>
 * elements. A range crossing several text nodes is split into one <mark> per
 * node so block structure is preserved. Returns the created marks.
 *
 * Uses splitText rather than Range.surroundContents so an earlier span's node
 * reference survives: after `node.splitText(off)` the original node still
 * represents the pre-offset half, with its `start` unchanged. applyHighlights
 * exploits that by laying highlights back-to-front, so a highlight never
 * touches nodes an already-placed one moved.
 */
function wrapRange(
  spans: TextSpan[],
  start: number,
  end: number,
  hl: Highlight,
): HTMLElement[] {
  const marks: HTMLElement[] = [];
  // Binary search to the first span that reaches into the range; spans are
  // ordered by document position, so this skips everything before it instead
  // of walking the whole tree per highlight.
  let lo = 0, hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start + spans[mid].node.data.length <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < spans.length; i++) {
    const span = spans[i];
    const nodeEnd = span.start + span.node.data.length;
    if (span.start >= end) break; // spans past the range

    const localStart = Math.max(0, start - span.start);
    const localEnd = Math.min(span.node.data.length, end - span.start);
    if (localEnd <= localStart) continue;

    const node = span.node;
    // node keeps [0, localStart); `selected` becomes the quoted half, and the
    // tail stays in place for nothing (later highlights were already laid).
    let selected: Text = node;
    if (localStart > 0) selected = node.splitText(localStart);
    // localEnd is a node-relative offset; compare the quoted length against
    // what `selected` actually holds after the first split.
    const quotedLen = localEnd - localStart;
    if (quotedLen < selected.data.length) selected.splitText(quotedLen);

    const mark = document.createElement("mark");
    mark.dataset.hl = String(hl.id);
    mark.style.backgroundColor = highlightBg(hl.color);
    mark.style.borderRadius = "2px";
    mark.style.cursor = "pointer";
    if (hl.note.trim()) mark.dataset.note = "1";
    const parent = selected.parentNode;
    if (!parent) continue;
    parent.insertBefore(mark, selected);
    mark.appendChild(selected);
    marks.push(mark);
  }
  return marks;
}

/**
 * Re-apply every stored highlight to a freshly rendered article body. Existing
 * marks are stripped first so this is idempotent. Returns the highlight ids
 * that could not be anchored (their quote is gone from the current text).
 *
 * The text tree is walked once, all highlights are anchored against that same
 * basis, then laid back-to-front: each wrap leaves its nodes' earlier halves
 * intact, so no highlight re-collects the tree (the old loop re-parsed the
 * whole body per highlight — O(highlights × text nodes)).
 */
export function applyHighlights(root: HTMLElement, highlights: Highlight[]): number[] {
  clearHighlights(root);
  const orphaned: number[] = [];
  if (highlights.length === 0) return orphaned;

  const { spans, text } = collectTextSpans(root, false, ".bi-tr");
  const placed: { hl: Highlight; start: number; end: number }[] = [];
  for (const hl of highlights) {
    const anchor: HighlightAnchor = {
      quote: hl.quote,
      prefix: hl.prefix,
      suffix: hl.suffix,
      textOffset: hl.textOffset,
    };
    const range = findAnchor(text, anchor);
    if (!range) {
      orphaned.push(hl.id);
      continue;
    }
    placed.push({ hl, start: range.start, end: range.end });
  }
  placed.sort((a, b) => b.start - a.start);
  for (const p of placed) wrapRange(spans, p.start, p.end, p.hl);
  return orphaned;
}

/** Remove every highlight <mark>, leaving the body text intact. */
export function clearHighlights(root: HTMLElement): void {
  root.querySelectorAll("mark[data-hl]").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize(); // re-merge the split text nodes
  });
}

/**
 * Map a DOM point (`container`, `offset`) to an offset within the plain text
 * that `collectTextSpans` produces. `atEnd` decides the fallback when the
 * point lands inside a skipped <mark> or past every span: an unresolved start
 * snaps forward (0 or the next span's start), an unresolved end snaps to the
 * tail of the text — so a range that brackets a <mark> still yields a sane,
 * mark-free slice.
 */
function pointToOffset(
  spans: TextSpan[],
  container: Node,
  offset: number,
  atEnd: boolean,
): number {
  for (const span of spans) {
    if (span.node === container) {
      // Common case: the point sits inside this collected text node.
      return span.start + Math.min(offset, span.node.data.length);
    }
  }
  // The point is not inside a collected node (an element boundary, or inside
  // a skipped <mark>). Use document order to place it relative to the spans.
  for (const span of spans) {
    const pos = container.compareDocumentPosition(span.node);
    // The span follows the point — the point falls at this span's start.
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return span.start;
  }
  const last = spans[spans.length - 1];
  return atEnd && last ? last.start + last.node.data.length : 0;
}

/**
 * Describe the current text selection inside `root` as a highlight anchor:
 * its quoted text and plain-text offset. Returns `null` when the selection is
 * empty or falls outside the article body.
 *
 * Both the offset *and* the quote are taken from the same plain text
 * `plainText` / `applyHighlights` use — i.e. text inside existing <mark>
 * elements is skipped. Using `Range.toString()` for the quote would instead
 * include marked text, so a selection that brackets an existing highlight
 * would store a quote that is not a substring of the anchoring basis and could
 * never be re-anchored on reopen.
 */
export function selectionAnchor(
  root: HTMLElement,
): { quote: string; textOffset: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  // A drag in the translation column used to snap onto the original
  // sentence (or the whole chapter). Translation is not highlightable.
  const host = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (host?.closest(".bi-tr")) return null;

  // Resolve both ends of the selection against the mark-free plain text, then
  // slice the quote out of that same basis — so the quote, the offset and the
  // text `findAnchor` searches all agree even across an existing highlight.
  const { spans, text } = collectTextSpans(root, false, ".bi-tr");
  const textOffset = pointToOffset(spans, range.startContainer, range.startOffset, false);
  const endOffset = pointToOffset(spans, range.endContainer, range.endOffset, true);
  const quote = text.slice(textOffset, Math.max(textOffset, endOffset));
  if (!quote.trim()) return null;

  return { quote, textOffset };
}

/** Where to put a popover for a selection or a mark.
 *
 *  Not the bounding box. A box that encloses every line of a selection is the
 *  right shape only while the lines run down one column: put the same
 *  selection across two columns of a page and the box becomes the whole page,
 *  so "just below it" is below the page — measured at (363, 796) on a page
 *  whose foot is at 788, in the bottom-left corner, nowhere near the text.
 *
 *  The last of the client rects is the line the selection ended on, which is
 *  where the reader's hand let go. Down a single column that is the same
 *  answer the box gives; across columns it is the only one that is on screen. */
export function anchorRect(of: Range | Element): DOMRect | null {
  // Not every engine has per-line rects for a Range — jsdom has none at all —
  // and the box is the right answer wherever the lines run down one column.
  const rects = typeof of.getClientRects === "function" ? of.getClientRects() : undefined;
  if (rects && rects.length > 0) return rects[rects.length - 1];
  const box = of.getBoundingClientRect();
  return box.width || box.height ? box : null;
}
