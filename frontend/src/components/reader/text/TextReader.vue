<script setup lang="ts">
// The reading screen for every format that is read by chapter — EPUB, MOBI,
// plain text, markdown. A PDF is its own screen (PdfView); this one owns the
// chapter body, translation, speech, auto-scroll, and the chrome around them.
//
// Concerns live in composables so a change to one (speech hand-off, progress
// restore, link fragments) does not have to wade through the others. The shell
// owns the yield policy: two things driving the page at once is a fight, and
// the one just asked for wins.

import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import { Browser } from "@wailsio/runtime";
import * as api from "../../../api";
import { useUi } from "../../../stores/ui";
import { jobKey, useTranslationJobs } from "../../../stores/translation";
import { isAcross, metrics, offsetOf, scrollTo, settle, type ReadingAxis } from "../../../lib/reading/position";
import { readingAxisOf } from "../../../lib/reading/direction";
import { tateChuYoko } from "../../../lib/reading/tateChuYoko";
import { columnOf, pageCount, pageOfRatio } from "../../../lib/reading/paging";
import { findFolded } from "../../../lib/reading/searchFold";
import type { BookDetail, ChapterContent, SearchHit } from "../../../types";
import {
  useChapterImages,
  useBookLinks,
  useChapterSections,
  useReadingProgress,
  useChapterTranslation,
  useReaderSpeech,
  useAutoScroll,
  useTextReaderInput,
  useReadingReminder,
  useChapterNav,
} from "../../../composables/reader";
import HighlightLayer from "../../HighlightLayer.vue";
import Icon from "../../Icon.vue";
import ImageViewer from "../../ImageViewer.vue";
import TocPane from "../shared/TocPane.vue";
const ChapterSummary = defineAsyncComponent(() => import("../shared/ChapterSummary.vue"));
import TextReaderToolbar from "./TextReaderToolbar.vue";
import ReaderStatus from "./ReaderStatus.vue";

const props = defineProps<{ book: BookDetail }>();
const emit = defineEmits<{
  (e: "toast", text: string): void;
  (e: "open-settings", section?: string): void;
  (e: "close"): void;
}>();

const { t, locale } = useI18n();
const ui = useUi();

const bookId = computed(() => props.book.id);
const chapters = computed(() => props.book.chapters ?? []);

const chapterIndex = ref(0);
const tocOpen = ref(false);
watch(
  () => ui.tocSearchTick,
  () => {
    tocOpen.value = true;
    nextTick(() => document.querySelector<HTMLInputElement>(".toc-search input")?.focus());
  },
);
const summaryOpen = ref(false);
const typeOpen = ref(false);
const moreOpen = ref(false);
const scrollRef = ref<HTMLDivElement>();
const bodyRef = ref<HTMLDivElement>();

// Immersive chrome (wired after translation panels exist — see trackChrome).
/** Which way this chapter runs. Everything that asks where the reader is goes
 *  through the position layer with this, so the two modes are one code path. */
const paged = computed(() => ui.readerPageMode === "paged");
const vertical = computed(() => ui.readerOrientation === "vertical");
const axis = computed<ReadingAxis>(() => readingAxisOf(ui.readerPageMode, ui.readerOrientation));

/** The gutter between one page and the next. The scroller is one page *and*
 *  one gutter wide, so that a turn of one viewport lands exactly on the next
 *  page — measured: a viewport of the page alone drifts a gutter per page and
 *  ends up showing half of one. A vertical (古籍) page carries a slimmer
 *  gutter: its columns are narrow, and 64px of blank between them reads as a
 *  gap rather than a page break. */
const PAGE_GUTTER = 64;
const pageGutter = computed(() => (vertical.value ? 40 : PAGE_GUTTER));

/** Anything that changes how the text is laid out has to put the reader back
 *  where they were, and none of it arrives as a resize: a larger type size, a
 *  narrower measure, a second column, a switch to pages. Watching the settings
 *  that reflow the page catches those; a ResizeObserver catches the window. */
watch(
  () => ui.readerPageMode,
  async () => {
    const keep = chapterRatio.value;
    markNotReady();
    await nextTick();
    setRestoreRatio(keep);
    await restorePosition();
    measurePages();
    trackColumns();
  },
);
watch(
  () => [
    ui.readerColumns, ui.readerSize, ui.readerLeading,
    ui.readerWidth, ui.readerTracking, ui.readerParaGap, ui.readerPadX, ui.readerPadY,
    ui.readerFont, ui.readerJustify, ui.readerIndent, ui.readerTypeset, ui.readerDropCap,
  ],
  () => nextTick(() => { reflow(); measurePages(); trackColumns(); }),
);

