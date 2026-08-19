// Keyboard and click-to-page for the text reading screen.
//
// Space is the key people actually read with; the scroller is a div, so the
// browser only pages it when it happens to hold focus. Paging keeps two lines
// of overlap so the eye has somewhere to land, and at the end of a chapter it
// turns the page rather than stopping.

import { onBeforeUnmount, onMounted, type Ref, toValue, type MaybeRefOrGetter } from "vue";
import {
  atEnd as isAtEnd,
  atStart as isAtStart,
  isAcross,
  metrics,
  scrollTo,
  settle,
  span,
  stepFor,
  type ReadingAxis,
} from "../../lib/reading/position";
import { pageDirFromSide } from "../../lib/reading/direction";
import { useUi } from "../../stores/ui";

/** The highlight popover closes on mousedown; the click that follows would
 *  otherwise turn the page. Call this from the popover's dismiss path. */
let swallowPageUntil = 0;
export function swallowPageClick(ms = 400): void {
  swallowPageUntil = Date.now() + ms;
}

/** True while a dismiss-click should not also turn the page. */
export function pageClickSwallowed(): boolean {
  return Date.now() < swallowPageUntil;
}

export function useTextReaderInput(opts: {
  scrollRef: Ref<HTMLElement | undefined | null>;
  lineHeight: () => number;
  /** Which way the chapter runs; a paged one runs across. */
  axis?: MaybeRefOrGetter<ReadingAxis>;
  hasPrev: Ref<boolean>;
  hasNext: Ref<boolean>;
  chapterIndex: Ref<number>;
  /** Open panels that should swallow Escape / block click-paging. */
  panels: {
    tocOpen: Ref<boolean>;
    typeOpen: Ref<boolean>;
    transOpen: Ref<boolean>;
    summaryOpen: Ref<boolean>;
    moreOpen?: Ref<boolean>;
  };
  speech: {
    supported: boolean;
    speaking: Ref<boolean>;
    skip: (by: 1 | -1) => void;
  };
  autoScrolling: Ref<boolean>;
  yieldMotion: () => void;
  stopAuto: () => void;
  stopSpeech: () => void;
  goTo: (index: number, ratio?: number) => void;
  next: () => void;
  prev: () => void;
  toggleAuto: () => void;
  toggleSpeech: () => void;
  toggleTranslation: () => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const axis = (): ReadingAxis => toValue(opts.axis) ?? "y";
  /** Pages mode is left/right turning. The click-paging pref is the extra
   *  opt-in for a scrolling chapter, where a click is normally a selection. */
  const clickPaging = () => ui.readerClickPaging || ui.readerPageMode === "paged";

  /** One screenful, less the overlap that keeps a reader's place. */
  function page(dir: 1 | -1) {
    opts.yieldMotion();
    const el = opts.scrollRef.value;
    if (!el) return;
    const m = metrics(el, axis());
    const step = stepFor(m, axis(), opts.lineHeight());
    const atEnd = isAtEnd(m);
    const atStart = isAtStart(m);
    if (dir === 1 && atEnd) {
      opts.next();
      return;
    }
    if (dir === -1 && atStart && opts.hasPrev.value) {
      opts.goTo(opts.chapterIndex.value - 1, 1);
      return;
    }
    // m was read at the top of this same synchronous tick and nothing in
    // between can scroll el (next/goTo return early) — reading the layout a
    // second time would be a duplicate metrics() call per page turn. Keep it
    // synchronous: an await here would let a smooth scroll advance and stale
    // m.at.
    let to = m.at + dir * step;
    if (ui.readerPageMode === "paged") {
      to = settle(m, axis(), to, "contain", true);
    }
    // A smooth slide across CSS columns shows the seam mid-flight —
    // half of this page and half of the next. A page turn is a cut.
    scrollTo(el, axis(), to, ui.readerPageMode !== "paged");
  }

  // ── the wheel, when the chapter runs across ──────────────────────────────
  // A horizontal scroller and a vertical wheel is a bargain between engines
  // that some of them keep. Rather than find out per webview, the gesture is
  // taken and turned into what it means here: one flick, one page.
  //
  // A trackpad delivers a flick as a burst of events with inertia trailing
  // behind it, so a page per event would turn thirty. The gesture is over when
  // the events stop for a moment; the first event after that quiet is the next
  // turn.
  let lastWheelAt = 0;
  const GESTURE_GAP = 280;

  function onWheel(ev: WheelEvent) {
    if (!isAcross(axis())) return;
    // Pinch-zoom arrives as a ctrl/meta-wheel; it is not a page turn.
    if (ev.ctrlKey || ev.metaKey) return;
    const target = ev.target as HTMLElement | null;
    // A picture of a page (code, a table, a popover) keeps its own scroll.
    if (target?.closest("pre, textarea, .hl-popover, .tr-pop, .chapter-summary, .rp, .tb-more-menu")) return;
    const ax = axis();
    // Shift+wheel is a free skim along the chapter, not a page turn. It
    // has to ride the same axis the chapter does — a vertical (古籍) one
    // is x-rtl, and writing "x" here sent the skim the wrong way.
    if (ev.shiftKey) {
      ev.preventDefault();
      const el = opts.scrollRef.value;
      if (!el) return;
      const m = metrics(el, ax);
      const dx = ev.deltaX;
      const dy = ev.deltaY;
      const useX = Math.abs(dx) > Math.abs(dy);
      let delta = useX ? dx : dy;
      // Physical deltaX on an RTL scroller is the opposite of logical `at`.
      if (useX && ax === "x-rtl") delta = -delta;
      scrollTo(el, ax, Math.min(span(m), Math.max(0, m.at + delta)), false);
      return;
    }
    // The scroller cannot scroll on the axis this event is about, so the
    // browser would either do nothing with it or translate it into a slide
    // that stops between two pages. Neither is a page turn.
    ev.preventDefault();
    const at = ev.timeStamp || Date.now();
    const fresh = at - lastWheelAt > GESTURE_GAP;
    if (!fresh) {
      // Inertia after a flick is the same gesture; keep the gate closed.
      lastWheelAt = at;
      return;
    }
    const dx = ev.deltaX;
    const dy = ev.deltaY;
    // A sideways flick on a 古籍 page is a page turn in reading order:
    // swipe left (deltaX < 0) goes on, the way the next column sits.
    // A vertical flick is still "down = forward", matching Space.
    if (ui.readerOrientation === "vertical" && Math.abs(dx) >= Math.abs(dy)) {
      if (Math.abs(dx) < 4) return;
      lastWheelAt = at;
      page(dx < 0 ? 1 : -1);
      return;
    }
    const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    if (Math.abs(d) < 4) return;
    lastWheelAt = at;
    page(d > 0 ? 1 : -1);
  }

  // A finger-flick on a 古籍 page is the same bargain as the wheel: one
  // swipe, one column. Bound only while the chapter runs across — a
  // scrolled horizontal chapter already has native vertical scroll.
  let touchAt: { x: number; y: number; t: number } | null = null;

  function onTouchStart(ev: TouchEvent) {
    opts.yieldMotion();
    if (!isAcross(axis())) return;
    const t = ev.changedTouches[0];
    if (!t) return;
    touchAt = { x: t.clientX, y: t.clientY, t: ev.timeStamp || Date.now() };
  }

  function onTouchEnd(ev: TouchEvent) {
    if (!touchAt || !isAcross(axis())) {
      touchAt = null;
      return;
    }
    const t = ev.changedTouches[0];
    const start = touchAt;
    touchAt = null;
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = (ev.timeStamp || Date.now()) - start.t;
    if (dt > 700) return;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest("a, img, button, input, pre, table, .toc, .tr-pop, .hl-popover, .chapter-summary, .rp")) {
      return;
    }
    ev.preventDefault();
    // Swipe left (content follows the finger toward the end) goes on, in
    // both a Western page and a 古籍 column.
    page(dx < 0 ? 1 : -1);
  }

  function onTouchCancel() {
    touchAt = null;
  }

  function onTouchMove(ev: TouchEvent) {
    if (!isAcross(axis()) || !touchAt) return;
    const t = ev.touches[0] ?? ev.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchAt.x;
    const dy = t.clientY - touchAt.y;
    // A 1px jitter must not kill taps, links, or a drag-select. Only
    // claim the gesture once it is clearly a sideways swipe.
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    ev.preventDefault();
  }

  /** A few lines, for the arrow keys. */
  function nudge(dir: 1 | -1) {
    opts.yieldMotion();
    const el = opts.scrollRef.value;
    if (!el) return;
    // Across a paged chapter there is no such thing as a few lines: the arrow
    // keys turn the page, which is the only place there is to go.
    if (axis() === "x-rtl" && ui.readerPageMode !== "paged") {
      const m = metrics(el, axis());
      if ((dir === 1 && isAtEnd(m)) || (dir === -1 && isAtStart(m))) {
        page(dir);
        return;
      }
      scrollTo(el, axis(), m.at + dir * opts.lineHeight(), true);
      return;
    }
    if (isAcross(axis())) { page(dir); return; }
    const m = metrics(el, axis());
    if ((dir === 1 && isAtEnd(m)) || (dir === -1 && isAtStart(m))) {
      page(dir);
      return;
    }
    scrollTo(el, axis(), m.at + dir * opts.lineHeight() * 3, true);
  }

  // Off by default: on a desktop, a click in the text is how a selection starts.
  // With it on, a 64px strip on each side turns the page — left/right as
  // the writing direction reads them, so a 古籍 column goes forward from the
  // left the way a horizontal page goes forward from the right.
  function edgeOf(ev: MouseEvent): "left" | "right" | null {
    const el = opts.scrollRef.value;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const x = ev.clientX - box.left;
    const edge = 64;
    if (x <= edge) return "left";
    if (x >= box.width - edge) return "right";
    return null;
  }

  // A click that began as a drag is a selection, not a page turn — even
  // when the selection has already collapsed by the time click fires.
  let pointerAt: { x: number; y: number } | null = null;

  function onReaderPointerDown(ev: PointerEvent) {
    pointerAt = { x: ev.clientX, y: ev.clientY };
  }

  function onReaderClick(ev: MouseEvent) {
    if (!clickPaging()) return;
    if (Date.now() < swallowPageUntil) return;
    const el = opts.scrollRef.value;
    if (!el) return;
    if (pointerAt) {
      const moved = Math.hypot(ev.clientX - pointerAt.x, ev.clientY - pointerAt.y);
      pointerAt = null;
      if (moved > 6) return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest("a, img, button, input, mark, .toc, .tr-pop, .chapter-summary, .link-back, .chapter-nav, .tr-toggle, .tb-more-menu")) return;
    // A click that is putting something away is not a click for turning the page.
    if (
      opts.panels.tocOpen.value ||
      opts.panels.typeOpen.value ||
      opts.panels.transOpen.value ||
      opts.panels.summaryOpen.value ||
      opts.panels.moreOpen?.value
    ) {
      return;
    }
    if (document.querySelector(".hl-popover")) return;

    const side = edgeOf(ev);
    if (side) page(pageDirFromSide(side, ui.readerOrientation));
  }

  function onReaderMove(ev: MouseEvent) {
    const el = opts.scrollRef.value;
    if (!el) return;
    if (
      !clickPaging() ||
      opts.panels.tocOpen.value ||
      opts.panels.typeOpen.value ||
      opts.panels.transOpen.value ||
      opts.panels.summaryOpen.value ||
      opts.panels.moreOpen?.value ||
      document.querySelector(".image-viewer, .hl-popover")
    ) {
      if (el.dataset.pageEdge) delete el.dataset.pageEdge;
      return;
    }
    const side = edgeOf(ev);
    if (side) el.dataset.pageEdge = side;
    else delete el.dataset.pageEdge;
  }

  function onReaderLeave() {
    const el = opts.scrollRef.value;
    if (el?.dataset.pageEdge) delete el.dataset.pageEdge;
  }

  function onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target?.isContentEditable) return;
    if (target instanceof Element && target.closest("img[data-res], figure")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The contents sheet, type panel, and translation popover keep their
    // own arrows / Home / End; paging the chapter under them is a fight.
    if (target instanceof Element && target.closest(".toc, .tr-pop, .rp, .chapter-summary, .tb-more-menu")) return;
    if (document.querySelector(".image-viewer, .hl-popover, .settings-backdrop, .cp-backdrop, .modal-backdrop, .ctx-menu, .tag-picker")) return;
    const panelOpen =
      opts.panels.tocOpen.value ||
      opts.panels.typeOpen.value ||
      opts.panels.transOpen.value ||
      opts.panels.summaryOpen.value ||
      opts.panels.moreOpen?.value === true;
    const pagingKey =
      e.key === " " ||
      e.key === "PageDown" ||
      e.key === "PageUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "Home" ||
      e.key === "End" ||
      e.key === "j" ||
      e.key === "k";
    if (panelOpen && pagingKey) return;
    if (e.repeat && pagingKey) {
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case " ":
      case "PageDown":
        e.preventDefault();
        page(e.shiftKey ? -1 : 1);
        break;
      case "PageUp":
        e.preventDefault();
        page(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        nudge(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        nudge(-1);
        break;
      case "Home":
        e.preventDefault();
        opts.yieldMotion();
        if (opts.scrollRef.value) {
          const el = opts.scrollRef.value;
          const m = metrics(el, axis());
          const to = ui.readerPageMode === "paged" ? settle(m, axis(), 0, "nearest", true) : 0;
          scrollTo(el, axis(), to, ui.readerPageMode !== "paged");
        }
        break;
      case "End":
        e.preventDefault();
        opts.yieldMotion();
        // The end of the chapter is the end of the scroller, on whichever
        // axis it runs — a vertical (古籍) or paged chapter ends across.
        if (opts.scrollRef.value) {
          const el = opts.scrollRef.value;
          const m = metrics(el, axis());
          const end = span(m);
          const to = ui.readerPageMode === "paged" ? settle(m, axis(), end, "nearest", true) : end;
          scrollTo(el, axis(), to, ui.readerPageMode !== "paged");
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        // Across a chapter the arrows turn the page, the way they do in a
        // PDF — skipping a whole chapter was the key people read with
        // doing the one thing they did not mean. At either end, page()
        // already walks into the next chapter. Down a scrolled chapter
        // there is no page, so the arrow still turns the chapter.
        if (isAcross(axis())) page(pageDirFromSide("right", ui.readerOrientation));
        else opts.next();
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isAcross(axis())) page(pageDirFromSide("left", ui.readerOrientation));
        else opts.prev();
        break;
      case "j":
        e.preventDefault();
        if (isAcross(axis())) page(1);
        else opts.next();
        break;
      case "k":
        e.preventDefault();
        if (isAcross(axis())) page(-1);
        else opts.prev();
        break;
      case "c":
        e.preventDefault();
        opts.panels.typeOpen.value = false;
        opts.panels.transOpen.value = false;
        if (opts.panels.moreOpen) opts.panels.moreOpen.value = false;
        opts.panels.tocOpen.value = !opts.panels.tocOpen.value;
        break;
      case "i":
        e.preventDefault();
        opts.panels.tocOpen.value = false;
        opts.panels.typeOpen.value = false;
        opts.panels.transOpen.value = false;
        if (opts.panels.moreOpen) opts.panels.moreOpen.value = false;
        opts.panels.summaryOpen.value = !opts.panels.summaryOpen.value;
        break;
      case "a":
        e.preventDefault();
        opts.panels.tocOpen.value = false;
        opts.panels.transOpen.value = false;
        if (opts.panels.moreOpen) opts.panels.moreOpen.value = false;
        opts.panels.typeOpen.value = !opts.panels.typeOpen.value;
        break;
      case "t":
        e.preventDefault();
        opts.panels.tocOpen.value = false;
        opts.panels.typeOpen.value = false;
        if (opts.panels.moreOpen) opts.panels.moreOpen.value = false;
        opts.toggleTranslation();
        break;
      case "s":
        e.preventDefault();
        opts.toggleAuto();
        break;
      case "r":
        if (!opts.speech.supported) break;
        e.preventDefault();
        opts.toggleSpeech();
        break;
      case "[":
        if (!opts.speech.speaking.value) break;
        e.preventDefault();
        opts.speech.skip(-1);
        break;
      case "]":
        if (!opts.speech.speaking.value) break;
        e.preventDefault();
        opts.speech.skip(1);
        break;
      case "Escape":
        onReaderLeave();
        if (opts.speech.speaking.value) opts.stopSpeech();
        else if (opts.autoScrolling.value) opts.stopAuto();
        else if (opts.panels.moreOpen?.value) opts.panels.moreOpen.value = false;
        else if (opts.panels.transOpen.value) opts.panels.transOpen.value = false;
        else if (opts.panels.typeOpen.value) opts.panels.typeOpen.value = false;
        else if (opts.panels.summaryOpen.value) opts.panels.summaryOpen.value = false;
        else if (opts.panels.tocOpen.value) opts.panels.tocOpen.value = false;
        else opts.onClose();
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", onKey));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

  return {
    onWheel,
    page,
    nudge,
    onReaderClick,
    onReaderMove,
    onReaderLeave,
    onReaderPointerDown,
    onTouchStart,
    onTouchEnd,
    onTouchCancel,
    onTouchMove,
    onKey,
  };
}
