<script setup lang="ts">
// Left column: the icon rail (smart shelves + global actions) and the panel
// beneath it (user shelves and tags). The rail is always visible; the panel is
// what the resize handle in App.vue sizes.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import * as api from "../api";
import { useUi } from "../stores/ui";
import { isMac, modCombo } from "../lib/platform";
import { reportError, withUndo } from "../stores/toasts";
import { pendingCollectionDeletes, pendingTagDeletes } from "../lib/pendingDeletes";
import { TAG_PALETTE, tagColor } from "../lib/tagColors";
import type { Collection, LibraryQuery, Tag } from "../types";
import ContextMenu, { type MenuEntry } from "./ContextMenu.vue";
import Icon from "./Icon.vue";
import PromptDialog from "./PromptDialog.vue";

const emit = defineEmits<{
  (e: "add-books"): void;
  (e: "open-settings"): void;
  (e: "search-click"): void;
  (e: "select-highlights"): void;
  (e: "ai-assistant"): void;
}>();

const { t } = useI18n();
const ui = useUi();
const qc = useQueryClient();

const counts = useQuery({ queryKey: ["libraryCounts"], queryFn: api.libraryCounts, staleTime: 30_000 });
const collections = useQuery({ queryKey: ["collections"], queryFn: api.listCollections, staleTime: 30_000 });
const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, staleTime: 30_000 });

const showCounts = computed(() => ui.prefs.showSidebarCounts);
const isHighlightsPane = computed(() => ui.middlePane === "highlights");

const newShelf = ref(false);
const newTag = ref(false);
const renaming = ref<Collection | null>(null);
const renamingTag = ref<Tag | null>(null);
const menu = ref<{ x: number; y: number; items: MenuEntry[] } | null>(null);

function isActive(q: LibraryQuery): boolean {
  if (ui.middlePane !== "library") return false;
  if (ui.query.kind !== q.kind) return false;
  const a = "value" in ui.query ? ui.query.value : null;
  const b = "value" in q ? q.value : null;
  return a === b;
}

function selectQuery(q: LibraryQuery, label: string) {
  ui.select(q, label);
}

function invalidateShelves() {
  qc.invalidateQueries({ queryKey: ["collections"] });
  qc.invalidateQueries({ queryKey: ["tags"] });
  qc.invalidateQueries({ queryKey: ["books"] });
}

// ── reordering shelves and tags ──────────────────────────────────────────
// Both lists carry a position the backend already sorts by; this is the way
// to set it. A shelf is dragged onto the gap above or below another shelf —
// tags likewise — and the two lists never mix, so a drag can only ever land
// somewhere sensible.
type DragKind = "collection" | "tag";
interface DragState {
  kind: DragKind;
  id: number;
  /** Row the pointer is currently over, and which side of its middle. */
  overId: number | null;
  below: boolean;
}
const drag = ref<DragState | null>(null);
/** Cover-wall book hovering a shelf or tag — distinct from reorder. */
const bookDropOver = ref<{ kind: DragKind; id: number } | null>(null);

const rowsOf = (kind: DragKind): { id: number }[] =>
  (kind === "collection" ? collections.data.value : tags.data.value) ?? [];

function onDragStart(kind: DragKind, id: number, ev: DragEvent) {
  drag.value = { kind, id, overId: null, below: false };
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    // Some engines refuse to start a drag with an empty payload.
    ev.dataTransfer.setData("text/plain", String(id));
  }
}

function isBookDrag(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes("application/x-hiread-book");
}

function onDragOver(kind: DragKind, id: number, ev: DragEvent) {
  if (isBookDrag(ev)) {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    bookDropOver.value = { kind, id };
    return;
  }
  const d = drag.value;
  if (!d || d.kind !== kind) return; // a tag never drops among shelves
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  drag.value = { ...d, overId: id, below: ev.clientY > box.top + box.height / 2 };
}

function onBookDragLeave(kind: DragKind, id: number, ev: DragEvent) {
  if (bookDropOver.value?.kind !== kind || bookDropOver.value.id !== id) return;
  const next = ev.relatedTarget as Node | null;
  if (!next || !(ev.currentTarget as HTMLElement).contains(next)) {
    bookDropOver.value = null;
  }
}

/** Where the insertion line is drawn: above or below the row under the
 *  pointer, and never against the dragged row itself. */
