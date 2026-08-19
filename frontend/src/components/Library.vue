<script setup lang="ts">
// The middle pane: the library grid. Shows whatever the sidebar selection
// resolves to, filtered by the header's search box and ordered by its sort
// menu, with the import affordances (button, drag-and-drop) that put books
// there in the first place.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/vue-query";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { Events } from "@wailsio/runtime";
import * as api from "../api";
import { useUi } from "../stores/ui";
import { reportError, toast, withUndo } from "../stores/toasts";
import { pendingBookDeletes } from "../lib/pendingDeletes";
import type { Book, BookSort, Collection, ImportResult } from "../types";
import BookCard from "./BookCard.vue";
import ContextMenu, { type MenuEntry } from "./ContextMenu.vue";
import Icon from "./Icon.vue";
import TagPicker from "./TagPicker.vue";
import { useDismiss } from "../composables/useDismiss";
import { useMenuKeyboard } from "../composables/useMenuKeyboard";

const emit = defineEmits<{
  (e: "toast", text: string): void;
  (e: "details", bookId: number): void;
}>();

const { t } = useI18n();
const ui = useUi();
const qc = useQueryClient();

const SORTS: BookSort[] = ["recent", "added", "title", "author", "progress"];
const sortOpen = ref(false);
const sortEl = ref<HTMLDivElement>();
useDismiss(sortEl, () => {
  sortOpen.value = false;
}, { enabled: () => sortOpen.value });
const onSortKey = useMenuKeyboard(sortEl, sortOpen);
const importing = ref(false);
const dragging = ref(false);
// dragenter/leave fire on every child; a depth counter keeps the veil up
// until the pointer actually leaves the pane.
let dragDepth = 0;

// The grid filters as the user types, but every keystroke used to fire a
// Wails IPC round-trip. Debounce the *query* input; the input box itself still
// tracks ui.filterText live, so nothing about typing feels delayed.
const debouncedFilter = ref(ui.filterText);
let filterTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => ui.filterText,
  (v) => {
    clearTimeout(filterTimer);
    // Clearing must hit the query immediately — a 200ms empty flash of the
    // previous (empty) result reads as "search is broken".
    if (!v) {
      debouncedFilter.value = "";
      return;
    }
    filterTimer = setTimeout(() => (debouncedFilter.value = v), 200);
  },
);

const PAGE = 200;
const books = useInfiniteQuery({
  queryKey: computed(() => ["books", ui.query, ui.bookSort, debouncedFilter.value] as const),
  queryFn: ({ pageParam }) =>
    api.listBooks(ui.query, ui.bookSort, PAGE, pageParam, debouncedFilter.value),
  initialPageParam: 0,
  getNextPageParam: (lastPage, allPages) =>
    lastPage.length < PAGE ? undefined : allPages.reduce((n, p) => n + p.length, 0),
  // The shelf is stable between edits; keep the last fetch warm so switching
  // middle panes does not refetch the whole library on every remount.
  staleTime: 30_000,
});

const list = computed<Book[]>(() => books.data.value?.pages.flat() ?? []);
const focusedId = ref<number | null>(null);

watch(list, (rows) => {
  if (focusedId.value != null && rows.some((b) => b.id === focusedId.value)) return;
  focusedId.value = rows[0]?.id ?? null;
});

// A library-changed event means an import, a delete or a flag flip landed —
// anywhere in the app, or from hiread-cli in another process.
let offLibrary: (() => void) | null = null;
let offImported: (() => void) | null = null;
// The scroll container the virtualizer scrolls and measures against.
const gridRef = ref<HTMLElement | null>(null);

// ── virtualized grid ────────────────────────────────────────────────────────
// The shelf is rendered in rows of `cols` cards, virtualized so a library of
// hundreds of books mounts only the rows on screen — a plain v-for mounted
// every card at once (and every card's cover query with it).
const MIN_CARD = 128; // the grid's minmax() minimum, in px
const measuredCols = ref(1);
// List is always one column. Keep this a computed so a switch to list cannot
// render one frame of grid columns (that is what stacked the covers).
const cols = computed(() => (ui.viewMode === "list" ? 1 : measuredCols.value));
// WKWebView rejects `repeat(var(--grid-cols), …)` unless the property is
// registered as an <integer>. An inline track list is always valid.
const rowTracks = computed(() =>
  ui.viewMode === "list" ? "1fr" : `repeat(${cols.value}, minmax(0, 1fr))`,
);
let colObserver: ResizeObserver | null = null;