/** How many pages this chapter came to, and which one is showing. Measured
 *  rather than counted: the page count is a property of the layout the browser
 *  produced, and reading it costs a layout, so it is taken when the layout
 *  changes rather than on every scroll. */
const pagesInChapter = ref(1);
function measurePages() {
  const el = scrollRef.value;
  if (!el || !paged.value) {
    pagesInChapter.value = 1;
    return;
  }
  const m = metrics(el, axis.value);
  // The page is the reading surface: one viewport, no measure-sized gutter
  // in the step (that gutter used to be how 单行宽度 stole the turn zone).
  pagesInChapter.value = pageCount(m.total, m.view, 0);
}
const pageNow = computed(() => pageOfRatio(chapterRatio.value, pagesInChapter.value) + 1);

/** A scrolled vertical (古籍) chapter reports its place in columns — which
 *  screenful of how many it is on — the way a paged one reports pages.
 *  Read from the layout on scroll, like every other position: the numbers
 *  only exist once the chapter is laid out. */
const colNow = ref<{ col: number; cols: number } | null>(null);
function trackColumns() {
  const el = scrollRef.value;
  if (!el || paged.value || !vertical.value) {
    colNow.value = null;
    return;
  }
  const m = metrics(el, axis.value);
  colNow.value = columnOf(m.at, m.view, m.total);
}

// A word about resting the eyes, after enough *reading* — not after enough
// time with the window open.
useReadingReminder({ scrollRef });

let sizeWatch: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver !== "function") return;
  let frame = 0;
  sizeWatch = new ResizeObserver((entries) => {
    // A drag of the window edge is a stream of these; one per frame is enough
    // to keep the place without fighting the compositor.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const scroller = scrollRef.value;
      // Only a change to the *window* should move the scroller. Observing the
      // body and writing scrollLeft from those ticks is what made vertical
      // (古籍) crawl: each column laid out grew the body, which moved the
      // scroller, which laid out another column.
      if (entries.some((e) => e.target === scroller)) reflow();
      measurePages();
      trackColumns();
      scheduleLineNumbers();
    });
  });
  if (scrollRef.value) sizeWatch.observe(scrollRef.value);
  // Images that load after paint change how many pages the chapter comes to.
  // Measure only — never reflow from this, see above.
  if (bodyRef.value) sizeWatch.observe(bodyRef.value);
});
onBeforeUnmount(() => {
  sizeWatch?.disconnect();
  clearTimeout(chapterInTimer);
  clearTimeout(reloadTimer);
  cancelAnimationFrame(lineRaf);
});
const pagedStyle = computed(() => ({
  // Live measure lives on the scroller, not :root, so the top bar cannot
  // follow the 单行宽度 slider. In pages mode the scroller *is* the page
  // (full reading surface) so left/right turn zones stay on the window
  // edges; --reader-width only shrinks the 版心 inside that page.
  "--reader-width": `${ui.readerWidth}px`,
  ...(paged.value
    ? {
        "--page-gutter": `${pageGutter.value}px`,
        width: "100%",
        maxWidth: "100%",
        "--reader-columns": String(ui.readerColumns),
      }
    : {}),
}));

// The toolbar stays up: it used to hide while scrolling down and return on
// upward motion, but the reading screen keeps its controls in reach now.
// The chrome is always visible; `chromeVisible` is still the toolbar's prop
// (`hidden: !chromeVisible`), it just never flips false.
const chromeVisible = ref(true);
function revealChrome() {
  chromeVisible.value = true;
}

// Late-bound: auto and speech each need to stop the other; nav needs both.
const stops = {
  auto: () => {},
  speech: () => {},
};
function yieldMotion() {
  stops.auto();
  stops.speech();
}

// ── chapter load ──────────────────────────────────────────────────────────
const chapter = useQuery({
  queryKey: computed(() => ["chapter", bookId.value, chapterIndex.value] as const),
  queryFn: () => api.getChapter(bookId.value, chapterIndex.value),
  // The chapter body is the heaviest query in the app; a chapter turn already
  // changes the key, and nothing edits the body in place, so 5 minutes of
  // freshness keeps window-focus from refetching the whole chapter.
  staleTime: 5 * 60_000,
});
const c = computed<ChapterContent | null>(() => chapter.data.value ?? null);
const minutes = computed(() => Math.max(1, Math.round((c.value?.charCount ?? 0) / 300)));

