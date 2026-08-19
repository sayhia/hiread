<script setup lang="ts">
// The reading screen for a PDF.
//
// A PDF is read by page; every other format is read by chapter. They were one
// component with a `isPdf` beside twenty-three decisions — the contents, the
// typography, the translation, the summary, the keyboard, the click zones —
// and each of those was a place a change to one path could forget the other.
// They are two screens now.
//
// What stays shared is what belongs to the *book* rather than to the format:
// marking it a favourite or finished, focus mode, the page colour behind it,
// and the marks a reader leaves. The top bar matches the text reader: primary
// actions in the strip, the rest under More. TocPane is the same sheet.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../../api";
import { useUi } from "../../../stores/ui";
import { useDismiss } from "../../../composables/useDismiss";
import { useMenuKeyboard } from "../../../composables/useMenuKeyboard";
import { pageClickSwallowed, swallowPageClick } from "../../../composables/reader/useTextReaderInput";
import { isMac } from "../../../lib/platform";
import { pageDirFromSide } from "../../../lib/reading/direction";
import { findFolded } from "../../../lib/reading/searchFold";
import type { BookDetail, SearchHit } from "../../../types";
import type { PdfOutlineEntry } from "../../../lib/pdfOutline";
import type { Block } from "../../../lib/pdfText";
import PdfReader from "./PdfReader.vue";
import PdfTextView from "./PdfTextView.vue";
import TocPane from "../shared/TocPane.vue";
import ReaderTypography from "../shared/ReaderTypography.vue";
import Icon from "../../Icon.vue";