function measureCols() {
  const el = gridRef.value;
  if (!el || ui.viewMode === "list") return;
  const gap = parseFloat(getComputedStyle(el).getPropertyValue("--list-px")) || 16;
  // The virtual grid has margin-inline: var(--list-px); count columns against
  // the cards' actual track, not the scrollport.
  const width = Math.max(0, el.clientWidth - gap * 2);
  measuredCols.value = Math.max(1, Math.floor((width + gap) / (MIN_CARD + gap)));
}

watch([() => ui.viewMode, () => ui.density], async () => {
  measureCols();
  gridRef.value && (gridRef.value.scrollTop = 0);
  await nextTick();
  virtualizer.value.measure();
  requestAnimationFrame(() => virtualizer.value.measure());
});

// The whole options object is a computed: TanStack resolves the options'
// plain values reactively (a bare `count: computed(...)` would hand it a
// ComputedRef to compare as a number). count here is the plain value each
// recomputation produces.
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: Math.ceil(list.value.length / Math.max(1, cols.value)),
    getScrollElement: () => gridRef.value,
    estimateSize: () => (ui.viewMode === "list" ? 56 : 280),
    overscan: 3,
    // Scope the key by layout so a 56px list measurement cannot be reused
    // as a grid row (that is the "books piled on top of each other" bug).
    getItemKey: (index) => {
      const id = list.value[index * Math.max(1, cols.value)]?.id ?? `row-${index}`;
      return `${ui.viewMode}:${ui.density}:${cols.value}:${id}`;
    },
    // Always read the box. The default measurer returns a cached height when
    // called without a ResizeObserver entry, which is how list-row 56px
    // survived onto the cover wall after a mode switch.
    measureElement: (el) => el.offsetHeight,
  })),
);
// Guarded: before the scroll container mounts (first render) the virtualizer
// has no scroll element, and asking it for items then throws. useVirtualizer
// returns a Ref<Virtualizer>, so its methods go through .value.
const virtualRows = computed(() => (gridRef.value ? virtualizer.value.getVirtualItems() : []));
const virtualTotal = computed(() => (gridRef.value ? virtualizer.value.getTotalSize() + 40 : 0));

watch(virtualRows, (rows) => {
  if (!rows.length || !books.hasNextPage.value || books.isFetchingNextPage.value) return;
  const last = rows[rows.length - 1];
  const rowCount = Math.ceil(list.value.length / Math.max(1, cols.value));
  if (last.index >= rowCount - 4) void books.fetchNextPage();
});
// A filter used to show "200+" forever: only the first page loaded until
// the user scrolled. Pull the rest so the title count can settle.
watch(
  [debouncedFilter, () => books.hasNextPage.value, () => books.isFetchingNextPage.value],
  ([q, more, busy]) => {
    if (q && more && !busy) void books.fetchNextPage();
  },
);
const rowBooks = (row: number): Book[] => {
  const start = row * cols.value;
  return list.value.slice(start, start + cols.value);
};
function rowSig(row: number): string {
  return rowBooks(row)
    .map((b) =>
      [
        b.id,
        b.isFavorite ? 1 : 0,
        b.isFinished ? 1 : 0,
        Math.round(b.percent * 1000),
        b.title,
        b.author ?? "",
        b.collectionId ?? "",
        (b.tags ?? []).map((tg) => tg.id).join(","),
      ].join(":"),
    )
    .join("|");
}
function measureRow(el: Element | ComponentPublicInstance | null) {
  // The ref callback also fires for component instances; only DOM elements
  // have a height worth measuring.
  if (el instanceof HTMLElement) virtualizer.value.measureElement(el);
}

function openFocused(id: number) {
  focusedId.value = id;
  ui.openBook(id);
}

function focusAt(index: number) {
  const book = list.value[index];
  if (!book) return;
  focusedId.value = book.id;
  virtualizer.value.scrollToIndex(Math.floor(index / Math.max(1, cols.value)), { align: "auto" });
}

/** Arrow keys move a focus ring on the cover wall; Enter opens. Opening used
 *  to be the only way to have a selected card, which made arrows a no-op
 *  (selectedBookId also mounts the reader overlay). */