// ── progress ──────────────────────────────────────────────────────────────
const {
  scrolled,
  chapterRatio,
  minutesLeft,
  livePercent,
  currentRatio,
  onScroll,
  saveProgress,
  restorePosition,
  reflow,
  setRestoreRatio,
  markNotReady,
  markReady,
} = useReadingProgress({
  axis,
  paged,
  bookId,
  chapterIndex,
  chapters,
  chapterCharCount: computed(() => c.value?.charCount ?? 0),
  bookPercent: computed(() => props.book.percent ?? 0),
  scrollRef,
  onRestored: () => {
    clearAdvancing();
    trySpeakOnLoad();
    // The chapter is laid out now, which is the only moment its page count
    // can be known — a book opened in pages was otherwise never measured at
    // all, and said 44% where it should have said page five.
    measurePages();
    trackColumns();
  },
  onScrollExtra: () => {
    trackSection();
    trackColumns();
  },
});

let pendingSnippet = "";

function takePendingJump(): number | null {
  const pending = ui.consumePendingChapter();
  const snippet = ui.consumePendingSnippet();
  if (snippet) pendingSnippet = snippetNeedle(snippet);
  return pending;
}

// Seed chapter + restore ratio once the book opens.
{
  const pending = takePendingJump();
  chapterIndex.value = pending ?? props.book.progress.chapterIndex ?? 0;
  setRestoreRatio(pending != null ? 0 : props.book.progress.chapterRatio);
}

// Command-palette / library switch reuses this instance when Reader has no
// :key. Re-seed from the new book's saved place instead of keeping the old
// chapter index (which then refuses to load, because idx === chapterIndex).
watch(
  () => props.book.id,
  () => {
    const pending = takePendingJump();
    chapterIndex.value = pending ?? props.book.progress.chapterIndex ?? 0;
    setRestoreRatio(pending != null ? 0 : props.book.progress.chapterRatio);
    markNotReady();
  },
);

// ── translation ───────────────────────────────────────────────────────────
const {
  transOpen,
  transView,
  targetLang,
  engine,
  job,
  translating,
  hasTranslation,
  displayBody,
  displayTitle,
  toggleTranslation,
  pickView,
  pickLang,
  pickEngine,
} = useChapterTranslation({
  bookId,
  chapterIndex,  chapterCount: computed(() => chapters.value.length),
  chapterHtml: computed(() => c.value?.html ?? ""),
  chapterTitle: computed(() => c.value?.title ?? ""),
  locale: computed(() => locale.value),
});

// ── 纵中横 (tate-chu-yoko) ────────────────────────────────────────────────
// In a vertical column, runs of 2–4 digits are wrapped for
// `text-combine-upright` so a year or a page number reads as one horizontal
// cell instead of one glyph per digit lying sideways. The wrap adds spans
// only — text content is untouched, so highlight offsets and the chapter's
// plain text keep their anchors. Applied at render time, off in horizontal.
const renderedBody = computed(() =>
  vertical.value ? tateChuYoko(displayBody.value ?? "") : (displayBody.value ?? ""),
);

// ── chapter transition ────────────────────────────────────────────────────
// A fresh chapter enters with a short rise-and-fade so a page turn reads as
// motion, not a hard swap. Purely presentational.
const chapterIn = ref(false);
let chapterInTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => c.value,
  () => {
    chapterIn.value = true;
    clearTimeout(chapterInTimer);
    chapterInTimer = setTimeout(() => (chapterIn.value = false), 320);
  },
);

// ── translation memory ────────────────────────────────────────────────────
// Finished chapter translations keep their full HTML so switching back is
// instant — but only for the chapter being read. On a chapter turn, drop the
// done jobs of every other chapter; a long book read cover to cover would
// otherwise keep every translated chapter's HTML resident for the session.
watch(chapterIndex, (idx) => {
  const tr = useTranslationJobs();
  const keep = jobKey(bookId.value, idx);
  for (const key of Object.keys(tr.jobs)) {
    if (key !== keep && tr.jobs[key]?.status === "done") tr.clear(key);
  }
});

// ── direction switch (reload-style) ──────────────────────────────────────
// Flipping horizontal/vertical re-lays the whole chapter in one vertical
// pass. Instead of letting that stall the frame, remount the article under a
// sheet-coloured mask: the old DOM is gone before the browser lays out, the
// new one lays out unseen, and the mask lifts a couple of frames later. The
// place is kept as a ratio, so the new direction opens on the same sentence.
const reloadKey = ref(0);
const reloadMask = ref(false);
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

// ── body helpers ──────────────────────────────────────────────────────────
const chapterChars = computed(() => (c.value?.charCount ?? 0).toLocaleString());

