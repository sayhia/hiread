<script setup lang="ts">
// Everywhere in this book a reader can go, in one sheet over the left edge of
// the reader: its chapters, the passages a search turns up, and the places they
// marked to come back to. Picking any of them is the same gesture.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import * as api from "../../../api";
import { useUi } from "../../../stores/ui";
import { useFocusTrap } from "../../../composables/useFocusTrap";
import { reportError } from "../../../stores/toasts";
import { relTime } from "../../../lib/time";
import { highlightSwatch } from "../../../lib/highlightColors";
import type { Bookmark, Chapter, HighlightWithContext, SearchHit } from "../../../types";
import Icon from "../../Icon.vue";

const props = defineProps<{
  chapters: Chapter[];
  current: number;
  /** Exact place the reader is (a PDF page). When set, “already here”
   *  means this page, not the last outline dest. */
  here?: number;
  bookId: number;
  /** Headings inside the chapter being read, when it has more than one. Many
   *  books call a whole part a chapter, so this is how you get to a section of
   *  it — the book's own contents stops at the part. */
  sections: { id: number; text: string; level: number }[];
  /** Which of them the reader is currently inside, or -1. */
  activeSection: number;
  /** How to search this book, when it is not the library's index that knows.
   *  A PDF contributes nothing to that index — its pages are drawings — so it
   *  passes its own search over the text behind them. */
  searchIn?: (query: string) => Promise<SearchHit[]>;
  /** What to show after an entry's title. Defaults to how long the chapter
   *  takes to read; a PDF's outline has no such thing, so it says which page. */
  metaFor?: (chapter: Chapter) => string;
}>();

const emit = defineEmits<{
  (e: "select", index: number, ratio?: number): void;
  (e: "select-hit", hit: SearchHit): void;
  (e: "select-section", id: number): void;
  (e: "focus-highlight", index: number, highlightId: number): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
const ui = useUi();
const qc = useQueryClient();

/** The two lists the sheet holds. Search results replace whichever is showing,
 *  since a search is a third way of answering the same question. */
const tab = ref<"contents" | "bookmarks" | "notes">("contents");

/** The line after an entry's title. A chapter says how long it takes to read —
 *  when the reader asked for that — and anything with no text behind it says
 *  whatever the caller wants, or nothing. */
function entryMeta(ch: Chapter): string {
  if (props.metaFor) return props.metaFor(ch);
  if (!ui.prefs.showReadingTime || ch.charCount <= 0) return "";
  return t("reader.minutes", { n: Math.max(1, Math.round(ch.charCount / 300)) });
}

const bookmarks = useQuery({
  queryKey: computed(() => ["bookmarks", props.bookId] as const),
  queryFn: () => api.listBookmarks(props.bookId),
  staleTime: 30_000,
});
const marks = computed<Bookmark[]>(() => bookmarks.data.value ?? []);

// Per-chapter lookups precomputed once per chapters change. The template asks
// for an entry's meta, level and title repeatedly (a 1000-chapter book does it
// 2-4× per row per render); entryMeta itself may run i18n and a caller-supplied
// callback, and chapterTitle used to be an O(chapters) find per call.
const metaByIndex = computed(() => new Map(props.chapters.map((ch) => [ch.index, entryMeta(ch)])));
const levelByIndex = computed(() => new Map(props.chapters.map((ch) => [ch.index, Math.min(ch.level, 4)])));
const titleByIndex = computed(() => new Map(props.chapters.map((ch) => [ch.index, ch.title])));

const notes = useQuery({
  queryKey: computed(() => ["book-highlights", props.bookId] as const),
  queryFn: () => api.listBookHighlights(props.bookId),
  staleTime: 30_000,
});
const marked = computed<HighlightWithContext[]>(() => notes.data.value ?? []);

function removeBookmark(id: number) {
  api
    .deleteBookmark(id)
    .then(() => qc.invalidateQueries({ queryKey: ["bookmarks", props.bookId] }))
    .catch(reportError);
}

const panel = ref<HTMLDivElement>();
useFocusTrap(panel);

// Arrow-key navigation through the panel: whatever the active tab lists
// (chapters/sections, hits, notes, bookmarks). The tab bar itself is left to
// the Tab key — folding it into the wrap-around ring would jump from the last
// row to a tab on a Down arrow. Skips the search input (its arrows move the
// caret) and wraps at the ends. Mirrors the HighlightsPane / Library
// arrow-key handling.
function onPanelKeydown(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (!t || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const items = Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      ".toc-item, .toc-section, .toc-hit, .toc-note, .toc-mark-go, .toc-mark-del",
    ) ?? [],
  ).filter((el) => el.offsetParent !== null); // the visible tab's rows only
  if (items.length === 0) return;
  const cur = items.indexOf(t);
  let next: number;
  const vertical = ui.readerOrientation === "vertical";
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !vertical) return;
  const forward = e.key === "ArrowDown" || (vertical && e.key === "ArrowLeft");
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else if (cur < 0) next = forward ? 0 : items.length - 1;
  else next = (cur + (forward ? 1 : -1) + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
  items[next].scrollIntoView({ block: "nearest" });
}