function onLibraryKeydown(e: KeyboardEvent) {
  if (ui.middlePane !== "library") return;
  if (ui.selectedBookId != null || document.querySelector(".reader-overlay")) return;
  if (document.querySelector(".settings-backdrop, .cp-backdrop, .modal-backdrop, .ctx-menu, .tag-picker, .hl-popover, .image-viewer")) return;
  const t = e.target;
  if (t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]")) return;
  const n = list.value.length;
  if (n === 0) return;
  if (e.key === "Enter") {
    if (focusedId.value != null) {
      e.preventDefault();
      ui.openBook(focusedId.value);
    }
    return;
  }
  if (e.key === "Home") {
    e.preventDefault();
    focusAt(0);
    return;
  }
  if (e.key === "End") {
    e.preventDefault();
    focusAt(n - 1);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    const book = list.value.find((b) => b.id === focusedId.value);
    if (book) {
      e.preventDefault();
      removeBook(book);
    }
    return;
  }
  const dirs: Record<string, string> = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  };
  const dir = dirs[e.key];
  if (!dir) return;
  const c = cols.value;
  if (c < 1) return;
  let cur = list.value.findIndex((b) => b.id === focusedId.value);
  if (cur < 0) cur = 0;
  const row = Math.floor(cur / c);
  const col = cur % c;
  let target = -1;
  if (dir === "left" && col > 0) target = cur - 1;
  else if (dir === "right" && col < c - 1 && cur + 1 < n) target = cur + 1;
  else if (dir === "up" && row > 0) target = cur - c;
  else if (dir === "down" && row < Math.ceil(n / c) - 1) target = Math.min(cur + c, n - 1);
  if (target < 0) return;
  e.preventDefault();
  focusAt(target);
}

onMounted(() => {
  offLibrary = Events.On("library-changed", () => {
    qc.invalidateQueries({ queryKey: ["books"] });
    qc.invalidateQueries({ queryKey: ["libraryCounts"] });
    qc.invalidateQueries({ queryKey: ["collections"] });
  });
  offImported = Events.On("books-imported", (ev: { data?: unknown }) => {
    const raw = ev && typeof ev === "object" && "data" in ev ? ev.data : ev;
    reportImport(Array.isArray(raw) ? (raw as ImportResult[]) : []);
  });
  window.addEventListener("keydown", onLibraryKeydown);
  measureCols();
  if (gridRef.value) {
    colObserver = new ResizeObserver(measureCols);
    colObserver.observe(gridRef.value);
  }
  // The virtualizer's own watch can miss the template-ref assignment in some
  // environments, leaving it without a scroll element (and thus no items).
  // _willUpdate is idempotent — harmless when it already picked the element up.
  virtualizer.value._willUpdate();
});
onBeforeUnmount(() => {
  offLibrary?.();
  offImported?.();
  window.removeEventListener("keydown", onLibraryKeydown);
  colObserver?.disconnect();
  clearTimeout(filterTimer);
});

// ── import ──

/** Report an import batch as one toast: the common case is "n books added",
 *  and only the failures need naming. */
function reportImport(results: ImportResult[]) {
  const added = results.filter((r) => !r.error && !r.duplicate);
  const dupes = results.filter((r) => r.duplicate);
  const failed = results.filter((r) => r.error);
  if (added.length) {
    emit("toast", added.length === 1 ? t("library.imported", { title: added[0].title }) : t("library.importedN", { n: added.length }));
  }
  if (dupes.length) {
    emit("toast", t("library.alreadyInLibrary", { n: dupes.length }));
  }
  for (const f of failed) {
    toast.error(t("library.importFailed", { file: f.fileName, reason: t(`error.${f.error}`) }));
  }
  if (added.length) {
    qc.invalidateQueries({ queryKey: ["books"] });
    void placeOnCurrentShelf(added);
  }
}

async function placeOnCurrentShelf(added: ImportResult[]) {
  const q = ui.query;
  if (q.kind !== "collection" && q.kind !== "tag") return;
  for (const r of added) {
    if (!r.bookId) continue;
    try {
      if (q.kind === "collection") await api.setBookCollection(r.bookId, q.value);
      else await api.setBookTag(r.bookId, q.value, true);
    } catch (e) {
      reportError(e);
    }
  }
  qc.invalidateQueries({ queryKey: ["books"] });
  qc.invalidateQueries({ queryKey: ["collections"] });
  qc.invalidateQueries({ queryKey: ["tags"] });
}

async function pickBooks() {
  if (importing.value) return;
  importing.value = true;
  try {
    reportImport(await api.pickAndImport());
  } catch (e) {
    reportError(e);
  } finally {
    importing.value = false;
  }
}

