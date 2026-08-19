<script setup lang="ts">
// One book in the library grid: its cover (or a typographic stand-in when the
// file carried none), title, author, and a progress hairline.
//
// Cover bytes are fetched per card and turned into an object URL, which is
// revoked when the card unmounts — a shelf of illustrated books would otherwise
// leak a few megabytes per scroll.

import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import * as api from "../api";
import { useUi } from "../stores/ui";
import type { Book } from "../types";
import { tagColor } from "../lib/tagColors";
import Icon from "./Icon.vue";

const props = defineProps<{
  book: Book;
  selected?: boolean;
}>();

defineEmits<{
  (e: "open"): void;
  (e: "menu", ev: MouseEvent): void;
}>();

const { t } = useI18n();
const ui = useUi();

const coverUrl = ref<string | null>(null);
let objectUrl: string | null = null;

function releaseCover() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  coverUrl.value = null;
}

// Cover bytes are fetched through vue-query with a long stale time, so a
// shelf of books does not fire a Wails IPC round-trip (and a base64 decode of
// a few megabytes) per card per remount. The query key is the book id — the
// fetch happens once, is cached, and the object URL is still revoked when the
// card unmounts.
const cover = useQuery({
  queryKey: computed(() => ["cover", props.book.id] as const),
  queryFn: () => api.coverBytes(props.book.id),
  enabled: computed(() => !!props.book.hasCover && ui.prefs.showCovers),
  staleTime: 24 * 60 * 60 * 1000,
});
watch(
  cover.data,
  (bytes) => {
    releaseCover();
    if (!bytes?.length) return;
    objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
    coverUrl.value = objectUrl;
  },
  { immediate: true },
);

onBeforeUnmount(releaseCover);

/** The initials shown on a coverless book, so a wall of them stays scannable. */
const initials = computed(() => {
  const title = props.book.title.trim();
  if (!title) return "?";
  // CJK titles read best as their first two characters; Latin ones as the
  // initials of the first two words.
  if (/[一-鿿぀-ヿ가-힯]/.test(title[0])) {
    return title.slice(0, 2);
  }
  return title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
});

const percent = computed(() => Math.round(props.book.percent * 100));

/** Reading time left, in minutes, from a 300 characters-per-minute pace.
 *  Books without a counted body (some PDFs) have no estimate to show. */
const minutesLeft = computed(() => {
  if (!props.book.charCount) return 0;
  const remaining = props.book.charCount * (1 - props.book.percent);
  return Math.max(1, Math.round(remaining / 300));
});

const visibleTags = computed(() => (props.book.tags ?? []).slice(0, 2));
const extraTagCount = computed(() => Math.max(0, (props.book.tags ?? []).length - 2));

function onCardDragStart(ev: DragEvent) {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.effectAllowed = "copy";
  ev.dataTransfer.setData("application/x-hiread-book", String(props.book.id));
  ev.dataTransfer.setData("text/plain", `book:${props.book.id}`);
}
</script>

<template>
  <button
    class="book-card"
    :class="{ selected }"
    draggable="true"
    @click="$emit('open')"
    @contextmenu.prevent="$emit('menu', $event)"
    @dragstart="onCardDragStart"
    :aria-label="book.title"
  >
    <div class="book-cover" :data-format="book.format">
      <img v-if="coverUrl" :src="coverUrl" alt="" loading="lazy" />
      <div v-else class="book-cover-fallback">
        <span class="book-cover-initials">{{ initials }}</span>
        <span class="book-cover-format">{{ book.format.toUpperCase() }}</span>
      </div>
      <span v-if="book.isFavorite" class="book-flag favorite" aria-hidden="true">
        <Icon name="star-fill" :size="12" />
      </span>
      <span v-if="book.isFinished" class="book-flag finished" aria-hidden="true">
        <Icon name="check" :size="12" />
      </span>
      <div v-if="percent > 0 && !book.isFinished" class="book-progress" aria-hidden="true">
        <div class="book-progress-fill" :style="{ transform: `scaleX(${book.percent})` }" />
      </div>
    </div>
    <div class="book-title">{{ book.title }}</div>
    <div class="book-sub">
      <span v-if="book.author" class="book-author">{{ book.author }}</span>
      <span v-else class="book-author book-author-unknown">{{ t("library.unknownAuthor") }}</span>
      <div v-if="visibleTags.length" class="book-tags">
        <span
          v-for="tg in visibleTags"
          :key="tg.id"
          class="book-tag"
          :style="{ '--tag': tagColor(tg.color) }"
        >{{ tg.name }}</span>
        <span v-if="extraTagCount" class="book-tag book-tag-more">+{{ extraTagCount }}</span>
      </div>
    </div>
    <div v-if="ui.prefs.showReadingTime && percent > 0 && !book.isFinished && minutesLeft > 0" class="book-meta">
      {{ t("library.minutesLeft", { n: minutesLeft }) }}
    </div>
  </button>
</template>
