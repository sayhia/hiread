<script setup lang="ts">
// A PDF, read as prose.
//
// Its pages are pictures of type: nothing about the reader's own typography
// reaches them, and neither does anything built on text. Read back into
// paragraphs (lib/pdfText) and rendered into the same sheet every other format
// uses, a PDF gains all of it at once — the face and its size, the measure,
// the page colour, the margins.
//
// It is offered beside the page view rather than instead of it. Reading a
// layout is an inference and a layout can lie: a table of contents comes back
// as fragments, a table comes back as prose. The page is always one press
// away, and that is the answer to every place this gets it wrong.

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../../../api";
import { useUi } from "../../../stores/ui";
import type { Block } from "../../../lib/pdfText";
import { metrics, scrollTo, stepFor } from "../../../lib/reading/position";
import HighlightLayer from "../../HighlightLayer.vue";
import ReaderStatus from "../text/ReaderStatus.vue";

const props = defineProps<{
  bookId: number;
  blocks: Block[];
  loading: boolean;
  /** Where the reader is in the page view, so opening this lands there. */
  page: number;
  /** How many pages the document has, so the status line can say "12 of 411". */
  pages?: number;
  /** Hide the foot line under a drawer the way the text reader does. */
  statusVisible?: boolean;
}>();

const emit = defineEmits<{
  /** The page the reader has reached here, so the page view lands there when
   *  they switch back — and so progress is saved against the same measure the
   *  rest of the book uses. */
  (e: "page", page: number): void;
}>();

const { t } = useI18n();
const ui = useUi();

const scrollRef = ref<HTMLDivElement>();
const bodyRef = ref<HTMLDivElement>();

/** Blocks carry the page they came from, so the two views agree on where the
 *  reader is without either having to know about the other's geometry. */
function scrollToPage(page: number) {
  const el = scrollRef.value;
  const body = bodyRef.value;
  if (!el || !body) return;
  const target = body.querySelector<HTMLElement>(`[data-page="${page}"]`)
    // A page whose text was all furniture has no block of its own; the next
    // one that does is where the reader means.
    ?? Array.from(body.querySelectorAll<HTMLElement>("[data-page]")).find(
      (b) => Number(b.dataset.page) >= page,
    );
  if (!target) return;
  const base = el.getBoundingClientRect().top - el.scrollTop;
  el.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - base - 12) });
}

/** Which page the reader is on, from the topmost block on screen. Runs at
 *  most once per frame (rAF) and binary-searches a cached block list, so a
 *  long text view no longer re-queries the DOM and re-reads every block's
 *  rect on each scroll event. */
let saveTimer: number | undefined;
let lastPage = props.page;
let scrollRaf = 0;
/** Cached block elements, refreshed whenever the blocks list is rebuilt. */
let blockEls: HTMLElement[] = [];
function refreshBlockEls() {
  const body = bodyRef.value;
  blockEls = body ? Array.from(body.querySelectorAll<HTMLElement>("[data-page]")) : [];
}
function onScroll() {
  const el = scrollRef.value;
  if (!el) return;
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const top = el.getBoundingClientRect().top + 8;
      let lo = 0;
      let hi = blockEls.length - 1;
      let page = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (blockEls[mid].getBoundingClientRect().bottom < top) {
          page = Number(blockEls[mid].dataset.page);
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (!page) page = Number(blockEls[0]?.dataset.page) || 1;
      lastPage = page;
      emit("page", page);
    });
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    // Saved as a page, the same measure the page view uses: one book, one
    // place in it, whichever view the reader left it in.
    api.saveProgress(props.bookId, 0, 0, lastPage).catch(() => {});
  }, 600);
}

const empty = computed(() => !props.loading && props.blocks.length === 0);

function lastBlockPage() {
  let m = 1;
  for (const b of props.blocks) if (b.page > m) m = b.page;
  return m;
}