/** True only for a drag carrying files from outside the app — dragging a shelf
 *  across the library must not raise the "drop books here" overlay. */
function hasFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
}

function onFileDragEnter(ev: DragEvent) {
  if (!hasFiles(ev)) return;
  dragDepth += 1;
  dragging.value = true;
}

function onFileDragOver(ev: DragEvent) {
  if (!hasFiles(ev)) {
    dragging.value = false;
    return;
  }
  ev.preventDefault();
  dragging.value = true;
}

function onFileDragLeave(ev: DragEvent) {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

const emptyCopy = computed(() => {
  switch (ui.query.kind) {
    case "favorite":
      return { title: t("library.emptyFavorites"), hint: t("library.emptyFavoritesHint"), add: false };
    case "finished":
      return { title: t("library.emptyFinished"), hint: t("library.emptyFinishedHint"), add: false };
    case "reading":
      return { title: t("library.emptyReading"), hint: t("library.emptyReadingHint"), add: false };
    case "collection":
      return { title: t("library.emptyShelf"), hint: t("library.emptyShelfHint"), add: true };
    case "tag":
      return { title: t("library.emptyTag"), hint: t("library.emptyTagHint"), add: false };
    default:
      return { title: t("library.emptyTitle"), hint: t("library.emptyHint"), add: true };
  }
});

/** A drop onto the window. The webview hands over File objects rather than
 *  paths, so the bytes are shipped across the bridge. */
async function onDrop(ev: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  const files = Array.from(ev.dataTransfer?.files ?? []);
  if (!files.length) return;
  importing.value = true;
  try {
    const results: ImportResult[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push(await api.importBytes(file.name, bytes));
    }
    reportImport(results);
  } catch (e) {
    reportError(e);
  } finally {
    importing.value = false;
  }
}

// ── per-book actions ──

const menu = ref<{ x: number; y: number; book: Book } | null>(null);
const tagPick = ref<{ x: number; y: number; book: Book } | null>(null);
const shelfPick = ref<{ x: number; y: number; book: Book } | null>(null);
const collections = useQuery({ queryKey: ["collections"], queryFn: api.listCollections, staleTime: 30_000 });
const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, staleTime: 30_000 });
const counts = useQuery({ queryKey: ["libraryCounts"], queryFn: api.libraryCounts, staleTime: 30_000 });

/** Shelf total, not the loaded page. A 450-book library used to say "200+". */
const titleCount = computed(() => {
  if (ui.filterText.trim()) {
    return { n: list.value.length, more: !!books.hasNextPage.value };
  }
  const q = ui.query;
  if (q.kind === "collection") {
    const n = collections.data.value?.find((c) => c.id === q.value)?.bookCount;
    if (n != null) return { n, more: false };
  }
  if (q.kind === "tag") {
    const n = tags.data.value?.find((tg) => tg.id === q.value)?.bookCount;
    if (n != null) return { n, more: false };
  }
  const c = counts.data.value;
  if (c) {
    if (q.kind === "all") return { n: c.all, more: false };
    if (q.kind === "reading") return { n: c.reading, more: false };
    if (q.kind === "finished") return { n: c.finished, more: false };
    if (q.kind === "favorite") return { n: c.favorite, more: false };
  }
  return { n: list.value.length, more: !!books.hasNextPage.value };
});

function openMenu(ev: MouseEvent, book: Book) {
  menu.value = { x: ev.clientX, y: ev.clientY, book };
}

function toggleFlag(book: Book, flag: "finished" | "favorite") {
  const next = flag === "finished" ? !book.isFinished : !book.isFavorite;
  api
    .setBookFlag(book.id, flag, next)
    .then(() => qc.invalidateQueries({ queryKey: ["books"] }))
    .catch(reportError);
}

/** Deleting a book destroys its highlights and reading position too, so it goes
 *  through the undo window rather than a confirm dialog: one gesture to undo
 *  beats one gesture to confirm every single time. The row is hidden from every
 *  refetch meanwhile (pendingBookDeletes), so a background invalidation cannot
 *  make it flicker back. */
