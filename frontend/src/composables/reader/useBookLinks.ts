// data-link is "<path>", "<path>#<fragment>" or "#<fragment>": the path is
// what a chapter records as its href, and the fragment is an id in that
// chapter's markup. Most of a book's links are footnote markers, so the
// fragment is usually the whole point — landing at the top of the chapter the
// note happens to live in is not following the link.

import { ref, type Ref, toValue, type MaybeRefOrGetter } from "vue";
import {
  isAcross,
  metrics,
  offsetForRatio,
  offsetOf,
  scrollTo,
  settle,
  type ReadingAxis,
} from "../../lib/reading/position";

export interface BookChapterHref {
  href: string | null;
}

export function useBookLinks(opts: {
  scrollRef: Ref<HTMLElement | undefined | null>;
  bodyRef: Ref<HTMLElement | undefined | null>;
  /** Which way the chapter runs; a paged one runs across. */
  axis?: MaybeRefOrGetter<ReadingAxis>;
  /** Snap a remembered place onto a page. Off for a scrolled vertical (古籍)
   *  chapter: it runs across but has no page grid, and rounding a footnote
   *  return onto the nearest screenful left the reader a column off. */
  paged?: MaybeRefOrGetter<boolean>;
  chapterIndex: Ref<number>;
  chapters: Ref<BookChapterHref[]>;
  chapterTitle: Ref<string>;
  currentRatio: () => number;
  goTo: (index: number, ratio?: number) => void;
  /** Stop speech and auto-scroll before a jump, so they do not pull off the note. */
  yieldMotion?: () => void;
}) {
  const axis = (): ReadingAxis => toValue(opts.axis) ?? "y";
  const snapPaged = (): boolean => toValue(opts.paged) ?? false;
  /** Set while a jump is pending, for the chapter that is about to paint. */
  let pendingFragment = "";
  /** Where the reader was before the last jump, so they can get back. A footnote
   *  you cannot return from is a one-way trip out of the sentence you were
   *  reading. */
  const returnTo = ref<{ index: number; ratio: number; label: string } | null>(null);

  function followLink(dataLink: string) {
    if (!dataLink) return;
    opts.yieldMotion?.();
    const hash = dataLink.indexOf("#");
    const path = hash >= 0 ? dataLink.slice(0, hash) : dataLink;
    const fragment = hash >= 0 ? dataLink.slice(hash + 1) : "";

    const here = {
      index: opts.chapterIndex.value,
      ratio: opts.currentRatio(),
      label: opts.chapterTitle.value,
    };

    // No path, or this chapter's own: the target is on the page already.
    const hereHref = opts.chapters.value[opts.chapterIndex.value]?.href;
    if (
      path === "" ||
      (hereHref && (hereHref === path || hrefKey(hereHref) === hrefKey(path)))
    ) {
      if (fragment && scrollToFragment(fragment)) returnTo.value = here;
      return;
    }
    const idx = opts.chapters.value.findIndex(
      (ch) => ch.href && (ch.href === path || hrefKey(ch.href) === hrefKey(path)),
    );
    if (idx < 0) return; // not a chapter of its own — an image, a stylesheet
    returnTo.value = here;
    pendingFragment = fragment;
    opts.goTo(idx);
  }

  /** Scroll an id in the chapter on screen into view. False when it is not
   *  there, so the caller does not offer a way back from a jump that never
   *  happened. */
  function scrollToFragment(id: string): boolean {
    const el = opts.scrollRef.value;
    const body = opts.bodyRef.value;
    if (!el || !body) return false;
    // Looked up by scanning rather than by selector: the id comes from the book,
    // so it can be anything — a leading digit, a dot, a colon — and building a
    // selector out of it needs escaping that not every webview has.
    const want = decodeFrag(id);
    const target = Array.from(body.querySelectorAll<HTMLElement>("[id], [name]")).find(
      (n) => n.id === id || n.id === want || n.getAttribute("name") === id || n.getAttribute("name") === want,
    );
    if (!target) return false;
    // The page the target is on, not an offset twelve pixels above it: across
    // a paged chapter there is no such place as twelve pixels above.
    const ax = axis();
    const m = metrics(el, ax);
    const to = isAcross(ax)
      ? settle(m, ax, offsetOf(el, target, ax), "contain", snapPaged())
      : Math.max(0, offsetOf(el, target, "y") - 12);
    scrollTo(el, ax, to, true);
    return true;
  }

function decodeFrag(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function hrefKey(h: string): string {
  const decoded = decodeFrag(h);
  return decoded.split("/").pop() || decoded;
}

  /** Back to where the link was followed from. */
  function goBackFromLink() {
    opts.yieldMotion?.();
    const to = returnTo.value;
    returnTo.value = null;
    if (!to) return;
    if (to.index === opts.chapterIndex.value) {
      const el = opts.scrollRef.value;
      if (el) {
        const m = metrics(el, axis());
        scrollTo(el, axis(), settle(m, axis(), offsetForRatio(m, to.ratio), "nearest", snapPaged()), true);
      }
      return;
    }
    opts.goTo(to.index, to.ratio);
  }

  function consumePendingFragment() {
    if (!pendingFragment) return;
    scrollToFragment(pendingFragment);
    pendingFragment = "";
  }

  return {
    returnTo,
    followLink,
    goBackFromLink,
    scrollToFragment,
    consumePendingFragment,
  };
}