function dropEdge(kind: DragKind, id: number): "above" | "below" | null {
  const d = drag.value;
  if (!d || d.kind !== kind || d.overId !== id || d.id === id) return null;
  return d.below ? "below" : "above";
}

async function onDrop(kind: DragKind, targetId: number, ev?: DragEvent) {
  bookDropOver.value = null;
  const bookRaw = ev?.dataTransfer?.getData("application/x-hiread-book")
    || ev?.dataTransfer?.getData("text/plain")
    || "";
  const bookId = bookRaw.startsWith("book:") ? Number(bookRaw.slice(5)) : Number(bookRaw);
  if (Number.isFinite(bookId) && bookId > 0 && !drag.value) {
    try {
      if (kind === "collection") await api.setBookCollection(bookId, targetId);
      else await api.setBookTag(bookId, targetId, true);
      invalidateShelves();
    } catch (e) {
      reportError(e);
    }
    return;
  }

  const d = drag.value;
  drag.value = null;
  if (!d || d.kind !== kind || d.id === targetId) return;

  const rows = rowsOf(kind);
  const ids = rows.map((r) => r.id).filter((id) => id !== d.id);
  const at = ids.indexOf(targetId);
  if (at === -1) return;
  ids.splice(d.below ? at + 1 : at, 0, d.id);

  // Show the new order at once — a list that snaps back while the write is in
  // flight reads as a failed drag.
  const key = kind === "collection" ? ["collections"] : ["tags"];
  const byId = new Map(rows.map((r) => [r.id, r]));
  qc.setQueryData(
    key,
    ids.map((id) => byId.get(id)),
  );
  try {
    await (kind === "collection" ? api.reorderCollections(ids) : api.reorderTags(ids));
  } catch (e) {
    reportError(e);
  } finally {
    qc.invalidateQueries({ queryKey: key });
  }
}

function createShelf(name: string) {
  api.createCollection(name).then(invalidateShelves).catch(reportError);
}

function createTag(name: string) {
  api.createTag(name).then(invalidateTags).catch(reportError);
}

function renameShelf(name: string) {
  const target = renaming.value;
  renaming.value = null;
  if (!target) return;
  api.renameCollection(target.id, name).then(invalidateShelves).catch(reportError);
}

function invalidateTags() {
  qc.invalidateQueries({ queryKey: ["tags"] });
  // A tag's name and colour show on every book card that carries it.
  qc.invalidateQueries({ queryKey: ["books"] });
}

function renameTag(name: string) {
  const target = renamingTag.value;
  renamingTag.value = null;
  if (!target) return;
  api.renameTag(target.id, name).then(invalidateTags).catch(reportError);
}

function recolourTag(tag: Tag, color: string) {
  api.setTagColor(tag.id, color).then(invalidateTags).catch(reportError);
}

/** Deleting a shelf keeps its books — only the grouping goes — so it needs no
 *  confirmation, just an undo window. */
