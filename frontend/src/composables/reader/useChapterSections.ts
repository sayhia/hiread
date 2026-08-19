// A "chapter" is whatever the book's own contents calls one, and in a great
// many books that is a whole part with a dozen or more headings inside it —
// this library has chapters of forty-eight. The contents lists the part; the
// reader was then handed a wall of text with no way to get to a section of it.
// The headings are already in the chapter, so they are read straight off the
// page once it has painted.

import { isAcross, metrics, offsetOf, scrollTo, settle, type ReadingAxis } from "../../lib/reading/position";
import { onBeforeUnmount, ref, watch, type Ref, toValue, type MaybeRefOrGetter } from "vue";

export interface ChapterSection {
  /** Index into the heading elements of the body, and the outline's identity. */
  id: number;
  text: string;
  /** 1-4, from h1-h4; the outline indents by it. */
  level: number;
}

export function useChapterSections(
  scrollRef: Ref<HTMLElement | undefined | null>,
  bodyRef: Ref<HTMLElement | undefined | null>,
  /** Which way the chapter runs; a paged one runs across. */
  readingAxis?: MaybeRefOrGetter<ReadingAxis>,
  /** Snap jumps onto a page. Off for scrolled 古籍 — no page grid. */
  paged?: MaybeRefOrGetter<boolean>,
) {
  const axis = (): ReadingAxis => toValue(readingAxis) ?? "y";
  const snapPaged = (): boolean => toValue(paged) ?? false;
  const sections = ref<ChapterSection[]>([]);
  /** The section the reader is currently inside — the last heading above the top
   *  of the viewport. -1 before the first one. */
  const activeSection = ref(-1);
  let headingEls: HTMLElement[] = [];
  /** Each heading's distance from the top of the scrollable content. Measured
   *  from rectangles rather than offsetTop, which is relative to whichever
   *  ancestor happens to be positioned; cached, because a chapter can hold
   *  dozens of headings and scrolling must not re-measure them all. */
  let headingTops: number[] = [];
  let topsStale = true;

  function readSections() {
    const body = bodyRef.value;
    if (!body) {
      headingEls = [];
      sections.value = [];
      return;
    }
    headingEls = Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3, h4"));
    sections.value = headingEls.map((el, id) => ({
      id,
      text: (el.textContent ?? "").trim(),
      level: Number(el.tagName[1]),
    }));
    // A single heading is the chapter's own title repeated: an outline of one
    // entry is noise, not navigation.
    if (sections.value.length < 2) sections.value = [];
    activeSection.value = -1;
    topsStale = true;
    trackSection();
  }

  function measureHeadings() {
    const el = scrollRef.value;
    if (!el) return;
    headingTops = headingEls.map((h) => offsetOf(el, h, axis()));
    topsStale = false;
  }

  /** Which heading the reader has scrolled past. Cheap enough to run on scroll:
   *  it is a walk over a handful of cached elements, no layout reads beyond
   *  their offsets. */
  function trackSection() {
    const el = scrollRef.value;
    if (!el || sections.value.length === 0) return;
    if (topsStale) measureHeadings();
    const top = metrics(el, axis()).at + 8;
    let current = -1;
    for (let i = 0; i < headingTops.length; i++) {
      if (headingTops[i] <= top) current = i;
      else break;
    }
    activeSection.value = current;
  }

  /** Jump to a heading of the chapter on screen. */
  function goToSection(id: number) {
    const el = scrollRef.value;
    if (!el || !headingEls[id]) return;
    if (topsStale) measureHeadings();
    const ax = axis();
    const m = metrics(el, ax);
    scrollTo(
      el,
      ax,
      isAcross(ax)
        ? settle(m, ax, headingTops[id], "contain", snapPaged())
        : Math.max(0, headingTops[id] - 12),
      true,
    );
  }

  function markTopsStale() {
    topsStale = true;
  }

  // Images resolve after the chapter paints, and the typography controls change
  // the measure while it is open: either moves every heading. Re-measure lazily
  // rather than eagerly — nothing needs the numbers until the next scroll.
  let bodyResize: ResizeObserver | undefined;
  watch(bodyRef, (el) => {
    bodyResize?.disconnect();
    bodyResize = undefined;
    if (!el || typeof ResizeObserver === "undefined") return;
    bodyResize = new ResizeObserver(() => {
      topsStale = true;
    });
    bodyResize.observe(el);
  });
  onBeforeUnmount(() => bodyResize?.disconnect());

  return {
    sections,
    activeSection,
    readSections,
    trackSection,
    goToSection,
    markTopsStale,
  };
}