// ── line numbers (proofing gutter) ─────────────────────────────────────────
// One number per *visual* line, in reading order, pinned along the chapter's
// left edge. Each text node's rects give one rect per rendered line; nodes on
// the same visual line (a wrapped span, a link split across lines) share a
// top, so near-identical tops collapse to one line. Columns flow in reading
// order, so the same pass works for multi-column layouts.
const lineNumbers = ref<{ top: number; left: number; n: number }[]>([]);
let lineRaf = 0;

// ── drop-cap target ────────────────────────────────────────────────────────
// The chapter's first *visible* paragraph carries the drop cap. CSS alone
// cannot say that: `p:first-of-type` matches the first <p> even when it is an
// empty paragraph the blank-trim preference has hidden, so the oversized
// letter lands on an invisible node and the chapter appears undecorated. Mark
// the real first prose paragraph instead.
function markDropCapTarget() {
  const body = bodyRef.value;
  if (!body) return;
  body.querySelectorAll("p.dropcap-target").forEach((p) => p.classList.remove("dropcap-target"));
  const first = Array.from(body.querySelectorAll("p")).find(
    (p) => p.offsetParent !== null && !!p.textContent?.trim() && !p.closest("blockquote, li, td"),
  );
  first?.classList.add("dropcap-target");
}

function computeLineNumbers() {
  lineRaf = 0;
  const body = bodyRef.value;
  const article = body?.closest<HTMLElement>(".article");
  if (!body || !article) {
    lineNumbers.value = [];
    return;
  }
  const vert = vertical.value;
  const box = article.getBoundingClientRect();
  const originY = box.top;
  const originX = box.left;
  const lineHeight = parseFloat(getComputedStyle(body).lineHeight) || 1.6;
  const fontSize = parseFloat(getComputedStyle(body).fontSize) || 17;
  const gap = lineHeight * 0.55;
  const colGap = fontSize * 0.5;
  const points: { top: number; left: number }[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    let rects: DOMRect[] = [];
    try {
      rects = Array.from(range.getClientRects());
    } catch {
      /* node detached mid-layout — skip */
    }
    for (const r of rects) {
      if (r.height > 0.5 && r.width > 0.5) points.push({ top: r.top - originY, left: r.left - originX });
    }
  }
  // Reading order decides the numbering: horizontal counts top-to-bottom,
  // vertical (古籍) counts columns right-to-left, then top-to-bottom.
  if (vert) points.sort((a, b) => b.left - a.left || a.top - b.top);
  else points.sort((a, b) => a.top - b.top);
  const lines: { top: number; left: number; n: number }[] = [];
  let lastTop = -Infinity;
  let lastLeft = -Infinity;
  for (const p of points) {
    // Same visual line across nodes collapses to one number: horizontal lines
    // share a top, vertical columns share a left (and a continuing top).
    const sameLine = vert
      ? Math.abs(p.left - lastLeft) < colGap && p.top - lastTop < gap
      : p.top - lastTop < gap;
    if (sameLine) continue;
    // Vertical numbers sit in the inter-column gap, one column-width back
    // from the text they number, so they never overlap the column itself.
    lines.push({
      top: Math.round(p.top),
      left: Math.round(p.left) - (vert ? Math.round(fontSize) : 0),
      n: lines.length + 1,
    });
    lastTop = p.top;
    lastLeft = p.left;
  }
  lineNumbers.value = lines;
}

function scheduleLineNumbers() {
  if (lineRaf) cancelAnimationFrame(lineRaf);
  lineRaf = requestAnimationFrame(() => {
    void nextTick(() => {
      markDropCapTarget();
      // The full getClientRects pass is expensive on a long chapter; it only
      // exists to feed the gutter, so don't pay for it when the gutter is
      // off — switching direction must not stall on a measurement nobody sees.
      if (ui.readerLineNumbers) computeLineNumbers();
      else lineNumbers.value = [];
    });
  });
}

watch(
  [
    displayBody,
    () => c.value,
    () => ui.readerSize,
    () => ui.readerLeading,
    () => ui.readerWidth,
    () => ui.readerColumns,
    () => ui.readerLineNumbers,
    () => ui.readerOrientation,
  ],
  scheduleLineNumbers,
);
document.fonts?.ready.then(() => scheduleLineNumbers()).catch(() => {});
const { imageSrcs, imageAlts, viewerIndex, releaseImages, resolveImages } = useChapterImages(
  bookId,
  bodyRef,
  {
    onLayout: () => {
      reflow();
      measurePages();
      trackColumns();
      scheduleLineNumbers();
    },
  },
);
watch(viewerIndex, (i) => {
  if (i != null) yieldMotion();
});
const {
  sections,
  activeSection,
  readSections,
  trackSection,
  goToSection: jumpToSection,
  markTopsStale,
} = useChapterSections(scrollRef, bodyRef, axis, paged);
watch(axis, () => markTopsStale());