const search = ref("");
const hits = ref<SearchHit[]>([]);
const searching = ref(false);
let seq = 0;

// In-book search runs on a debounce: every keystroke would otherwise be an FTS
// query over the whole book.
let timer: number | undefined;
watch(search, (q) => {
  window.clearTimeout(timer);
  const text = q.trim();
  if (!text) {
    hits.value = [];
    searching.value = false;
    return;
  }
  searching.value = true;
  const mine = ++seq;
  timer = window.setTimeout(async () => {
    try {
      const found = props.searchIn
        ? await props.searchIn(text)
        : await api.searchLibrary(text, props.bookId, 40);
      // A slower earlier query must not overwrite a newer one's results.
      if (mine === seq) hits.value = found;
    } finally {
      if (mine === seq) searching.value = false;
    }
  }, 220);
});

/** Scroll the current chapter into view when the sheet opens: a 300-chapter
 *  book otherwise opens at entry one, far from where the reader is. */
onBeforeUnmount(() => window.clearTimeout(timer));
onMounted(() => {
  panel.value?.querySelector<HTMLElement>(".toc-search input")?.focus();
  document.querySelector(".toc-item.current")?.scrollIntoView?.({ block: "center" });
});

const showingHits = computed(() => search.value.trim().length > 0);

const TABS = ["contents", "bookmarks", "notes"] as const;
function onTabKey(e: KeyboardEvent) {
  const i = TABS.indexOf(tab.value);
  let nextTab: (typeof TABS)[number] | undefined;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    nextTab = TABS[(i + 1) % TABS.length];
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    nextTab = TABS[(i - 1 + TABS.length) % TABS.length];
  } else if (e.key === "Home") {
    nextTab = TABS[0];
  } else if (e.key === "End") {
    nextTab = TABS[TABS.length - 1];
  }
  if (!nextTab) return;
  e.preventDefault();
  e.stopPropagation();
  tab.value = nextTab;
  void nextTick(() => {
    panel.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
}

function onSearchEsc(e: KeyboardEvent) {
  e.stopPropagation();
  if (search.value) search.value = "";
  else emit("close");
}

function onSearchEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  const hit = hits.value[0];
  if (!hit) return;
  e.preventDefault();
  emit("select-hit", hit);
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    onSearchEsc(e);
    return;
  }
  if (e.key === "Enter") {
    onSearchEnter(e);
    return;
  }
  if (e.key === "ArrowDown" && hits.value.length) {
    e.preventDefault();
    e.stopPropagation();
    panel.value?.querySelector<HTMLElement>(".toc-hit")?.focus();
    return;
  }
  if ((e.key === "g" && (e.metaKey || e.ctrlKey)) || e.key === "F3") {
    if (!hits.value.length) return;
    e.preventDefault();
    const i = hitCursor.value;
    const next = e.shiftKey ? (i <= 0 ? hits.value.length - 1 : i - 1) : (i + 1) % hits.value.length;
    hitCursor.value = next;
    emit("select-hit", hits.value[next]);
  }
}

const hitCursor = ref(-1);
watch(hits, () => { hitCursor.value = hits.value.length ? 0 : -1; });
</script>