function removeBook(book: Book) {
  withUndo({
    text: t("library.deleted", { title: book.title }),
    apply: () => {
      pendingBookDeletes.add(book.id);
      if (ui.selectedBookId === book.id) ui.openBook(null);
      qc.invalidateQueries({ queryKey: ["books"] });
    },
    revert: () => {
      pendingBookDeletes.delete(book.id);
      qc.invalidateQueries({ queryKey: ["books"] });
    },
    commit: () => {
      api
        .deleteBook(book.id)
        .catch(reportError)
        .finally(() => {
          pendingBookDeletes.delete(book.id);
          qc.invalidateQueries({ queryKey: ["books"] });
          qc.invalidateQueries({ queryKey: ["libraryCounts"] });
        });
    },
  });
}

/** The right-click menu for one book. */
function menuItems(book: Book): MenuEntry[] {
  return [
    { icon: "book", label: t("library.read"), onClick: () => ui.openBook(book.id) },
    {
      icon: book.isFavorite ? "star-fill" : "star",
      label: book.isFavorite ? t("library.unfavorite") : t("library.favorite"),
      onClick: () => toggleFlag(book, "favorite"),
    },
    {
      icon: "check",
      label: book.isFinished ? t("library.markUnfinished") : t("library.markFinished"),
      onClick: () => toggleFlag(book, "finished"),
    },
    { separator: true },
    {
      icon: "tag",
      label: t("tagPicker.title"),
      onClick: () => (tagPick.value = { x: menu.value?.x ?? 0, y: menu.value?.y ?? 0, book }),
    },
    {
      icon: "folder",
      label: t("library.moveToShelf"),
      onClick: () => (shelfPick.value = { x: menu.value?.x ?? 0, y: menu.value?.y ?? 0, book }),
    },
    { icon: "text", label: t("library.details"), onClick: () => emit("details", book.id) },
    { icon: "trash", label: t("common.delete"), danger: true, onClick: () => removeBook(book) },
  ];
}

function moveToShelf(book: Book, collectionId: number | null) {
  api
    .setBookCollection(book.id, collectionId)
    .then(() => {
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["collections"] });
    })
    .catch(reportError);
}

function shelfMenuItems(book: Book): MenuEntry[] {
  const rows: Collection[] = collections.data.value ?? [];
  return [
    {
      icon: book.collectionId == null ? "check" : "folder",
      label: t("library.noShelf"),
      onClick: () => moveToShelf(book, null),
    },
    ...rows.map((c): MenuEntry => ({
      icon: book.collectionId === c.id ? "check" : "folder",
      label: c.name,
      onClick: () => moveToShelf(book, c.id),
    })),
  ];
}

defineExpose({ pickBooks });
</script>