watch(
  () => ui.readerOrientation,
  () => {
    // The remount throws the old layout away; keep the place as a ratio so
    // the new direction opens on the same sentence, not the chapter head.
    // Read the last-known ratio, not currentRatio(): this watch runs after
    // the setting has flipped, so a live metrics read would ask the *new*
    // axis and find the scroller still parked on the old one.
    const keep = chapterRatio.value;
    // The remount parks the scroller at 0; until restore paints, a scroll
    // event must not write that 0 over the saved place. Auto-scroll on an
    // empty remount used to skip a chapter.
    yieldMotion();
    markNotReady();
    releaseImages();
    reloadKey.value++;
    reloadMask.value = true;
    clearTimeout(reloadTimer);
    // Two frames give the remount + vertical layout time to land under the
    // mask; then put the reader back and lift it.
    reloadTimer = setTimeout(async () => {
      await nextTick();
      await resolveImages();
      setRestoreRatio(keep);
      await restorePosition();
      measurePages();
      trackColumns();
      readSections();
      scheduleLineNumbers();
      reloadMask.value = false;
    }, 80);
  },
);

// ── navigation ────────────────────────────────────────────────────────────
const {
  hasPrev,
  hasNext,
  goTo,
  goToByUser,
  next,
  prev,
  finish,
  maybeFinish,
  toggleFavorite,
  addBookmark,
  focusHighlight,
} = useChapterNav({
  bookId,
  isFavorite: () => props.book.isFavorite,
  isFinished: () => props.book.isFinished,
  chapterIndex,
  chapterCount: computed(() => chapters.value.length),
  chapterTitle: computed(() => c.value?.title ?? ""),
  saveProgress,
  setRestoreRatio,
  restorePosition,
  markReady,
  markNotReady,
  currentRatio,
  yieldMotion,
  stopAuto: () => stops.auto(),
  onToast: (text) => emit("toast", text),
  closePanels: () => {
    tocOpen.value = false;
    summaryOpen.value = false;
    moreOpen.value = false;
    revealChrome();
  },
});

// A search hit / citation for the book already on screen: :key does not
// remount, so consume the pending chapter while we are open.
watch(
  () => ui.pendingChapterIndex,
  (idx) => {
    if (idx == null) return;
    const pending = takePendingJump();
    if (pending == null) return;
    if (pending === chapterIndex.value) {
      yieldMotion();
      void nextTick(scrollPendingSnippet);
      return;
    }
    goToByUser(pending, 0);
  },
);

const { returnTo, followLink, goBackFromLink, consumePendingFragment } = useBookLinks({
  axis,
  paged,
  scrollRef,
  bodyRef,
  chapterIndex,
  chapters,
  chapterTitle: computed(() => c.value?.title ?? ""),
  currentRatio,
  goTo,
  yieldMotion,
});

function onBodyClick(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null;
  const ext = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (ext) {
    const href = ext.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      ev.preventDefault();
      Browser.OpenURL(href).catch(() => {});
      return;
    }
  }
  const link = target?.closest?.("a[data-link]") as HTMLElement | null;
  if (!link) return;
  ev.preventDefault();
  followLink(link.dataset.link ?? "");
}

// ── motion ────────────────────────────────────────────────────────────────
const { autoScrolling, stopAuto, toggleAuto, clearAdvancing } = useAutoScroll({
  axis,
  scrollRef,
  bookId,
  chapterIndex,
  hasNext,
  goTo,
  stopSpeech: () => stops.speech(),
  onBookEnd: maybeFinish,
});

const { speech, toggleSpeech, stopSpeech, trySpeakOnLoad } = useReaderSpeech({
  axis,
  paged,
  scrollRef,
  bodyRef,
  chapterIndex,
  hasNext,
  transView,
  translating,
  hasTranslation,
  displayBody,
  currentRatio,
  goTo,
  stopAuto: () => stops.auto(),
  onBookEnd: maybeFinish,
  lang: () => props.book.language ?? "",
});

stops.auto = stopAuto;
stops.speech = stopSpeech;

const speechSpeaking = speech.speaking;
const speechPaused = speech.paused;

// ── keyboard + click-page ─────────────────────────────────────────────────
const {
  onReaderClick,
  onReaderMove,
  onReaderLeave,
  onReaderPointerDown,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
  onTouchMove,
  onWheel,
} = useTextReaderInput({
  axis,
  scrollRef,
  lineHeight: () => ui.readerLeading,
  hasPrev,
  hasNext,
  chapterIndex,
  panels: { tocOpen, typeOpen, transOpen, summaryOpen, moreOpen },
  speech: {
    supported: speech.supported,
    speaking: speechSpeaking,
    skip: (by: 1 | -1) => speech.skip(by),
  },
  autoScrolling,
  yieldMotion,
  stopAuto,
  stopSpeech,
  goTo,
  next,
  prev,
  toggleAuto,
  toggleSpeech,
  toggleTranslation,
  onClose: () => emit("close"),
});