function pageBound() {
  // Bound by extracted prose, not the file's page count — a scanned tail
  // has no [data-page] and scrolling there used to claim page 411 while
  // the article stayed on the last real paragraph.
  return lastBlockPage();
}

function goToPage(page: number) {
  const at = Math.min(pageBound(), Math.max(1, Math.round(page) || lastPage || props.page || 1));
  lastPage = at;
  emit("page", at);
  requestAnimationFrame(() => scrollToPage(at));
}

/** One screenful, less the overlap that keeps a reader's place. The
 *  extracted page can be many screens after reflow — or a single
 *  paragraph — so paging by file page was the wrong unit. onScroll
 *  keeps the page view in sync. The scroller is forced to run down
 *  (styles.css) even when the rest of the app is 古籍. */
function pageBy(dir: number) {
  const el = scrollRef.value;
  if (!el) return;
  const d = dir < 0 ? -1 : 1;
  const m = metrics(el, "y");
  scrollTo(el, "y", m.at + d * stepFor(m, "y", ui.readerLeading), true);
  onScroll();
}

function flushSave() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const page = lastPage || props.page;
  if (page > 0) api.saveProgress(props.bookId, 0, 0, page).catch(() => {});
}

onMounted(() => {
  refreshBlockEls();
  scrollToPage(props.page);
});
watch(
  () => props.blocks.length,
  () => {
    if (props.blocks.length) {
      requestAnimationFrame(() => {
        refreshBlockEls();
        scrollToPage(props.page);
      });
    }
  },
);
watch(
  () => props.page,
  (p) => {
    if (p > 0 && p !== lastPage) requestAnimationFrame(() => scrollToPage(p));
  },
);
// Typography changes the body's geometry; land back on the same page so the
// reader does not jump to the top of a reflowed sheet.
watch(
  () =>
    [
      ui.readerSize,
      ui.readerLeading,
      ui.readerWidth,
      ui.readerPadX,
      ui.readerPadY,
      ui.readerFont,
      ui.readerTracking,
      ui.readerParaGap,
      ui.readerIndent,
      ui.readerJustify,
      ui.readerTypeset,
      ui.readerColumns,
      ui.readerOrientation,
    ] as const,
  () => {
    requestAnimationFrame(() => scrollToPage(lastPage || props.page));
  },
);
onBeforeUnmount(() => {
  flushSave();
  cancelAnimationFrame(scrollRaf);
});

defineExpose({ goToPage, pageBy });
</script>

<template>
  <div class="pdf-text">
    <div
      class="reader-scroll"
      ref="scrollRef"
      :style="{ '--reader-width': `${ui.readerWidth}px` }"
      @scroll.passive="onScroll"
    >
      <div v-if="loading" class="empty" :style="{ flex: 1 }">
        <div class="ai-loading">
          <span class="ai-dot" /><span class="ai-dot" /><span class="ai-dot" />
        </div>
        <div>{{ t("reader.pdfReading") }}</div>
      </div>

      <div v-else-if="empty" class="empty" :style="{ flex: 1 }">
        <div>{{ t("reader.pdfNoText") }}</div>
      </div>

      <article v-else class="article reader-content">
        <div class="article-body" ref="bodyRef">
          <template v-for="(b, i) in blocks" :key="i">
            <h2 v-if="b.kind === 'heading'" :data-page="b.page">{{ b.text }}</h2>
            <p v-else :data-page="b.page">{{ b.text }}</p>
          </template>
        </div>
      </article>
    </div>

    <ReaderStatus
      :page="page"
      :pages="pages"
      :ratio="pages ? page / pages : 0"
      :visible="(statusVisible ?? true) && !loading && !empty"
    />

    <HighlightLayer
      v-if="bodyRef && !loading && !empty"
      :book-id="bookId"
      :chapter-index="0"
      :scroll-el="scrollRef ?? null"
      :body-el="bodyRef ?? null"
      axis="y"
    />
  </div>
</template>
