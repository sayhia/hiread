<script setup lang="ts">
// The per-chapter AI summary, shown inline above the chapter body. Streams from
// the backend the first time it is opened for a chapter, accumulating tokens
// into `text`; a completed summary is cached backend-side, so the parent seeds
// this component from it and reopening costs nothing.
//
// The parent keys this by (book, chapter), so turning the page remounts it and
// the state re-initialises from the new chapter's stored summary.

import { onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../../api";
import { renderMarkdown } from "../../../lib/markdown";
import type { AiEvent } from "../../../types";
import type { StreamHandle } from "../../../api";
import Icon from "../../Icon.vue";

const props = defineProps<{
  bookId: number;
  chapterIndex: number;
  /** The cached summary, when the chapter already has one. */
  initial: string | null;
  onClose: () => void;
  /** Opens settings at the AI section — used by the missing-key state so the
   *  user can fix the cause without hunting through menus. */
  onOpenSettings: () => void;
}>();

const { t } = useI18n();
const qc = useQueryClient();

const text = ref<string | null>(props.initial);
const busy = ref(false);
let lastGood = props.initial;
/** Why generation failed, so the panel can guide rather than just say "failed":
 *  a missing key links to settings, an empty chapter explains itself. */
const failure = ref<"none" | "noKey" | "noText" | "generic">("none");
let handle: StreamHandle | null = null;
let cancelled = false;

function generate() {
  if (busy.value) return;
  busy.value = true;
  failure.value = "none";
  cancelled = false;
  lastGood = text.value;
  text.value = "";
  handle = api.aiSummarize(props.bookId, props.chapterIndex, (e: AiEvent) => {
    if (e.type === "delta") text.value = (text.value ?? "") + e.data;
    else if (e.type === "error") failure.value = classify(e.data);
  });
  handle
    .catch((e: unknown) => (failure.value = classify(String(e))))
    .finally(() => {
      if (cancelled) return;
      busy.value = false;
      handle = null;
      if (failure.value !== "none") text.value = lastGood;
      // The completed summary is now cached on the chapter; refetching keeps
      // the parent's copy in step for the next open.
      if (failure.value === "none") {
        qc.invalidateQueries({ queryKey: ["chapter", props.bookId, props.chapterIndex] });
      }
    });
}

function stopGenerate() {
  cancelled = true;
  handle?.cancel();
  handle = null;
  busy.value = false;
  text.value = lastGood;
}

function classify(message: string): "noKey" | "noText" | "generic" {
  if (message.includes("noApiKey") || message.includes("apiKey")) return "noKey";
  if (message.includes("noChapterText")) return "noText";
  return "generic";
}

// Generate on mount unless the chapter already has a summary — the component is
// mounted only while the panel is open.
if (!text.value) generate();

onBeforeUnmount(() => {
  stopGenerate();
});
</script>

<template>
  <section class="chapter-summary" :aria-busy="busy">
    <header class="chapter-summary-head">
      <Icon name="sparkle" :size="13" />
      <span>{{ t("reader.summaryTitle") }}</span>
      <span v-if="busy" class="ai-generating">{{ t("ai.generating") }}</span>
      <button
        v-if="busy"
        class="tb-btn"
        @click="stopGenerate"
        :title="t('ai.stop')"
        :aria-label="t('ai.stop')"
      >
        <Icon name="x" :size="13" />
      </button>
      <button
        v-else
        class="tb-btn"
        @click="generate"
        :title="t('ai.regenerate')"
        :aria-label="t('ai.regenerate')"
      >
        <Icon name="refresh" :size="13" />
      </button>
      <button class="tb-btn" @click="onClose" :aria-label="t('common.close')">
        <Icon name="x" :size="13" />
      </button>
    </header>

    <div v-if="failure === 'noKey'" class="ai-error">
      {{ t("ai.noKey") }}
      <button class="empty-retry" @click="onOpenSettings">{{ t("ai.openSettings") }}</button>
    </div>
    <div v-else-if="failure === 'noText'" class="ai-error">{{ t("ai.noChapterText") }}</div>
    <div v-else-if="failure === 'generic'" class="ai-error">
      {{ t("ai.failed") }}
      <button class="empty-retry" @click="generate">{{ t("common.retry") }}</button>
    </div>
    <div v-else-if="text" class="ai-body" v-html="renderMarkdown(text)" />
    <div v-else class="ai-loading">
      <span class="ai-dot" /><span class="ai-dot" /><span class="ai-dot" />
    </div>
  </section>
</template>
