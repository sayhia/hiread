<script setup lang="ts">
// ⌘K command palette: a search box over actions, books and passages, plus a
// keyboard-driven runner. Typing searches book titles and — through the same
// FTS index the reader uses — the text inside them, so a half-remembered line
// is as findable as a title.
//
// Lives behind a Teleport so its fixed overlay escapes any transformed/
// overflow-clipped ancestor. The parent keeps it mounted and toggles `open`.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import * as api from "../api";
import { useUi } from "../stores/ui";
import { modCombo } from "../lib/platform";
import type { Book, SearchHit } from "../types";
import Icon, { type IconName } from "./Icon.vue";
import { useFocusTrap } from "../composables/useFocusTrap";

export type CommandAction = "add-books" | "settings" | "ai" | "focus" | "highlights";

interface Item {
  id: string;
  group: "action" | "book" | "passage";
  icon: IconName | null;
  label: string;
  hint?: string;
  /** The matching passage, query terms wrapped in <mark> (passage rows only). */
  snippet?: string;
  run: () => void;
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "action", action: CommandAction): void;
  (e: "navigateBook", bookId: number): void;
  (e: "navigateHit", payload: { bookId: number; chapterIndex: number; snippet?: string }): void;
}>();

const ACTIONS: { icon: IconName; labelKey: string; hint: string; action: CommandAction }[] = [
  { icon: "plus", labelKey: "commandPalette.actionAddBooks", hint: modCombo("O"), action: "add-books" },
  { icon: "sparkle", labelKey: "commandPalette.actionAi", hint: "", action: "ai" },
  { icon: "highlighter", labelKey: "commandPalette.actionHighlights", hint: "", action: "highlights" },
  { icon: "focus", labelKey: "commandPalette.actionFocus", hint: "F", action: "focus" },
  { icon: "settings", labelKey: "commandPalette.actionOpenSettings", hint: modCombo(","), action: "settings" },
];

const { t } = useI18n();
const ui = useUi();

const query = ref("");
const debounced = ref("");
const active = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLDivElement | null>(null);
const cpRef = ref<HTMLDivElement | null>(null);
// True while the selection just moved by keyboard. Mouse hover also sets
// `active`, but scrolling the list to a hovered row yanks content under the
// cursor — and can land a different row under it, cascading more hover events.
// So the scroll-into-view watcher below only fires for keyboard nav.
let keyboardNav = false;

useFocusTrap(cpRef, computed(() => props.open));

let focusTimer: number | undefined;
let trigger: HTMLElement | null = null;
let debounceTimer: number | undefined;

watch(
  () => props.open,
  (open) => {
    window.clearTimeout(focusTimer);
    if (!open) {
      // Return focus to whatever was focused when the palette opened (the ⌘K
      // trigger lives nowhere in particular), so closing it doesn't drop the
      // user on <body>.
      trigger?.focus?.();
      trigger = null;
      return;
    }
    trigger = document.activeElement as HTMLElement | null;
    query.value = "";
    debounced.value = "";
    active.value = 0;
    focusTimer = window.setTimeout(() => inputRef.value?.focus(), 30);
  },
  { immediate: true },
);

watch(query, (q) => {
  window.clearTimeout(debounceTimer);
  const next = q.trim();
  if (!next) {
    debounced.value = "";
    return;
  }
  debounceTimer = window.setTimeout(() => (debounced.value = next), 180);
});

function onWindowEsc(e: KeyboardEvent) {
  if (!props.open || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  emit("close");
}

onMounted(() => window.addEventListener("keydown", onWindowEsc, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowEsc, true);
  window.clearTimeout(focusTimer);
  window.clearTimeout(debounceTimer);
});

const allBooks = useQuery({
  queryKey: computed(() => ["cp-books", debounced.value] as const),
  queryFn: () =>
    api.listBooks(
      { kind: "all" },
      "recent",
      debounced.value ? 80 : 200,
      0,
      debounced.value || undefined,
    ),
  enabled: computed(() => props.open),
  // No staleTime here: nothing invalidates this key when a book is imported,
  // edited or deleted, so the palette's jump list must always be fresh on open.
});

