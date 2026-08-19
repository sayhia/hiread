<script setup lang="ts">
// Floating tag editor: toggle existing tags on an article, or create a new one
// and attach it in a single step. Stays open across toggles.

import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../api";
import { useDismiss } from "../composables/useDismiss";
import { reportError } from "../stores/toasts";
import { tagColor } from "../lib/tagColors";
import { clampToViewport } from "../lib/viewport";
import type { Tag } from "../types";
import Icon from "./Icon.vue";

const props = defineProps<{
  bookId: number;
  /** Ids of tags already attached to the article. */
  attached: number[];
  /** Anchor point (viewport coords) the popover opens from. */
  x: number;
  y: number;
  onClose: () => void;
}>();

const { t } = useI18n();
const qc = useQueryClient();
const ref_ = ref<HTMLDivElement>();
const draft = ref("");

const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, staleTime: 30_000 });
const book = useQuery({
  queryKey: computed(() => ["book", props.bookId] as const),
  queryFn: () => api.getBook(props.bookId),
  staleTime: 30_000,
});
// `tags.data` is a Ref (vue-query maps every result field to a Ref); read it
// through a computed so the list stays reactive and the template never has to
// reach through `.value`.
const tagList = computed(() => tags.data.value ?? []);
const attachedSet = computed(() => {
  const live = book.data.value?.tags?.map((tg) => tg.id);
  return new Set(live ?? props.attached);
});

// Tabbing past the popover's last control dismisses it, the way a click outside
// does — otherwise it floats over the page, orphaned from the keyboard.
useDismiss(ref_, () => props.onClose(), { onFocusOut: true });

// The trigger (toolbar tag button) captured at open, so focus can be restored
// to it on close.
let trigger: HTMLElement | null = null;

// Move focus into the popover on open so it is keyboard-reachable, and restore
// it to the trigger on close.
onMounted(() => {
  trigger = document.activeElement as HTMLElement | null;
  ref_.value?.querySelector<HTMLElement>('[role="button"], input')?.focus();
});
onBeforeUnmount(() => trigger?.focus?.());

const sync = () => {
  qc.invalidateQueries({ queryKey: ["book", props.bookId] });
  qc.invalidateQueries({ queryKey: ["tags"] });
  qc.invalidateQueries({ queryKey: ["books"] });
};

const toggle = (tagId: number, on: boolean) =>
  api
    .setBookTag(props.bookId, tagId, on)
    .then(sync)
    .catch((e) => reportError(e));

const createAndAttach = async () => {
  const name = draft.value.trim();
  if (!name) return;
  try {
    const id = await api.createTag(name);
    await api.setBookTag(props.bookId, id, true);
    draft.value = "";
    sync();
  } catch (e) {
    reportError(e);
  }
};

// Clamp inside the viewport with the shared two-sided helper. The popover is
// ~232px wide and ~320px tall; the 248/320 footprint plus the 0px margin
// reproduces the historical pull-back while flooring the top-left corner so a
// narrow/short window can't push the popover off-screen.
const { left, top } = clampToViewport({ x: props.x, y: props.y, width: 248, height: 320, margin: 0 });

const isOn = (tag: Tag) => attachedSet.value.has(tag.id);

// Skip the Enter that confirms an IME candidate (CJK input) so a half-composed
// draft isn't turned into a tag. `isComposing` is read off the native event.
const onDraftKeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.isComposing) createAndAttach();
};

const onRowKeydown = (e: KeyboardEvent, tag: Tag) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle(tag.id, !isOn(tag));
  }
};
</script>

<template>
  <Teleport to="body">
  <div class="tag-picker" ref="ref_" :style="{ left: left + 'px', top: top + 'px' }">
    <div class="tag-picker-head">{{ t("tagPicker.title") }}</div>
    <div class="tag-picker-list">
      <div
        v-for="tag in tagList"
        :key="tag.id"
        :class="['tag-picker-row', isOn(tag) ? 'on' : '']"
        role="button"
        :tabindex="0"
        :aria-pressed="isOn(tag)"
        @click="toggle(tag.id, !isOn(tag))"
        @keydown="onRowKeydown($event, tag)"
      >
        <span class="tag-dot" :style="{ background: tagColor(tag.color) }" />
        <span class="tag-picker-name">{{ tag.name }}</span>
        <Icon v-if="isOn(tag)" name="check" :size="13" />
      </div>
      <div v-if="tagList.length === 0" class="tag-picker-empty">
        {{ t("tagPicker.empty") }}
      </div>
    </div>
    <div class="tag-picker-create">
      <input
        v-model="draft"
        @keydown="onDraftKeydown"
        :placeholder="t('tagPicker.createPlaceholder')"
        :aria-label="t('tagPicker.createPlaceholder')"
      />
      <button @click="createAndAttach" :disabled="!draft.trim()">
        <Icon name="plus" :size="13" />
      </button>
    </div>
  </div>
  </Teleport>
</template>