<template>
  <div class="toc-backdrop" @click="emit('close')">
    <aside class="toc" ref="panel" role="dialog" aria-modal="true" :aria-label="t('reader.toc')" @click.stop @keydown="onPanelKeydown">
      <header class="toc-head">
        <h2 class="toc-title">{{ t("reader.toc") }}</h2>
        <button class="tb-btn" @click="emit('close')" :aria-label="t('common.close')">
          <Icon name="x" :size="14" />
        </button>
      </header>

      <div class="toc-tabs" role="tablist" :aria-label="t('reader.toc')" @keydown="onTabKey">
        <button
          role="tab"
          :aria-selected="tab === 'contents'"
          :tabindex="tab === 'contents' ? 0 : -1"
          :class="{ on: tab === 'contents' }"
          @click="tab = 'contents'"
        >
          {{ t("reader.toc") }}
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'bookmarks'"
          :tabindex="tab === 'bookmarks' ? 0 : -1"
          :class="{ on: tab === 'bookmarks' }"
          @click="tab = 'bookmarks'"
        >
          {{ t("reader.bookmarks") }}
          <span v-if="marks.length" class="toc-tab-count">{{ marks.length }}</span>
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'notes'"
          :tabindex="tab === 'notes' ? 0 : -1"
          :class="{ on: tab === 'notes' }"
          @click="tab = 'notes'"
        >
          {{ t("reader.notes") }}
          <span v-if="marked.length" class="toc-tab-count">{{ marked.length }}</span>
        </button>
      </div>

      <div class="toc-search">
        <Icon name="search" :size="13" />
        <input
          v-model="search"
          type="search"
          :placeholder="t('reader.searchInBook')"
          :aria-label="t('reader.searchInBook')"
          @keydown="onSearchKeydown"
        />
      </div>

      <div class="toc-scroll">
        <template v-if="showingHits">
          <div v-if="searching" class="toc-empty">{{ t("common.loading") }}</div>
          <div v-else-if="!hits.length" class="toc-empty">{{ t("reader.noHits") }}</div>
          <button
            v-for="(h, i) in hits"
            :key="`${h.chapterIndex}:${i}`"
            class="toc-hit"
            @click="emit('select-hit', h)"
          >
            <span class="toc-hit-chapter">
              {{ h.chapterTitle || t("reader.pageNo", { n: h.chapterIndex + 1 }) }}
            </span>
            <span class="toc-hit-snippet" v-html="h.snippet" />
          </button>
        </template>

        <template v-else-if="tab === 'notes'">
          <div v-if="!marked.length" class="toc-empty">{{ t("reader.noNotes") }}</div>
          <button
            v-for="h in marked"
            :key="h.id"
            class="toc-note"
            @click="emit('focus-highlight', h.chapterIndex, h.id)"
          >
            <span class="toc-note-quote" :style="{ borderColor: highlightSwatch(h.color) }">
              {{ h.quote }}
            </span>
            <span v-if="h.note" class="toc-note-note">{{ h.note }}</span>
            <span class="toc-note-meta">{{ h.chapterTitle || titleByIndex.get(h.chapterIndex) }}</span>
          </button>
        </template>

        <template v-else-if="tab === 'bookmarks'">
          <div v-if="!marks.length" class="toc-empty">{{ t("reader.noBookmarks") }}</div>
          <div v-for="m in marks" :key="m.id" class="toc-mark">
            <button class="toc-mark-go" @click="emit('select', m.page || m.chapterIndex, m.chapterRatio)">
              <span class="toc-mark-label">{{ m.label || titleByIndex.get(m.chapterIndex) }}</span>
              <span class="toc-mark-meta">
                {{ titleByIndex.get(m.chapterIndex) }} · {{ relTime(m.createdAt) }}
              </span>
            </button>
            <button
              class="toc-mark-del"
              @click="removeBookmark(m.id)"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>
        </template>

        <template v-else>
          <!-- A PDF has pages rather than chapters, so its contents is empty —
               the sheet is still worth opening for the marks in the other two
               tabs, but it should say so rather than show a blank panel. -->
          <div v-if="!chapters.length" class="toc-empty">{{ t("reader.noChapters") }}</div>
          <template v-for="ch in chapters" :key="ch.index">
            <button
              class="toc-item"
              :class="{ current: ch.index === current }"
              :style="{ paddingLeft: `${12 + (levelByIndex.get(ch.index) ?? 0) * 14}px` }"
              :aria-current="ch.index === current || undefined"
              @click="ch.index === (here ?? current) ? emit('close') : emit('select', ch.index)"
            >
              <span class="toc-item-title">{{ ch.title }}</span>
              <span v-if="metaByIndex.get(ch.index)" class="toc-item-time">{{ metaByIndex.get(ch.index) }}</span>
            </button>
            <!-- The chapter being read opens up: its own headings sit under it,
                 indented past it, so the outline reads as one list. -->
            <button
              v-for="s in ch.index === current ? sections : []"
              :key="`s${s.id}`"
              class="toc-item toc-section"
              :class="{ current: s.id === activeSection }"
              :style="{ paddingLeft: `${26 + (levelByIndex.get(ch.index) ?? 0) * 14 + Math.max(0, s.level - 2) * 12}px` }"
              @click="emit('select-section', s.id)"
            >
              <span class="toc-item-title">{{ s.text }}</span>
            </button>
          </template>
        </template>
      </div>
    </aside>
  </div>
</template>
