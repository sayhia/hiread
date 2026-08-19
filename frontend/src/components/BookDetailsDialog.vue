<script setup lang="ts">
// Book details: what the file says about itself, plus the two fields worth
// correcting by hand. A .txt downloaded from anywhere arrives titled after its
// file name, so title and author are editable; everything else is read-only
// because it came from the file and cannot be improved by retyping it.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import * as api from "../api";
import { reportError, toast } from "../stores/toasts";
import { useFocusTrap } from "../composables/useFocusTrap";
import type { Collection } from "../types";
import { fullDate } from "../lib/time";
import Icon from "./Icon.vue";
import TagPicker from "./TagPicker.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{ bookId: number }>();
const emit = defineEmits<{ (e: "close"): void }>();

const { t } = useI18n();
const qc = useQueryClient();

const panel = ref<HTMLDivElement>();
useFocusTrap(panel);

const book = useQuery({
  queryKey: computed(() => ["book", props.bookId] as const),
  queryFn: () => api.getBook(props.bookId),
  staleTime: 30_000,
});
const collections = useQuery({ queryKey: ["collections"], queryFn: api.listCollections });

const title = ref("");
const author = ref("");
const shelf = ref<number | null>(null);
const saving = ref(false);
const tagPick = ref<{ x: number; y: number } | null>(null);
const confirmClose = ref(false);

watch(
  () => book.data.value,
  (b) => {
    if (!b) return;
    title.value = b.title;
    author.value = b.author ?? "";
    shelf.value = b.collectionId;
  },
  { immediate: true },
);

const b = computed(() => book.data.value ?? null);

const dirty = computed(() => {
  const cur = b.value;
  if (!cur) return false;
  return (
    title.value !== cur.title ||
    author.value !== (cur.author ?? "") ||
    shelf.value !== cur.collectionId
  );
});

function requestClose() {
  if (dirty.value) confirmClose.value = true;
  else emit("close");
}

/** File size in the unit that keeps it readable — books span kilobytes to
 *  hundreds of megabytes. */
const size = computed(() => {
  const bytes = b.value?.fileSize ?? 0;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
});

function save() {
  const id = props.bookId;
  const shelfId = shelf.value;
  if (saving.value) return;
  saving.value = true;
  Promise.all([
    api.updateBookMeta(id, title.value.trim(), author.value.trim()),
    shelfId === (b.value?.collectionId ?? null)
      ? Promise.resolve()
      : api.setBookCollection(id, shelfId),
  ])
    .then(() => {
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["collections"] });
      toast.show(t("library.detailsSaved"));
      emit("close");
    })
    .catch(reportError)
    .finally(() => {
      saving.value = false;
    });
}

function pickShelf(list: Collection[], raw: string) {
  const id = Number(raw);
  shelf.value = list.some((c) => c.id === id) ? id : null;
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // Tag picker owns Esc while it is open; closing the sheet would lose the
  // details form (or raise the dirty confirm) instead of just the popover.
  if (tagPick.value || document.querySelector(".tag-picker")) return;
  e.stopPropagation();
  if (confirmClose.value) {
    confirmClose.value = false;
    return;
  }
  requestClose();
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="modal-backdrop" @click.self="requestClose">
    <div class="modal book-details" ref="panel" role="dialog" aria-modal="true" aria-labelledby="book-details-title">
      <header class="modal-head">
        <h2 id="book-details-title">{{ t("library.details") }}</h2>
        <button class="tb-btn" @click="requestClose" :aria-label="t('common.close')">
          <Icon name="x" :size="14" />
        </button>
      </header>

      <div v-if="b" class="modal-body">
        <label class="field">
          <span>{{ t("library.title") }}</span>
          <input v-model="title" type="text" />
        </label>
        <label class="field">
          <span>{{ t("library.author") }}</span>
          <input v-model="author" type="text" :placeholder="t('library.unknownAuthor')" />
        </label>
        <label class="field">
          <span>{{ t("library.shelf") }}</span>
          <select
            :value="shelf ?? ''"
            @change="pickShelf(collections.data.value ?? [], ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t("library.noShelf") }}</option>
            <option v-for="c in collections.data.value ?? []" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
        </label>
        <div class="field">
          <span>{{ t("sidebar.tags") }}</span>
          <button
            type="button"
            class="s-btn"
            @click="(ev: MouseEvent) => (tagPick = { x: ev.clientX, y: ev.clientY })"
          >
            {{
              (b.tags ?? []).length
                ? (b.tags ?? []).map((tg) => tg.name).join(" · ")
                : t("library.addTags")
            }}
          </button>
        </div>

        <dl class="book-facts">
          <div><dt>{{ t("library.format") }}</dt><dd>{{ b.format.toUpperCase() }}</dd></div>
          <div><dt>{{ t("library.fileName") }}</dt><dd>{{ b.fileName }}</dd></div>
          <div><dt>{{ t("library.fileSize") }}</dt><dd>{{ size }}</dd></div>
          <div v-if="b.format === 'pdf'">
            <dt>{{ t("library.pages") }}</dt><dd>{{ b.pageCount || "—" }}</dd>
          </div>
          <div v-else>
            <dt>{{ t("library.chapters") }}</dt><dd>{{ b.chapterCount }}</dd>
          </div>
          <div v-if="b.publisher"><dt>{{ t("library.publisher") }}</dt><dd>{{ b.publisher }}</dd></div>
          <div v-if="b.language"><dt>{{ t("library.language") }}</dt><dd>{{ b.language }}</dd></div>
          <div v-if="b.publishedAt"><dt>{{ t("library.published") }}</dt><dd>{{ b.publishedAt }}</dd></div>
          <div v-if="b.identifier"><dt>{{ t("library.identifier") }}</dt><dd>{{ b.identifier }}</dd></div>
          <div><dt>{{ t("library.added") }}</dt><dd>{{ fullDate(b.addedAt) || b.addedAt }}</dd></div>
          <div v-if="b.lastReadAt">
            <dt>{{ t("library.lastRead") }}</dt>
            <dd>{{ fullDate(b.lastReadAt) }}</dd>
          </div>
        </dl>

        <p v-if="b.description" class="book-description">{{ b.description }}</p>
      </div>
      <div v-else-if="book.isPending.value" class="modal-body">
        <div class="empty">{{ t("common.loading") }}</div>
      </div>
      <div v-else class="modal-body">
        <div class="empty">
          <div>{{ t("library.loadError") }}</div>
          <button class="empty-retry" @click="book.refetch()">{{ t("common.retry") }}</button>
        </div>
      </div>

      <footer class="modal-foot">
        <button class="s-btn" @click="requestClose">{{ t("common.cancel") }}</button>
        <button class="s-btn primary" @click="save" :disabled="!b || !title.trim() || saving">
          {{ t("common.save") }}
        </button>
      </footer>
    </div>
    <TagPicker
      v-if="tagPick && b"
      :book-id="bookId"
      :attached="(b.tags ?? []).map((tg) => tg.id)"
      :x="tagPick.x"
      :y="tagPick.y"
      :on-close="() => (tagPick = null)"
    />
    <ConfirmDialog
      v-if="confirmClose"
      :title="t('library.unsavedTitle')"
      :message="t('library.unsavedBody')"
      :confirm-label="t('library.discard')"
      :danger="false"
      @confirm="emit('close')"
      @cancel="confirmClose = false"
    />
  </div>
</template>