// Passage search only runs once there is something to search for: an FTS query
// over every book in the library is not free.
const passages = useQuery({
  queryKey: ["cp-search", debounced],
  queryFn: () => api.searchLibrary(debounced.value, null, 8),
  enabled: computed(() => props.open && debounced.value.length > 0),
  staleTime: 30_000,
});

const items = computed<Item[]>(() => {
  const q = debounced.value.toLowerCase();
  const out: Item[] = [];

  for (const a of ACTIONS) {
    const label = t(a.labelKey);
    if (q && !label.toLowerCase().includes(q)) continue;
    out.push({
      id: `act-${a.action}`,
      group: "action",
      icon: a.icon,
      label,
      hint: a.hint,
      run: () => emit("action", a.action),
    });
  }

  const matchedBooks: Book[] = (allBooks.data.value ?? [])
    .filter(
      (bk) =>
        !q ||
        bk.title.toLowerCase().includes(q) ||
        (bk.author ?? "").toLowerCase().includes(q),
    )
    .slice(0, 6);
  for (const bk of matchedBooks) {
    out.push({
      id: `book-${bk.id}`,
      group: "book",
      icon: bk.isFavorite ? "star-fill" : "book",
      label: bk.title,
      hint: bk.author ?? "",
      run: () => emit("navigateBook", bk.id),
    });
  }

  if (q) {
    for (const h of (passages.data.value ?? []) as SearchHit[]) {
      out.push({
        id: `hit-${h.bookId}-${h.chapterIndex}`,
        group: "passage",
        icon: "text",
        // A PDF's pages are indexed with no title of their own, because they
        // have none — the page number is what identifies them.
        label: h.chapterTitle || t("reader.pageNo", { n: h.chapterIndex + 1 }),
        hint: h.bookTitle,
        snippet: h.snippet,
        run: () => emit("navigateHit", { bookId: h.bookId, chapterIndex: h.chapterIndex, snippet: h.snippet }),
      });
    }
  }

  return out;
});

watch(
  () => items.value.length,
  (len) => {
    if (active.value >= len) active.value = 0;
  },
);

// A new query reselects the first row — scroll the list back to the top so that
// row is visible (the keyboardNav-gated watcher below deliberately ignores this
// non-keyboard `active` reset).
watch(debounced, () => {
  if (listRef.value) listRef.value.scrollTop = 0;
});

