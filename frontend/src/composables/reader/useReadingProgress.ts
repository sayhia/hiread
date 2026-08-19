// Reading position: ratio within the chapter, debounced save, restore after
// paint, and whole-book progress for the top bar.
//
// positionReady stays false until a chapter has actually been laid out and its
// saved position restored. Until then the scroll container is empty and reports
// ratio 0, so writing progress would overwrite where the reader actually was.

import { computed, nextTick, onBeforeUnmount, ref, toValue, type MaybeRefOrGetter, type Ref } from "vue";
import * as api from "../../api";
import {
  hasMoved,
  settle,
  metrics,
  offsetForRatio,
  ratioOf,
  scrollTo,
  type ReadingAxis,
} from "../../lib/reading/position";

export interface ProgressChapter {
  charCount: number;
}

export function useReadingProgress(opts: {
  bookId: Ref<number | null | undefined>;
  chapterIndex: Ref<number>;
  chapters: Ref<ProgressChapter[]>;
  chapterCharCount: Ref<number>;
  bookPercent: Ref<number>;
  scrollRef: Ref<HTMLElement | undefined | null>;
  /** Which way the chapter runs. A paged chapter is a horizontal scroller, and
   *  every question below is the same question on the other axis. */
  axis?: MaybeRefOrGetter<ReadingAxis>;
  /** Whether the chapter is in paged (not scrolled) mode. Only paged mode
   *  should snap restored positions to page boundaries — a scrolled vertical
   *  (古籍) chapter also runs on the x axis but has no page grid to snap to. */
  paged?: MaybeRefOrGetter<boolean>;
  /** Called after restore paints — speech/auto clear their advance flags here. */
  onRestored?: () => void;
  onScrollExtra?: () => void;
}) {
  const axis = (): ReadingAxis => toValue(opts.axis) ?? "y";
  const snapToPage = (): boolean => toValue(opts.paged) ?? false;
  const scrolled = ref(false);
  /** How far through the chapter on screen the reader is. Kept as state rather
   *  than read on demand: a computed cannot see a scroll. */
  const chapterRatio = ref(0);

  /** The ratio to restore once the chapter body has painted. */
  let restoreRatio = 0;
  let saveTimer: number | undefined;
  let positionReady = false;
  /** Bumped whenever a restore is abandoned, so a late `restorePosition`
   *  from the previous chapter cannot park the next one at ratio 0. */
  let restoreGen = 0;

  function setRestoreRatio(ratio: number) {
    restoreRatio = ratio;
  }

  function markNotReady() {
    positionReady = false;
    restoreGen++;
  }

  function isPositionReady() {
    return positionReady;
  }

  function currentRatio(): number {
    const el = opts.scrollRef.value;
    return el ? ratioOf(metrics(el, axis())) : 0;
  }

  /** One scroll pass per frame, sharing a single metrics read: scroll events
   *  fire far faster than frames, and each extra layout read / heading scan
   *  was paying for a frame nobody saw. */
  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const el = opts.scrollRef.value;
      if (!el) return;
      // A remount / page-mode flip parks the scroller at 0. Until restore
      // paints, writing that 0 would overwrite the place we are putting back.
      if (!positionReady) return;
      const m = metrics(el, axis());
      scrolled.value = hasMoved(m);
      chapterRatio.value = ratioOf(m);
      opts.onScrollExtra?.();
      scheduleSave();
    });
  }

  /** Reading time left in this chapter, from the same 300-characters-a-minute
   *  pace as the estimate for the whole. */
  const minutesLeft = computed(() => {
    if (chapterRatio.value >= 0.995) return 0;
    return Math.max(1, Math.round((opts.chapterCharCount.value * (1 - chapterRatio.value)) / 300));
  });

  /** Whole-book progress for the top bar, weighed the same way the database
   *  weighs it: by chapter length, so a long chapter does not fill the bar as
   *  fast as a short one. */
  const livePercent = computed(() => {
    const chs = opts.chapters.value;
    if (!chs.length) return opts.bookPercent.value;
    let total = 0;
    let before = 0;
    for (let i = 0; i < chs.length; i++) {
      const n = chs[i].charCount || 0;
      total += n;
      if (i < opts.chapterIndex.value) before += n;
    }
    if (total <= 0) return opts.bookPercent.value;
    const here = (chs[opts.chapterIndex.value]?.charCount || 0) * chapterRatio.value;
    return Math.min(1, Math.max(0, (before + here) / total));
  });

  /** Progress is written on a debounce: a scroll fires dozens of events a second
   *  and each save is a database write. */
  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveProgress, 600);
  }

  function saveProgress() {
    window.clearTimeout(saveTimer);
    const id = opts.bookId.value;
    if (id == null || !positionReady) return;
    api.saveProgress(id, opts.chapterIndex.value, currentRatio(), 1).catch(() => {
      // A failed position write is not worth a toast: the next scroll retries.
    });
  }

  /** Restore the saved position once the body is on screen. Runs after paint, so
   *  scrollHeight already reflects the chapter. */
  async function restorePosition() {
    const mine = restoreGen;
    await nextTick();
    if (mine !== restoreGen) return;
    const el = opts.scrollRef.value;
    if (!el) return;
    const m = metrics(el, axis());
    scrollTo(el, axis(), restoreRatio > 0 ? settle(m, axis(), offsetForRatio(m, restoreRatio), "nearest", snapToPage()) : 0);
    restoreRatio = 0;
    scrolled.value = hasMoved(metrics(el, axis()));
    chapterRatio.value = currentRatio();
    positionReady = true;
    opts.onRestored?.();
  }

  /** Put the reader back where they were after the geometry changed under
   *  them — a resized window, a larger type size, a second column, a switch
   *  between scrolling and pages.
   *
   *  By ratio, because that is the only thing that survives: a page number
   *  means nothing once the page count has changed, and a scroll offset means
   *  nothing once the text has reflowed. The ratio is already kept as state
   *  for the progress bar, so it is the position from *before* the change —
   *  which is the one to restore. */
  function reflow() {
    const el = opts.scrollRef.value;
    if (!el || !positionReady) return;
    const want = chapterRatio.value;
    const m = metrics(el, axis());
    const to = settle(m, axis(), offsetForRatio(m, want), "nearest", snapToPage());
    // A write that does not move the scroller still costs a layout, and in
    // vertical (古籍) a body-size tick used to bounce scrollLeft every frame.
    if (Math.abs(to - m.at) < 0.5) {
      chapterRatio.value = ratioOf(m);
      return;
    }
    scrollTo(el, axis(), to);
    // Re-reading it keeps the bar honest when the new geometry cannot land on
    // exactly the old ratio — a chapter of three pages has three positions.
    chapterRatio.value = currentRatio();
  }

  /** Mark position ready immediately (e.g. after goTo saved a new chapter). */
  function markReady() {
    positionReady = true;
  }

  onBeforeUnmount(() => {
    window.clearTimeout(saveTimer);
    saveProgress();
  });

  return {
    scrolled,
    chapterRatio,
    minutesLeft,
    livePercent,
    currentRatio,
    onScroll,
    scheduleSave,
    saveProgress,
    restorePosition,
    setRestoreRatio,
    reflow,
    markNotReady,
    markReady,
    isPositionReady,
  };
}
