// Reading without a hand on the keyboard. The page creeps at a set speed and
// carries on into the next chapter, because a book does not stop at a chapter
// boundary — and anything the reader does with the page themselves stops it.

import { onBeforeUnmount, ref, watch, type Ref, toValue, type MaybeRefOrGetter } from "vue";
import { atEnd, metrics, scrollTo, settle, type ReadingAxis } from "../../lib/reading/position";
import { useUi } from "../../stores/ui";

export function useAutoScroll(opts: {
  scrollRef: Ref<HTMLElement | undefined | null>;
  bookId: Ref<number | null | undefined>;
  chapterIndex: Ref<number>;
  hasNext: Ref<boolean>;
  goTo: (index: number, ratio?: number) => void;
  /** Stop the voice when auto-scroll starts. */
  stopSpeech: () => void;
  /** Last page of the last chapter — honour markFinishedAtEnd. */
  onBookEnd?: () => void;
  /** Which way the chapter runs; a paged one runs across. */
  axis?: MaybeRefOrGetter<ReadingAxis>;
}) {
  const ui = useUi();
  const axis = (): ReadingAxis => toValue(opts.axis) ?? "y";
  const autoScrolling = ref(false);
  let autoFrame = 0;
  /** Timestamp of the previous frame, or -1 before the first one. */
  let autoLast = -1;
  /** Sub-pixel carry: at 45px/s a 16ms frame is 0.7px, and a scroll offset is
   *  an integer — dropped every frame, the page would never move. Across a
   *  paged chapter the same carry becomes how long a page is held. */
  let autoCarry = 0;
  /** Set while auto-scroll has asked for the next chapter and is waiting for it
   *  to paint. Cleared by restorePosition via clearAdvancing. */
  let autoAdvancing = false;

  function stepAuto(now: number) {
    if (!autoScrolling.value) return;
    const el = opts.scrollRef.value;
    if (!el) return;
    const dt = autoLast >= 0 ? Math.max(0, Math.min(0.1, (now - autoLast) / 1000)) : 0;
    autoLast = now;
    if (autoAdvancing) {
      autoFrame = requestAnimationFrame(stepAuto);
      return;
    }
    autoCarry += dt * ui.readerAutoSpeed;
    const m = metrics(el, axis());
    // Across a paged chapter there is no continuous motion to make: reading
    // pace becomes how long a page is held. The same setting means the same
    // speed either way — a page of text at 45px/s is the sixteen seconds it
    // would have taken to scroll past.
    // A paged chapter (horizontal or 古籍) holds a page; a scrolled one
    // creeps. Vertical is x-rtl, so asking `=== "x"` left it creeping
    // across pages.
    const paged = ui.readerPageMode === "paged";
    const step = paged ? (autoCarry >= m.view ? m.view : 0) : Math.floor(autoCarry);
    if (step > 0) {
      autoCarry -= step;
      const before = m.at;
      const to = paged ? settle(m, axis(), before + step, "contain", true) : before + step;
      scrollTo(el, axis(), to, false);
      // Did not move: the chapter is finished. Carry on into the next one, or
      // stop at the end of the book. Only once — see autoAdvancing.
      if (metrics(el, axis()).at === before && atEnd(metrics(el, axis()))) {
        if (opts.hasNext.value) {
          autoAdvancing = true;
          autoCarry = 0;
          opts.goTo(opts.chapterIndex.value + 1);
        } else {
          stopAuto();
          opts.onBookEnd?.();
          return;
        }
      }
    }
    autoFrame = requestAnimationFrame(stepAuto);
  }

  function startAuto() {
    if (autoScrolling.value) return;
    opts.stopSpeech();
    autoScrolling.value = true;
    autoLast = -1;
    autoCarry = 0;
    autoAdvancing = false;
    autoFrame = requestAnimationFrame(stepAuto);
  }

  function stopAuto() {
    autoScrolling.value = false;
    autoAdvancing = false;
    if (autoFrame) cancelAnimationFrame(autoFrame);
    autoFrame = 0;
  }

  const toggleAuto = () => (autoScrolling.value ? stopAuto() : startAuto());

  function clearAdvancing() {
    autoAdvancing = false;
  }

  onBeforeUnmount(stopAuto);
  // Leaving the book by hand ends it. A chapter turn auto-scroll itself asked
  // for must keep `autoAdvancing` until restore calls `clearAdvancing` —
  // clearing it on the index change used to let the next frame skip a chapter.
  watch(() => opts.bookId.value, stopAuto);

  return {
    autoScrolling,
    startAuto,
    stopAuto,
    toggleAuto,
    clearAdvancing,
  };
}