// Keep the keyboard-selected row visible when arrowing past the fold. Skipped
// for mouse-driven selection changes — see `keyboardNav`.
watch(active, (idx) => {
  if (!keyboardNav) return;
  keyboardNav = false;
  nextTick(() => {
    listRef.value
      ?.querySelector<HTMLElement>(`[data-cp-index="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
});

const run = (it: Item) => {
  it.run();
  emit("close");
};

const handleKey = (e: KeyboardEvent) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    keyboardNav = true;
    active.value = (active.value + 1) % Math.max(items.value.length, 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    keyboardNav = true;
    active.value =
      (active.value - 1 + items.value.length) % Math.max(items.value.length, 1);
  } else if (e.key === "Home") {
    const input = e.target as HTMLInputElement;
    if (query.value && input.selectionStart !== 0) return;
    e.preventDefault();
    keyboardNav = true;
    active.value = 0;
  } else if (e.key === "End") {
    const input = e.target as HTMLInputElement;
    if (query.value && input.selectionStart !== query.value.length) return;
    e.preventDefault();
    keyboardNav = true;
    active.value = Math.max(0, items.value.length - 1);
  } else if (e.key === "Enter" && !e.isComposing) {
    // `isComposing` skips the Enter that only confirms an IME candidate (CJK
    // search input) — without it the first result fires mid-typing.
    e.preventDefault();
    const it = items.value[active.value];
    if (it) run(it);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
  }
};

// The flat index of an item in render order, so hover/aria-activedescendant
// line up across the three groups. Recomputed as a map keyed by item id.
const flatIndex = computed(() => {
  const map: Record<string, number> = {};
  let i = -1;
  for (const group of ["action", "book", "passage"] as const) {
    for (const it of items.value) {
      if (it.group !== group) continue;
      i++;
      map[it.id] = i;
    }
  }
  return map;
});

const groupItems = (key: Item["group"]) => items.value.filter((i) => i.group === key);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cp-backdrop" @click="emit('close')">
      <div class="cp" ref="cpRef" @click.stop>
        <div class="cp-input">
          <Icon name="search" :size="16" />
          <input
            ref="inputRef"
            :value="query"
            @input="query = ($event.target as HTMLInputElement).value"
            @keydown="handleKey"
            :placeholder="t('commandPalette.searchPlaceholder')"
            :aria-label="t('commandPalette.searchPlaceholder')"
            role="combobox"
            :aria-expanded="items.length > 0"
            aria-controls="cp-listbox"
            :aria-activedescendant="items.length > 0 ? `cp-option-${active}` : undefined"
            aria-autocomplete="list"
          />
          <span class="cp-esc">ESC</span>
        </div>
        <div class="cp-list" id="cp-listbox" role="listbox" ref="listRef">
          <div v-if="items.length === 0" class="cp-empty">
            <template v-if="passages.isFetching.value">{{ t("commandPalette.searching") }}</template>
            <template v-else-if="passages.isError.value && debounced.length > 0">
              {{ t("commandPalette.searchError") }}
              <button type="button" class="empty-retry" @click="passages.refetch()">
                {{ t("commandPalette.searchRetry") }}
              </button>
            </template>
            <template v-else>{{ t("commandPalette.noResults") }}</template>
          </div>
          <template v-else>
            <template
              v-for="grp in [
                { key: 'action', title: t('commandPalette.groupActions') },
                { key: 'book', title: t('commandPalette.groupBooks') },
                { key: 'passage', title: t('commandPalette.groupPassages') },
              ]"
              :key="grp.key"
            >
              <div
                v-if="groupItems(grp.key as Item['group']).length > 0"
                role="group"
                :aria-label="grp.title"
              >
                <div class="cp-group-title" aria-hidden="true">{{ grp.title }}</div>
                <div
                  v-for="it in groupItems(grp.key as Item['group'])"
                  :key="it.id"
                  :data-cp-index="flatIndex[it.id]"
                  :id="`cp-option-${flatIndex[it.id]}`"
                  role="option"
                  :aria-selected="flatIndex[it.id] === active"
                  :class="`cp-item ${flatIndex[it.id] === active ? 'active' : ''}`"
                  @mouseenter="active = flatIndex[it.id]"
                  @click="run(it)"
                >
                  <span class="cp-ico">
                    <Icon :name="it.icon ?? 'book'" :size="15" />
                  </span>
                  <span class="cp-label">
                    {{ it.label }}
                    <span v-if="it.snippet" class="cp-snippet" v-html="it.snippet" />
                  </span>
                  <span v-if="it.hint" class="cp-hint">{{ it.hint }}</span>
                </div>
              </div>
            </template>
            <!--
              Passage search failing must not be masked just because an action or
              a book title still matched the query — items.length would then be
              non-zero and the empty-state error branch above never shows.
              Surface the failure as a trailing notice instead, so a partial
              result list still says search broke rather than silently omitting
              matches.
            -->
            <div
              v-if="passages.isError.value && debounced.length > 0"
              class="cp-notice"
              role="status"
            >
              <Icon name="alert" :size="13" />
              {{ t("commandPalette.searchError") }}
              <button type="button" class="empty-retry" @click="passages.refetch()">
                {{ t("commandPalette.searchRetry") }}
              </button>
            </div>
          </template>
        </div>
        <div class="cp-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {{ t("commandPalette.footerSelect") }}
          </span>
          <span> <kbd>⏎</kbd> {{ t("commandPalette.footerOpen") }} </span>
          <span> <kbd>esc</kbd> {{ t("commandPalette.footerClose") }} </span>
          <div style="flex: 1" />
          <span>{{ t("commandPalette.footerHint") }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