function deleteShelf(shelf: Collection) {
  withUndo({
    text: t("sidebar.shelfDeleted", { name: shelf.name }),
    apply: () => {
      pendingCollectionDeletes.add(shelf.id);
      if (isActive({ kind: "collection", value: shelf.id })) {
        ui.select({ kind: "all" }, t("smart.all"));
      }
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
    revert: () => {
      pendingCollectionDeletes.delete(shelf.id);
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
    commit: () => {
      api
        .deleteCollection(shelf.id)
        .catch(reportError)
        .finally(() => {
          pendingCollectionDeletes.delete(shelf.id);
          invalidateShelves();
        });
    },
  });
}

function deleteTag(tag: Tag) {
  withUndo({
    text: t("sidebar.tagDeleted", { name: tag.name }),
    apply: () => {
      pendingTagDeletes.add(tag.id);
      if (isActive({ kind: "tag", value: tag.id })) ui.select({ kind: "all" }, t("smart.all"));
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    revert: () => {
      pendingTagDeletes.delete(tag.id);
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    commit: () => {
      api
        .deleteTag(tag.id)
        .catch(reportError)
        .finally(() => {
          pendingTagDeletes.delete(tag.id);
          qc.invalidateQueries({ queryKey: ["tags"] });
          qc.invalidateQueries({ queryKey: ["books"] });
        });
    },
  });
}

function shelfMenu(ev: MouseEvent, shelf: Collection) {
  menu.value = {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { icon: "text", label: t("common.rename"), onClick: () => (renaming.value = shelf) },
      { icon: "trash", label: t("common.delete"), danger: true, onClick: () => deleteShelf(shelf) },
    ],
  };
}

function tagMenu(ev: MouseEvent, tag: Tag) {
  menu.value = {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { icon: "text", label: t("common.rename"), onClick: () => (renamingTag.value = tag) },
      {
        swatches: Object.entries(TAG_PALETTE).map(([value, color]) => ({ value, color })),
        current: tag.color,
        onPick: (color: string) => recolourTag(tag, color),
      },
      { separator: true },
      { icon: "trash", label: t("common.delete"), danger: true, onClick: () => deleteTag(tag) },
    ],
  };
}
</script>

<template>
  <div class="sidebar" role="navigation">
    <div v-if="isMac" class="titlebar" data-tauri-drag-region />

    <!-- Icon rail: brand mark, smart shelves, and global actions -->
    <div class="rail">
      <div class="rail-brand">
        <img class="rail-brand-mark" :src="ui.iconSrc" alt="Hiread" />
      </div>

      <div class="rail-nav">
        <button
          class="rail-item"
          :class="{ active: isActive({ kind: 'all' }) }"
          :aria-current="isActive({ kind: 'all' }) || undefined"
          :title="t('smart.all')"
          :aria-label="t('smart.all')"
          @click="selectQuery({ kind: 'all' }, t('smart.all'))"
        >
          <Icon name="books" :size="18" />
        </button>
        <button
          class="rail-item"
          :class="{ active: isActive({ kind: 'reading' }) }"
          :aria-current="isActive({ kind: 'reading' }) || undefined"
          :title="t('smart.reading')"
          :aria-label="t('smart.reading')"
          @click="selectQuery({ kind: 'reading' }, t('smart.reading'))"
        >
          <Icon name="book" :size="18" />
        </button>
        <button
          class="rail-item"
          :class="{ active: isActive({ kind: 'favorite' }) }"
          :aria-current="isActive({ kind: 'favorite' }) || undefined"
          :title="t('smart.favorite')"
          :aria-label="t('smart.favorite')"
          @click="selectQuery({ kind: 'favorite' }, t('smart.favorite'))"
        >
          <Icon name="star" :size="18" />
        </button>
        <button
          class="rail-item"
          :class="{ active: isActive({ kind: 'finished' }) }"
          :aria-current="isActive({ kind: 'finished' }) || undefined"
          :title="t('smart.finished')"
          :aria-label="t('smart.finished')"
          @click="selectQuery({ kind: 'finished' }, t('smart.finished'))"
        >
          <Icon name="check-all" :size="18" />
        </button>
        <button
          class="rail-item"
          :class="{ active: isHighlightsPane }"
          :aria-current="isHighlightsPane || undefined"
          :title="t('smart.highlights')"
          :aria-label="t('smart.highlights')"
          type="button"
          @click="emit('select-highlights')"
        >
          <Icon name="highlighter" :size="18" />
        </button>
      </div>

      <div class="rail-spacer" />

      <div class="rail-foot">
        <button
          class="rail-item"
          :title="t('library.addBooks')"
          :aria-label="t('library.addBooks')"
          @click="emit('add-books')"
        >
          <Icon name="plus" :size="18" />
        </button>
        <button
          class="rail-item"
          :title="t('ai.title')"
          :aria-label="t('ai.title')"
          @click="emit('ai-assistant')"
        >
          <Icon name="sparkle" :size="18" />
        </button>
        <button
          class="rail-item"
          :title="`${t('sidebar.settings')} (${modCombo(',')})`"
          :aria-label="t('sidebar.settings')"
          @click="emit('open-settings')"
        >
          <Icon name="settings" :size="18" />
        </button>
      </div>
    </div>

    <!-- Shelves / tags panel -->
    <div class="sidebar-panel">
      <div class="sb-brand">
        <span class="sb-brand-name">{{ t("app.name") }}</span>
      </div>

      <button class="sidebar-search" @click="emit('search-click')">
        <Icon name="search" :size="13" />
        <span>{{ t("sidebar.search") }}</span>
        <kbd>{{ modCombo("K") }}</kbd>
      </button>

      <div class="sidebar-scroll">
        <div class="sb-section-title">
          {{ t("sidebar.shelves") }}
          <span class="sb-section-actions">
            <button :title="t('sidebar.newShelf')" :aria-label="t('sidebar.newShelf')" @click="newShelf = true">
              <Icon name="plus" :size="13" />
            </button>
          </span>
        </div>

        <div v-if="!collections.data.value?.length" class="sb-empty">
          {{ t("sidebar.noShelves") }}
        </div>
        <button
          v-for="c in collections.data.value ?? []"
          :key="c.id"
          class="sb-item"
          :class="[
            { active: isActive({ kind: 'collection', value: c.id }), dragging: drag?.id === c.id && drag?.kind === 'collection' },
            { 'drop-book': bookDropOver?.kind === 'collection' && bookDropOver?.id === c.id },
            dropEdge('collection', c.id) ? `drop-${dropEdge('collection', c.id)}` : '',
          ]"
          draggable="true"
          @dragstart="onDragStart('collection', c.id, $event)"
          @dragover="onDragOver('collection', c.id, $event)"
          @dragleave="onBookDragLeave('collection', c.id, $event)"
          @drop.prevent="onDrop('collection', c.id, $event)"
          @dragend="drag = null"
          @click="selectQuery({ kind: 'collection', value: c.id }, c.name)"
          @contextmenu.prevent="shelfMenu($event, c)"
        >
          <span class="sb-ico"><Icon name="folder" :size="15" /></span>
          <span class="sb-label">{{ c.name }}</span>
          <span v-if="showCounts && c.bookCount" class="sb-count">{{ c.bookCount }}</span>
        </button>

        <div class="sb-section-title">
          {{ t("sidebar.tags") }}
          <span class="sb-section-actions">
            <button :title="t('sidebar.newTag')" :aria-label="t('sidebar.newTag')" @click="newTag = true">
              <Icon name="plus" :size="13" />
            </button>
          </span>
        </div>
        <div v-if="!tags.data.value?.length" class="sb-empty">
          {{ t("sidebar.noTags") }}
        </div>
        <template v-if="tags.data.value?.length">
          <button
            v-for="tg in tags.data.value"
            :key="tg.id"
            class="sb-item"
            :class="[
              { active: isActive({ kind: 'tag', value: tg.id }), dragging: drag?.id === tg.id && drag?.kind === 'tag' },
              { 'drop-book': bookDropOver?.kind === 'tag' && bookDropOver?.id === tg.id },
              dropEdge('tag', tg.id) ? `drop-${dropEdge('tag', tg.id)}` : '',
            ]"
            draggable="true"
            @dragstart="onDragStart('tag', tg.id, $event)"
            @dragover="onDragOver('tag', tg.id, $event)"
            @dragleave="onBookDragLeave('tag', tg.id, $event)"
            @drop.prevent="onDrop('tag', tg.id, $event)"
            @dragend="drag = null"
            @click="selectQuery({ kind: 'tag', value: tg.id }, tg.name)"
            @contextmenu.prevent="tagMenu($event, tg)"
          >
            <span class="sb-ico"><span class="tag-dot" :style="{ background: tagColor(tg.color) }" /></span>
            <span class="sb-label">{{ tg.name }}</span>
            <span v-if="showCounts && tg.bookCount" class="sb-count">{{ tg.bookCount }}</span>
          </button>
        </template>
      </div>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      :on-close="() => (menu = null)"
    />

    <PromptDialog
      v-if="newShelf"
      :title="t('sidebar.newShelfTitle')"
      :placeholder="t('sidebar.shelfNamePlaceholder')"
      @submit="(v: string) => { createShelf(v); newShelf = false; }"
      @cancel="newShelf = false"
    />

    <PromptDialog
      v-if="newTag"
      :title="t('sidebar.newTagTitle')"
      :placeholder="t('sidebar.tagNamePlaceholder')"
      @submit="(v: string) => { createTag(v); newTag = false; }"
      @cancel="newTag = false"
    />

    <PromptDialog
      v-if="renaming"
      :title="t('sidebar.renameShelfTitle')"
      :placeholder="t('sidebar.shelfNamePlaceholder')"
      :initial="renaming.name"
      @submit="renameShelf"
      @cancel="renaming = null"
    />

    <PromptDialog
      v-if="renamingTag"
      :title="t('sidebar.renameTagTitle')"
      :placeholder="t('sidebar.tagNamePlaceholder')"
      :initial="renamingTag.name"
      @submit="renameTag"
      @cancel="renamingTag = null"
    />
  </div>
</template>