// ── the wheel, when the chapter runs across ─────────────────────────────────
// A horizontal scroller and a vertical wheel is a bargain between engines;
// the gesture is taken and turned into what it means here: one flick, one
// page (see useTextReaderInput's onWheel). Bound whenever the chapter runs
// across — paged, or vertical (古籍) even when not paged — so a vertical wheel
// still turns the page in both. A scrolled horizontal chapter keeps the
// passive listener it has always had, and the browser's own scroll.
//
// (This sits after useTextReaderInput: the watch is immediate, its callback
// runs synchronously during setup, and referencing onWheel before the const
// exists would throw.)
watch(
  [axis, scrollRef],
  ([ax, el], _old, onCleanup) => {
    if (ax === "y" || !el) return;
    const handler = (ev: WheelEvent) => {
      yieldMotion();
      onWheel(ev);
    };
    el.addEventListener("wheel", handler, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    onCleanup(() => {
      el.removeEventListener("wheel", handler);
      el.removeEventListener("touchmove", onTouchMove);
    });
  },
  { immediate: true },
);

// ── chapter paint ─────────────────────────────────────────────────────────
watch(
  () => [c.value?.index, c.value?.html] as const,
  async ([idx, html]) => {
    // Wait until the query matches the chapter we asked for — flipping
    // the index first used to restore against the previous body's geometry.
    if (idx == null || html == null || idx !== chapterIndex.value) return;
    markNotReady();
    releaseImages();
    await nextTick();
    await resolveImages();
    await restorePosition();
    readSections();
    consumePendingFragment();
    scrollPendingSnippet();
  },
);

watch(displayBody, async () => {
  await nextTick();
  readSections();
  reflow();
  measurePages();
  trackColumns();
});

watch([summaryOpen, transView], async () => {
  await nextTick();
  reflow();
  measurePages();
  trackColumns();
});

/** Strip FTS `<mark>` wrappers so we can find the passage in the chapter. */
function snippetNeedle(html: string): string {
  const marked = html.match(/<mark>([\s\S]*?)<\/mark>/i)?.[1] ?? html;
  return marked.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function onSelectHit(hit: SearchHit) {
  pendingSnippet = snippetNeedle(hit.snippet);
  goToByUser(hit.chapterIndex, 0);
  if (hit.chapterIndex === chapterIndex.value) void nextTick(scrollPendingSnippet);
}

function scrollPendingSnippet() {
  const needle = pendingSnippet;
  if (!needle) return;
  const el = scrollRef.value;
  const body = bodyRef.value;
  if (!el || !body) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let acc = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    nodes.push({ node: t, start: acc.length });
    acc += t.data;
  }
  const at = findFolded(acc, needle);
  if (at < 0) return;
  const span = nodes.find((s, i) => at >= s.start && at < (nodes[i + 1]?.start ?? Infinity));
  const target = span?.node.parentElement;
  if (!target) return;
  pendingSnippet = "";
  target.classList.add("hl-flash");
  window.setTimeout(() => target.classList.remove("hl-flash"), 1500);
  const ax = axis.value;
  const m = metrics(el, ax);
  const to = isAcross(ax)
    ? settle(m, ax, offsetOf(el, target, ax), "contain", paged.value)
    : Math.max(0, offsetOf(el, target, "y") - 12);
  scrollTo(el, ax, to, true);
}

function goToSection(id: number) {
  yieldMotion();
  jumpToSection(id);
  tocOpen.value = false;
}

const prevChapter = computed(() =>
  hasPrev.value ? chapters.value[chapterIndex.value - 1] : undefined,
);
const nextChapter = computed(() =>
  hasNext.value ? chapters.value[chapterIndex.value + 1] : undefined,
);
</script>

<template>
  <div class="reader reader-v2" role="main">
    <div
      class="reader-progress"
      role="progressbar"
      :aria-valuenow="Math.round(livePercent * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('reader.progressPct', { n: Math.round(livePercent * 100) })"
    >
      <div class="reader-progress-fill" :style="{ transform: `scaleX(${livePercent})` }" />
    </div>

    <div v-if="reloadMask" class="reader-reload-mask" aria-hidden="true" />

    <div class="reader-chrome-hotzone" aria-hidden="true" />

    <TextReaderToolbar
      :book-id="bookId"
      :book-title="book.title"
      :chapter-title="c?.title"
      :scrolled="scrolled"
      :chrome-visible="chromeVisible"
      :toc-open="tocOpen"
      :type-open="typeOpen"
      :summary-open="summaryOpen"
      :more-open="moreOpen"
      :on-toggle-more="() => { revealChrome(); typeOpen = false; transOpen = false; tocOpen = false; moreOpen = !moreOpen; }"
      :on-close-more="() => (moreOpen = false)"
      :trans-open="transOpen"
      :trans-view="transView"
      :target-lang="targetLang"
      :engine="engine"
      :translating="translating"
      :has-translation="hasTranslation"
      :job-done="job?.done ?? 0"
      :job-total="job?.total ?? 0"
      :is-favorite="book.isFavorite"
      :is-finished="book.isFinished"
      :speech-supported="speech.supported"
      :speech-speaking="speechSpeaking"
      :speech-paused="speechPaused"
      :auto-scrolling="autoScrolling"
      :on-toggle-toc="() => { revealChrome(); typeOpen = false; transOpen = false; moreOpen = false; tocOpen = !tocOpen; }"
      :on-toggle-type="() => { revealChrome(); moreOpen = false; transOpen = false; tocOpen = false; typeOpen = !typeOpen; }"
      :on-toggle-summary="() => { revealChrome(); summaryOpen = !summaryOpen; }"
      :on-add-bookmark="addBookmark"
      :on-toggle-translation="toggleTranslation"
      :on-toggle-trans-open="() => { revealChrome(); moreOpen = false; typeOpen = false; transOpen = !transOpen; }"
      :on-pick-view="pickView"
      :on-pick-lang="pickLang"
      :on-pick-engine="pickEngine"
      :on-close-trans="() => (transOpen = false)"
      :on-favorite="toggleFavorite"
      :on-finish="finish"
      :on-toggle-speech="toggleSpeech"
      :on-stop-speech="stopSpeech"
      :on-toggle-auto="toggleAuto"
      :on-close-type="() => (typeOpen = false)"
      :on-open-settings="(s?: string) => emit('open-settings', s)"
    />

    <div
      class="reader-scroll"
      :class="{ paged }"
      :style="pagedStyle"
      ref="scrollRef"
      @scroll.passive="onScroll"
      @wheel.passive="yieldMotion"
      @click="onReaderClick"
      @pointerdown.passive="onReaderPointerDown"
      @mousemove.passive="onReaderMove"
      @mouseleave="onReaderLeave"
      @touchstart.passive="onTouchStart"
      @touchend="onTouchEnd"
      @touchcancel.passive="onTouchCancel"
    >
      <article v-if="c" :key="`${bookId}:${chapterIndex}:${reloadKey}`" class="article reader-content" :class="{ 'chapter-in': chapterIn }">
        <div v-if="ui.readerLineNumbers && lineNumbers.length" class="reader-line-nums" aria-hidden="true">
          <span
            v-for="l in lineNumbers"
            :key="l.n"
            :style="vertical ? { top: `${l.top}px`, left: `${l.left}px` } : { top: `${l.top}px` }"
          >{{ l.n }}</span>
        </div>
        <div v-if="translating" class="tr-bar" role="progressbar" :aria-valuenow="job?.done ?? 0">
          <div
            class="tr-bar-fill"
            :style="{ transform: `scaleX(${job && job.total > 0 ? job.done / job.total : 0.06})` }"
          />
        </div>

        <header class="article-head">
          <div class="article-kicker">
            <span class="article-kicker-chip">
              {{ t("reader.chapterOf", { n: chapterIndex + 1, total: chapters.length }) }}
            </span>
            <span v-if="ui.prefs.showReadingTime" class="article-kicker-meta">
              {{
                chapterRatio > 0.02
                  ? t("reader.minutesLeft", { n: minutesLeft })
                  : t("reader.minutes", { n: minutes })
              }}
            </span>
            <span v-if="ui.prefs.showReadingTime" class="article-kicker-meta">
              {{ t("reader.chapterChars", { n: chapterChars }) }}
            </span>
            <span
              v-if="activeSection >= 0 && sections.length"
              class="article-kicker-meta art-section"
            >
              {{ sections[activeSection].text }}
            </span>
          </div>
          <h1 class="article-title">{{ displayTitle }}</h1>
          <p v-if="book.author" class="article-byline">{{ book.author }}</p>
        </header>

        <ChapterSummary
          v-if="summaryOpen"
          :key="`${bookId}:${chapterIndex}`"
          :book-id="bookId"
          :chapter-index="chapterIndex"
          :initial="c.aiSummary"
          :on-close="() => (summaryOpen = false)"
          :on-open-settings="() => emit('open-settings', 'ai')"
        />

        <div
          v-if="ui.prefs.showTransSwitch && (hasTranslation || translating)"
          class="tr-toggle"
          role="group"
          :aria-label="t('reader.tbTranslate')"
        >
          <button :class="{ on: transView === 'original' }" @click="pickView('original')">
            {{ t("reader.original") }}
          </button>
          <button :class="{ on: transView === 'bilingual' }" @click="pickView('bilingual')">
            {{ t("reader.bilingual") }}
          </button>
          <button :class="{ on: transView === 'translation' }" @click="pickView('translation')">
            {{ t("reader.translation") }}
          </button>
        </div>

        <div
          class="article-body"
          ref="bodyRef"
          v-html="renderedBody || `<p><em>${t('reader.emptyChapter')}</em></p>`"
          @click="onBodyClick"
        />

        <div v-if="ui.readerEndMark" class="chapter-end-mark" aria-hidden="true"><span class="cem-diamond" /></div>

        <button v-if="returnTo" class="link-back" @click="goBackFromLink">
          <Icon name="skip-back" :size="13" />
          {{ returnTo.label ? t("reader.backToWithTitle", { title: returnTo.label }) : t("reader.backTo") }}
        </button>

        <nav class="chapter-nav chapter-nav-cards">
          <!-- chapter-nav-btn kept for existing tests that click the foot nav. -->
          <button class="chapter-nav-card chapter-nav-btn prev" :disabled="!hasPrev" @click="prev">
            <span class="chapter-nav-dir">
              <Icon name="chevron-right" :size="14" class="chapter-nav-chevron prev" />
              {{ t("reader.prevChapter") }}
            </span>
            <strong v-if="prevChapter">{{ prevChapter.title }}</strong>
            <span v-else class="chapter-nav-empty">—</span>
          </button>
          <button class="chapter-nav-card chapter-nav-btn next" :disabled="!hasNext" @click="next">
            <span class="chapter-nav-dir">
              {{ t("reader.nextChapter") }}
              <Icon name="chevron-right" :size="14" class="chapter-nav-chevron next" />
            </span>
            <strong v-if="nextChapter">{{ nextChapter.title }}</strong>
            <span v-else class="chapter-nav-empty">—</span>
          </button>
        </nav>
      </article>

      <div v-else-if="chapter.isError.value" class="empty" :style="{ flex: 1 }">
        <div class="glyph"><Icon name="alert" :size="22" /></div>
        <div>{{ t("reader.loadError") }}</div>
        <button class="empty-retry" @click="chapter.refetch()">
          <Icon name="refresh" :size="12" />
          {{ t("common.retry") }}
        </button>
      </div>

      <div v-else class="article reader-content" aria-hidden="true">
        <div class="sk-line" :style="{ width: '52%', height: '24px', marginBottom: '18px' }" />
        <div class="sk-line" :style="{ width: '30%', marginBottom: '30px' }" />
        <div
          v-for="i in 10"
          :key="i"
          class="sk-line"
          :style="{ width: (i - 1) % 3 === 2 ? '58%' : '100%', height: '12px' }"
        />
      </div>
    </div>

    <ReaderStatus
      :page="paged ? pageNow : undefined"
      :pages="paged ? pagesInChapter : undefined"
      :col="vertical && !paged ? (colNow?.col ?? 0) + 1 : undefined"
      :cols="vertical && !paged ? colNow?.cols : undefined"
      :ratio="chapterRatio"
      :minutes-left="minutesLeft"
      :visible="chromeVisible && !tocOpen && !typeOpen && !transOpen"
    />

    <HighlightLayer
      :scroll-el="scrollRef ?? null"
      v-if="c"
      :key="`${bookId}:${chapterIndex}`"
      :book-id="bookId"
      :chapter-index="chapterIndex"
      :body-el="bodyRef ?? null"
    />

    <TocPane
      v-if="tocOpen"
      :chapters="chapters"
      :current="chapterIndex"
      :book-id="book.id"
      :sections="sections"
      :active-section="activeSection"
      @select="(index: number, ratio?: number) => goToByUser(index, ratio ?? 0)"
      @select-hit="onSelectHit"
      @select-section="goToSection"
      @focus-highlight="focusHighlight"
      @close="tocOpen = false"
    />

    <div v-if="ui.readerWarmth > 0" class="reader-warm" aria-hidden="true" />

    <ImageViewer
      v-if="viewerIndex != null"
      :srcs="imageSrcs"
      :alts="imageAlts"
      :index="viewerIndex"
      @close="viewerIndex = null"
    />
  </div>
</template>