const props = defineProps<{ book: BookDetail }>();
const emit = defineEmits<{
  (e: "toast", text: string): void;
  (e: "open-settings", section?: string): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
const ui = useUi();
const qc = useQueryClient();

const tocOpen = ref(false);
watch(
  () => ui.tocSearchTick,
  () => {
    tocOpen.value = true;
    nextTick(() => document.querySelector<HTMLInputElement>(".toc-search input")?.focus());
  },
);
const typeOpen = ref(false);
const moreOpen = ref(false);

const moreEl = ref<HTMLDivElement>();
const moreMenuEl = ref<HTMLDivElement>();
useDismiss(moreEl, () => {
  swallowPageClick();
  moreOpen.value = false;
}, { enabled: () => moreOpen.value });
const onMoreKey = useMenuKeyboard(moreMenuEl, () => moreOpen.value);
watch(
  () => moreOpen.value,
  async (on) => {
    if (!on) {
      moreEl.value?.querySelector<HTMLElement>(":scope > .tb-btn")?.focus();
      return;
    }
    await nextTick();
    moreMenuEl.value?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  },
);
function pickMore(fn: () => void) {
  moreOpen.value = false;
  fn();
}

// ── the two views ────────────────────────────────────────────────────────
// The page, as it was printed, and the same book read back as prose. Neither
// is a replacement for the other: the page is always right and never the
// reader's own typography; the text is everything hiread can do to a book and
// is an inference about a layout. Which one a book is open in is remembered
// per book, since it is a property of the book — a novel reads, a manual does
// not.
type View = "page" | "text";
const view = ref<View>("page");
const blocks = ref<Block[]>([]);
const reflowing = ref(false);
/** Where the reader is, kept across a switch so the two views agree. */
const atPage = ref(props.book.progress.page || 1);

const viewKey = computed(() => `pdfView.${props.book.id}`);
onMounted(() => {
  if (localStorage.getItem(viewKey.value) === "text") void showText();
});

async function showText() {
  view.value = "text";
  localStorage.setItem(viewKey.value, "text");
  if (blocks.value.length || reflowing.value) return;
  reflowing.value = true;
  try {
    blocks.value = (await pdfRef.value?.readingBlocks()) ?? [];
  } finally {
    reflowing.value = false;
  }
}

/** `load()` finished after we asked for the prose: extract again, now that
 *  the document exists. The first call used to cache an empty result. */
function onPdfReady() {
  if (view.value === "text" && !blocks.value.length && !reflowing.value) {
    void showText();
  }
}

function showPage() {
  view.value = "page";
  localStorage.setItem(viewKey.value, "page");
  // Land where the prose was being read.
  requestAnimationFrame(() => pdfRef.value?.goToPage(atPage.value));
}
const pdfRef = ref<InstanceType<typeof PdfReader> | null>(null);
const textRef = ref<InstanceType<typeof PdfTextView> | null>(null);
const pageCount = computed(() => {
  const n = Number(pdfRef.value?.pageCount || props.book.pageCount || 0);
  return n > 0 ? n : 0;
});
const pdfPercent = computed(() => {
  const n = pageCount.value;
  return n > 0 ? Math.min(1, Math.max(0, atPage.value / n)) : 0;
});

/** The document's own outline, when the file carries one — the only contents
 *  a PDF will ever have, since its pages are drawings rather than text. */
const outline = ref<PdfOutlineEntry[]>([]);

/** The drawer speaks in chapters; a PDF's outline is chapters by another name,
 *  with a page where the index would be. */
const tocChapters = computed(() =>
  outline.value.map((o) => ({
    index: o.page,
    title: o.title,
    level: o.level,
    href: "",
    charCount: 0,
  })),
);

function goToPage(page: number) {
  const raw = Math.round(page) || atPage.value;
  const n = pageCount.value;
  const at = n > 0 ? Math.min(n, Math.max(1, raw)) : Math.max(1, raw);
  atPage.value = at;
  if (view.value === "text") textRef.value?.goToPage(at);
  else pdfRef.value?.goToPage(at);
  tocOpen.value = false;
}

function snippetNeedle(html: string): string {
  const marked = html.match(/<mark>([\s\S]*?)<\/mark>/i)?.[1] ?? html;
  return marked.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function flashSnippet(needle: string, tries = 8) {
  const root =
    view.value === "text"
      ? document.querySelector(".pdf-text .article-body")
      : document.querySelector(".pdf-scroll");
  if (!root) {
    if (tries > 0) window.setTimeout(() => flashSnippet(needle, tries - 1), 80);
    return;
  }
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let acc = "";
  let n: Node | null;
  while ((n = walk.nextNode())) {
    const t = n as Text;
    nodes.push({ node: t, start: acc.length });
    acc += t.data;
  }
  const at = findFolded(acc, needle);
  if (at < 0) {
    if (tries > 0 && acc.length === 0) window.setTimeout(() => flashSnippet(needle, tries - 1), 80);
    return;
  }
  const span = nodes.find((s, i) => at >= s.start && at < (nodes[i + 1]?.start ?? Infinity));
  const el = span?.node.parentElement;
  if (!el) return;
  el.classList.add("hl-flash");
  window.setTimeout(() => el.classList.remove("hl-flash"), 1500);
  el.scrollIntoView({ block: "center", inline: "nearest" });
}

async function onSelectHit(h: SearchHit) {
  goToPage(h.chapterIndex);
  const needle = snippetNeedle(h.snippet);
  await nextTick();
  requestAnimationFrame(() => flashSnippet(needle));
}

/** The outline entry the reader is in — the last dest at or before this page. */
const tocCurrent = computed(() => {
  let cur = -1;
  for (const o of outline.value) if (o.page <= atPage.value) cur = o.page;
  return cur;
});

// A click that began as a drag is a selection, not a page turn — even
// when the selection has already collapsed by the time click fires.
let pointerAt: { x: number; y: number } | null = null;

function pageScroller(root: EventTarget | null): HTMLElement | null {
  const host = root instanceof Element ? root.closest(".reader") ?? root : null;
  if (!(host instanceof Element)) return null;
  return (
    host.querySelector<HTMLElement>(".pdf-text .reader-scroll") ??
    host.querySelector<HTMLElement>(".pdf-scroll")
  );
}

function edgeOf(ev: MouseEvent, root: EventTarget | null): "left" | "right" | null {
  const el = pageScroller(root) ?? (root instanceof HTMLElement ? root : null);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  if (y < 0 || y > box.height) return null;
  if (x <= 64) return "left";
  if (x >= box.width - 64) return "right";
  return null;
}

function onReaderPointerDown(ev: PointerEvent) {
  pointerAt = { x: ev.clientX, y: ev.clientY };
}

function onReaderClick(e: MouseEvent) {
  if (!ui.readerClickPaging) return;
  if (pageClickSwallowed() || moreOpen.value || tocOpen.value || typeOpen.value) return;
  if (document.querySelector(".hl-popover, .image-viewer, .settings-backdrop, .cp-backdrop, .modal-backdrop, .ctx-menu, .tag-picker")) return;
  if ((e.target as Element | null)?.closest?.("button, input, a, .tb-seg, .rp, .toc, .pdf-bar, .tb-more-menu")) return;
  if (pointerAt) {
    const moved = Math.hypot(e.clientX - pointerAt.x, e.clientY - pointerAt.y);
    pointerAt = null;
    if (moved > 6) return;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const side = edgeOf(e, e.currentTarget);
  if (!side) return;
  const by = pageDirFromSide(side, ui.readerOrientation);
  turnPage(by);
}

function onReaderMove(ev: MouseEvent) {
  const el = pageScroller(ev.currentTarget);
  if (!el) return;
  if (
    !ui.readerClickPaging ||
    tocOpen.value ||
    typeOpen.value ||
    moreOpen.value ||
    document.querySelector(".image-viewer, .hl-popover")
  ) {
    if (el.dataset.pageEdge) delete el.dataset.pageEdge;
    return;
  }
  const side = edgeOf(ev, ev.currentTarget);
  if (side) el.dataset.pageEdge = side;
  else delete el.dataset.pageEdge;
}

function onReaderLeave(ev: MouseEvent) {
  const el = pageScroller(ev.currentTarget);
  if (el?.dataset.pageEdge) delete el.dataset.pageEdge;
}

function addBookmark() {
  api
    .addBookmark(props.book.id, 0, 0, atPage.value, t("reader.pageNo", { n: atPage.value }))
    .then(() => {
      qc.invalidateQueries({ queryKey: ["bookmarks", props.book.id] });
      emit("toast", t("reader.bookmarkAdded"));
    })
    .catch(() => {});
}

function focusHighlight(chapter: number, id: number) {
  ui.pendingHighlightId = id;
  tocOpen.value = false;
  // Page-view marks store the page in chapterIndex. Opening the prose
  // view for those finds nothing (it only loads chapter 0).
  if (chapter > 0) {
    goToPage(chapter);
    return;
  }
  void showText();
}

/** In-book search, over the text behind the pages rather than the library's
 *  index — a PDF contributes nothing to that index, which is why searching one
 *  used to find nothing at all. */
async function searchPages(query: string): Promise<SearchHit[]> {
  const hits = (await pdfRef.value?.search(query, 40)) ?? [];
  return hits.map((h) => ({
    bookId: props.book.id,
    bookTitle: props.book.title,
    chapterIndex: h.page,
    chapterTitle: t("reader.pageNo", { n: h.page }),
    snippet: h.snippet,
  }));
}

function maybeFinish() {
  if (!ui.prefs.markFinishedAtEnd || props.book.isFinished) return;
  api
    .setBookFlag(props.book.id, "finished", true)
    .then(() => {
      qc.invalidateQueries({ queryKey: ["book", props.book.id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["libraryCounts"] });
      emit("toast", t("reader.markedFinished"));
    })
    .catch(() => {});
}

function turnPage(by: number) {
  if (view.value === "text") textRef.value?.pageBy(by);
  else pdfRef.value?.pageBy(by);
}

function finish() {
  api
    .setBookFlag(props.book.id, "finished", !props.book.isFinished)
    .then(() => {
      qc.invalidateQueries({ queryKey: ["book", props.book.id] });
      qc.invalidateQueries({ queryKey: ["books"] });
    })
    .catch(() => {});
}

function favorite() {
  api
    .setBookFlag(props.book.id, "favorite", !props.book.isFavorite)
    .then(() => {
      qc.invalidateQueries({ queryKey: ["book", props.book.id] });
      qc.invalidateQueries({ queryKey: ["books"] });
    })
    .catch(() => {});
}

// ── keyboard ──────────────────────────────────────────────────────────────
// A page at a time. Space is the key people read with, and until now it did
// nothing here — the text reader had it, the PDF branch did not, so a reader
// who switched formats found their main key dead.
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (target?.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // The contents sheet and type panel keep their own arrows / Home / End;
  // paging the document under them is a fight.
  if (target instanceof Element && target.closest(".toc, .rp, .tb-more-menu")) return;

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
  if ((tocOpen.value || typeOpen.value || moreOpen.value) && pagingKey) return;
  if (document.querySelector(".hl-popover, .image-viewer, .settings-backdrop, .cp-backdrop, .modal-backdrop, .ctx-menu, .tag-picker")) return;
  if (e.repeat && pagingKey) {
    e.preventDefault();
    return;
  }

  const turn = (by: number) => turnPage(by);
  switch (e.key) {
    case " ":
    case "PageDown":
      e.preventDefault();
      turn(e.shiftKey ? -1 : 1);
      break;
    case "PageUp":
      e.preventDefault();
      turn(-1);
      break;
    case "Home":
      e.preventDefault();
      if (view.value === "text") textRef.value?.goToPage(1);
      else pdfRef.value?.goToPage(1);
      break;
    case "End":
      e.preventDefault();
      if (view.value === "text") textRef.value?.goToPage(pageCount.value);
      else if (pdfRef.value) pdfRef.value.goToPage(pdfRef.value.pageCount);
      break;
    case "ArrowDown":
    case "j":
      e.preventDefault();
      turn(1);
      break;
    case "ArrowUp":
    case "k":
      e.preventDefault();
      turn(-1);
      break;
    case "ArrowRight":
      e.preventDefault();
      turn(pageDirFromSide("right", ui.readerOrientation));
      break;
    case "ArrowLeft":
      e.preventDefault();
      turn(pageDirFromSide("left", ui.readerOrientation));
      break;
    case "c":
      e.preventDefault();
      moreOpen.value = false;
      typeOpen.value = false;
      tocOpen.value = !tocOpen.value;
      break;
    case "a":
      e.preventDefault();
      moreOpen.value = false;
      tocOpen.value = false;
      typeOpen.value = !typeOpen.value;
      break;
    case "+":
    case "=":
      if (view.value !== "page") break;
      e.preventDefault();
      pdfRef.value?.setZoom((pdfRef.value.zoom ?? 1) + 0.2);
      break;
    case "-":
    case "_":
      if (view.value !== "page") break;
      e.preventDefault();
      pdfRef.value?.setZoom((pdfRef.value.zoom ?? 1) - 0.2);
      break;
    case "0":
      if (view.value !== "page") break;
      e.preventDefault();
      void pdfRef.value?.fitWidth();
      break;
    case "Escape":
      if (moreOpen.value) moreOpen.value = false;
      else if (typeOpen.value) typeOpen.value = false;
      else if (tocOpen.value) tocOpen.value = false;
      else emit("close");
      break;
  }
}

// A search hit from the library opens the book at the page it was found on;
// the index it carries is the page's, counted from zero.
function applyPendingChapter(pending: number, snippet?: string | null) {
  if (ui.pendingHighlightId != null) {
    // 0 = a mark made in the prose view; anything else is a page number.
    if (pending > 0) goToPage(pending);
    else void showText();
    return;
  }
  goToPage(pending + 1);
  const needle = snippet ? snippetNeedle(snippet) : "";
  if (!needle) return;
  void nextTick().then(() => requestAnimationFrame(() => flashSnippet(needle)));
}

onMounted(async () => {
  window.addEventListener("keydown", onKey);
  const pending = ui.consumePendingChapter();
  const snippet = ui.consumePendingSnippet();
  if (pending != null) {
    await nextTick();
    applyPendingChapter(pending, snippet);
  }
});
watch(
  () => ui.pendingChapterIndex,
  (idx) => {
    if (idx == null) return;
    const pending = ui.consumePendingChapter();
    const snippet = ui.consumePendingSnippet();
    if (pending == null) return;
    applyPendingChapter(pending, snippet);
  },
);
watch(
  () => ui.pendingHighlightId,
  (id) => {
    if (id == null) return;
    const ch = ui.pendingChapterIndex;
    if (ch != null && ch > 0) {
      goToPage(ch);
      return;
    }
    void showText();
  },
);
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    class="reader reader-v2"
    @click="onReaderClick"
    @pointerdown.passive="onReaderPointerDown"
    @mousemove.passive="onReaderMove"
    @mouseleave="onReaderLeave"
  >
    <div
      class="reader-progress"
      role="progressbar"
      :aria-valuenow="Math.round(pdfPercent * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('reader.progressPct', { n: Math.round(pdfPercent * 100) })"
    >
      <div class="reader-progress-fill" :style="{ transform: `scaleX(${pdfPercent})` }" />
    </div>
    <div class="reader-chrome-hotzone" aria-hidden="true" />
    <div class="reader-chrome">
      <div class="reader-toolbar reader-toolbar-v2" v-bind="isMac ? { 'data-tauri-drag-region': true } : {}">
        <div class="tb-cluster-start">
          <button
            :class="['tb-btn', tocOpen ? 'on' : '']"
            @click="moreOpen = false; typeOpen = false; tocOpen = !tocOpen"
            :title="t('reader.toc')"
            :aria-label="t('reader.toc')"
            :aria-expanded="tocOpen"
          >
            <Icon name="toc" :size="16" />
          </button>
        </div>
        <div class="tb-title-stack">
          <span class="tb-title-primary" :title="book.title">{{ book.title }}</span>
        </div>
        <div class="tb-cluster-end">
          <div class="tb-cluster">
            <div class="tb-seg" role="group" :aria-label="t('reader.pdfView')">
              <button :class="{ on: view === 'page' }" :aria-pressed="view === 'page'" @click="showPage">
                {{ t("reader.pdfViewPage") }}
              </button>
              <button :class="{ on: view === 'text' }" :aria-pressed="view === 'text'" @click="showText">
                {{ t("reader.pdfViewText") }}
              </button>
            </div>
            <button
              :class="['tb-btn', 'tb-type', typeOpen ? 'on' : '']"
              @click="moreOpen = false; tocOpen = false; typeOpen = !typeOpen"
              :title="t('reader.type.title')"
              :aria-label="t('reader.type.title')"
              :aria-expanded="typeOpen"
            >
              <span class="tb-aa" aria-hidden="true">Aa</span>
            </button>
            <div class="tb-more" ref="moreEl">
              <button
                :class="['tb-btn', moreOpen ? 'on' : '']"
                @click="typeOpen = false; tocOpen = false; moreOpen = !moreOpen"
                :title="t('reader.more')"
                :aria-label="t('reader.more')"
                :aria-expanded="moreOpen"
                :aria-haspopup="true"
              >
                <Icon name="more" :size="16" />
              </button>
              <div v-if="moreOpen" ref="moreMenuEl" class="tb-more-menu" role="menu" @keydown="onMoreKey">
                <button role="menuitem" @click="pickMore(addBookmark)">
                  <Icon name="bookmark" :size="14" />
                  {{ t("reader.addBookmark") }}
                </button>
                <div class="tb-more-sep" />
                <button role="menuitem" :class="{ on: book.isFavorite }" @click="pickMore(favorite)">
                  <Icon :name="book.isFavorite ? 'star-fill' : 'star'" :size="14" />
                  {{ book.isFavorite ? t("library.unfavorite") : t("library.favorite") }}
                </button>
                <button role="menuitem" :class="{ on: book.isFinished }" @click="pickMore(finish)">
                  <Icon name="check-all" :size="14" />
                  {{ book.isFinished ? t("library.markUnfinished") : t("library.markFinished") }}
                </button>
                <button
                  role="menuitem"
                  :class="{ on: ui.focusMode }"
                  @click="pickMore(() => ui.setFocusMode(!ui.focusMode))"
                >
                  <Icon name="focus" :size="14" />
                  {{ t("reader.focus") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ReaderTypography
        v-if="typeOpen"
        :book-id="book.id"
        :is-pdf="view === 'page'"
        :on-close="() => (typeOpen = false)"
        :on-open-settings="() => { typeOpen = false; emit('open-settings', 'reading'); }"
      />
    </div>

    <!-- Kept mounted behind the text view: it owns the document, and tearing
         it down to read the prose would mean loading the file again to go
         back to the page. -->
    <PdfReader
      v-show="view === 'page'"
      ref="pdfRef"
      :book="book"
      @toast="(s: string) => emit('toast', s)"
      @outline="(o) => (outline = o)"
      @page="(p: number) => (atPage = p)"
      @ready="onPdfReady"
      @end="maybeFinish"
    />

    <PdfTextView
      v-if="view === 'text'"
      ref="textRef"
      :book-id="book.id"
      :blocks="blocks"
      :loading="reflowing"
      :page="atPage"
      :pages="pageCount"
      :status-visible="!tocOpen && !typeOpen"
      @page="(p: number) => (atPage = p)"
    />

    <div v-if="ui.readerWarmth > 0" class="reader-warm" aria-hidden="true" />

    <TocPane
      v-if="tocOpen"
      :chapters="tocChapters"
      :current="tocCurrent"
      :here="atPage"
      :book-id="book.id"
      :sections="[]"
      :active-section="-1"
      :search-in="searchPages"
      :meta-for="(ch) => t('reader.pageNo', { n: ch.index })"
      @select="goToPage"
      @select-hit="onSelectHit"
      @focus-highlight="focusHighlight"
      @close="tocOpen = false"
    />
  </div>
</template>