<template>
  <section
    class="list library"
    :class="{ 'drop-active': dragging }"
    @dragenter="onFileDragEnter"
    @dragover="onFileDragOver"
    @dragleave="onFileDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="list-header">
      <h1 class="list-title">
        {{ ui.queryLabel }}
        <span v-if="titleCount.n" class="count">{{ titleCount.n }}<template v-if="titleCount.more">+</template></span>
      </h1>
      <div class="list-meta">
        <label class="list-meta-search" :class="{ on: ui.filterText.length > 0 }">
          <Icon name="search" :size="12" />
          <input
            type="search"
            :value="ui.filterText"
            :placeholder="t('library.filterPlaceholder')"
            :aria-label="t('library.filterPlaceholder')"
            @input="ui.setFilterText(($event.target as HTMLInputElement).value)"
            @keydown.escape.prevent="ui.filterText ? ui.setFilterText('') : undefined"
          />
          <button
            v-if="ui.filterText"
            type="button"
            class="list-meta-search-clear"
            :aria-label="t('library.clearSearch')"
            :title="t('library.clearSearch')"
            @click="ui.setFilterText('')"
          >
            <Icon name="x" :size="11" />
          </button>
        </label>
        <button
          class="list-meta-btn"
          :class="{ on: ui.viewMode === 'grid' }"
          :aria-pressed="ui.viewMode === 'grid'"
          :title="t('settings.appearance.listStyleGrid')"
          :aria-label="t('settings.appearance.listStyleGrid')"
          @click="ui.setViewMode('grid')"
        >
          <Icon name="grid" :size="13" />
        </button>
        <button
          class="list-meta-btn"
          :class="{ on: ui.viewMode === 'list' }"
          :aria-pressed="ui.viewMode === 'list'"
          :title="t('settings.appearance.listStyleList')"
          :aria-label="t('settings.appearance.listStyleList')"
          @click="ui.setViewMode('list')"
        >
          <Icon name="list" :size="13" />
        </button>
        <div class="library-sort" ref="sortEl">
          <button
            class="list-meta-btn"
            @click="sortOpen = !sortOpen"
            :aria-expanded="sortOpen"
            aria-haspopup="menu"
            :title="t('library.sort')"
          >
            <Icon name="list" :size="13" />
            {{ t(`library.sort_${ui.bookSort}`) }}
          </button>
          <div v-if="sortOpen" class="ctx-menu library-sort-menu" role="menu" @keydown="onSortKey">
            <button
              v-for="s in SORTS"
              :key="s"
              class="ctx-item"
              role="menuitemradio"
              :aria-checked="ui.bookSort === s"
              @click="ui.setBookSort(s); sortOpen = false"
            >
              {{ t(`library.sort_${s}`) }}
              <Icon v-if="ui.bookSort === s" name="check" :size="13" />
            </button>
          </div>
        </div>
        <button class="list-meta-btn primary" @click="pickBooks" :disabled="importing">
          <Icon name="plus" :size="13" />
          {{ t("library.addBooks") }}
        </button>
      </div>
    </header>

    <div ref="gridRef" class="list-scroll">
      <div v-if="books.isPending.value" class="library-grid" aria-hidden="true">
        <div v-for="i in 12" :key="i" class="book-card skeleton">
          <div class="book-cover sk-line" />
          <div class="sk-line" :style="{ width: '80%', height: '11px' }" />
          <div class="sk-line" :style="{ width: '50%', height: '10px' }" />
        </div>
      </div>

      <div v-else-if="books.isError.value" class="empty">
        <div class="glyph"><Icon name="alert" :size="22" /></div>
        <div>{{ t("library.loadError") }}</div>
        <button class="empty-retry" @click="books.refetch()">
          <Icon name="refresh" :size="12" />
          {{ t("common.retry") }}
        </button>
      </div>

      <div v-else-if="!list.length" class="empty">
        <div class="glyph"><Icon name="book" :size="22" /></div>
        <div v-if="ui.filterText">
          <div class="empty-title">{{ t("library.noMatches") }}</div>
          <button class="empty-retry" @click="ui.setFilterText('')">
            {{ t("library.clearSearch") }}
          </button>
        </div>
        <template v-else>
          <div class="empty-title">{{ emptyCopy.title }}</div>
          <div class="empty-hint">{{ emptyCopy.hint }}</div>
          <button v-if="emptyCopy.add" class="empty-retry" @click="pickBooks" :disabled="importing">
            <Icon name="plus" :size="12" />
            {{ t("library.addBooks") }}
          </button>
        </template>
      </div>

      <!-- Virtualized rows: only the rows inside the scroll window (plus
           overscan) mount, so a big library does not build every card and its
           cover query at once. -->
      <div
        v-else
        :key="ui.viewMode"
        class="library-grid-virtual"
        :class="{ 'as-list': ui.viewMode === 'list' }"
        :style="{ height: virtualTotal + 'px' }"
      >
        <div
          v-for="vrow in virtualRows"
          :key="String(vrow.key)"
          v-memo="[vrow.key, vrow.start, vrow.size, rowTracks, focusedId, rowSig(vrow.index)]"
          :data-index="vrow.index"
          :ref="measureRow"
          class="library-row"
          :style="{
            transform: `translateY(${vrow.start}px)`,
            gridTemplateColumns: rowTracks,
          }"
        >
          <BookCard
            v-for="b in rowBooks(vrow.index)"
            :key="b.id"
            :book="b"
            :selected="focusedId === b.id"
            @open="openFocused(b.id)"
            @menu="(ev: MouseEvent) => openMenu(ev, b)"
          />
        </div>
      </div>
    </div>

    <div v-if="dragging" class="library-drop-veil" aria-hidden="true">
      <Icon name="plus" :size="26" />
      <span>{{ t("library.dropHere") }}</span>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems(menu.book)"
      :on-close="() => (menu = null)"
    />
    <TagPicker
      v-if="tagPick"
      :book-id="tagPick.book.id"
      :attached="(tagPick.book.tags ?? []).map((tg) => tg.id)"
      :x="tagPick.x"
      :y="tagPick.y"
      :on-close="() => (tagPick = null)"
    />
    <ContextMenu
      v-if="shelfPick"
      :x="shelfPick.x"
      :y="shelfPick.y"
      :items="shelfMenuItems(shelfPick.book)"
      :on-close="() => (shelfPick = null)"
    />
  </section>
</template>
