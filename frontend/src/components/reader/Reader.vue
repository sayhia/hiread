<script setup lang="ts">
// Which reading screen a book gets.
//
// A PDF is read by page and everything else by chapter, and the two have less
// in common than the shared component they used to be suggested: contents,
// typography, translation, summary, the keyboard and the click zones all mean
// different things, and each was an `isPdf` beside a decision — twenty-three of
// them — where a change to one path could quietly forget the other.
//
// So this picks, and the two screens are their own. What genuinely belongs to
// the book rather than to its format is shared as parts (BookActions, TocPane,
// ReaderTypography), and the reading profile is applied here, once, for both.

import { computed, defineAsyncComponent, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import Icon from "../Icon.vue";
import TextReader from "./text/TextReader.vue";

// The PDF screen carries pdf.js with it — a large dependency only a PDF needs,
// and one that reaches for browser APIs the moment it is imported. Loading it
// lazily keeps every other book from paying for it.
const PdfView = defineAsyncComponent(() => import("./pdf/PdfView.vue"));

const emit = defineEmits<{
  (e: "toast", text: string): void;
  (e: "open-settings", section?: string): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
const ui = useUi();
const bookId = computed(() => ui.selectedBookId);

const book = useQuery({
  queryKey: computed(() => ["book", bookId.value] as const),
  queryFn: () => api.getBook(bookId.value as number),
  enabled: computed(() => bookId.value != null),
  // A book's metadata changes only when the reader edits it (which invalidates
  // this query); without staleTime every window-focus refetches it.
  staleTime: 30_000,
});
const b = computed(() => book.data.value ?? null);
const isPdf = computed(() => b.value?.format === "pdf");

// A book that keeps its own reading settings gets them for as long as it is
// open; closing it (or opening another) puts the global set back. Immediate,
// because the settings drive CSS variables — applying them a frame late would
// show the page at the wrong size and then resize it under the reader.
watch(bookId, (id) => ui.useBookProfile(id), { immediate: true });
onBeforeUnmount(() => ui.useBookProfile(null));
</script>

<template>
  <!-- Until the book is known there is nothing to choose between; show the text
       screen's chrome only once we have a book, so both formats share a prop. -->
  <PdfView
    v-if="isPdf && b"
    :key="b.id"
    :book="b"
    @toast="(s: string) => emit('toast', s)"
    @open-settings="(s?: string) => emit('open-settings', s)"
    @close="emit('close')"
  />
  <TextReader
    v-else-if="b"
    :key="b.id"
    :book="b"
    @toast="(s: string) => emit('toast', s)"
    @open-settings="(s?: string) => emit('open-settings', s)"
    @close="emit('close')"
  />
  <div v-else-if="book.isError.value" class="reader" role="main">
    <div class="empty" style="flex: 1">
      <div class="glyph"><Icon name="alert" :size="22" /></div>
      <div>{{ t("reader.bookLoadError") }}</div>
      <button class="empty-retry" @click="book.refetch()">
        <Icon name="refresh" :size="12" />
        {{ t("common.retry") }}
      </button>
      <button class="empty-retry" @click="emit('close')">
        {{ t("common.close") }}
      </button>
    </div>
  </div>
  <div v-else class="reader" role="main" aria-busy="true">
    <div class="reader-scroll">
      <div class="article reader-content" aria-hidden="true">
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
  </div>
</template>
