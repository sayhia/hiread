<script setup lang="ts">
// Translation options for the chapter on screen: which view of it to show,
// what to translate into, and by which engine.
//
// The language and engine default to the settings, and a change here is kept
// for the session only — reading one chapter in English does not mean the next
// book should be.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import * as api from "../../../api";
import { LANGUAGES } from "../../../i18n";
import { swallowPageClick } from "../../../composables/reader/useTextReaderInput";
import { useDismiss } from "../../../composables/useDismiss";
import { useFocusTrap } from "../../../composables/useFocusTrap";

export type TransView = "original" | "bilingual" | "translation";

const props = defineProps<{
  view: TransView;
  lang: string;
  engine: string;
  /** Set while this chapter is being translated, with per-batch progress. */
  busy: boolean;
  done: number;
  total: number;
  /** True when a finished translation for this (lang, engine) is on hand. */
  translated: boolean;
  onView: (v: TransView) => void;
  onLang: (v: string) => void;
  onEngine: (v: string) => void;
  onClose: () => void;
}>();

const { t } = useI18n();
const pop = ref<HTMLElement>();
useDismiss(pop, () => {
  swallowPageClick();
  props.onClose();
});
useFocusTrap(pop);

/** The keyless engines always work; the LLM path needs a provider, so say so
 *  rather than let the choice be a silent dead end. The backend answers this —
 *  a provider may be stored as a profile or in the older flat settings, and
 *  reading one setting from here called a configured provider unconfigured. */
const aiReady = useQuery({ queryKey: ["ai", "configured"], queryFn: api.aiConfigured, staleTime: 30_000 });
const llmNeedsKey = computed(() => props.engine === "llm" && aiReady.data.value === false);

const ENGINES = [
  { value: "llm", label: () => t("reader.translateEngineLlm") },
  { value: "google", label: () => "Google" },
  { value: "deepl", label: () => "DeepL" },
  { value: "bing", label: () => "Bing" },
];

const engineLabel = (v: string) => ENGINES.find((e) => e.value === v)?.label() ?? v;
</script>

<template>
  <div class="tr-pop-backdrop" @click="swallowPageClick(); onClose()" />
  <div class="tr-pop" ref="pop" role="dialog" aria-modal="true" :aria-label="t('reader.translateOptions')">
    <div class="tr-pop-modes" role="group" :aria-label="t('reader.tbTranslate')">
      <button :class="{ on: view === 'original' }" @click="onView('original')">
        {{ t("reader.original") }}
      </button>
      <button :class="{ on: view === 'bilingual' }" @click="onView('bilingual')">
        {{ t("reader.bilingual") }}
      </button>
      <button :class="{ on: view === 'translation' }" @click="onView('translation')">
        {{ t("reader.translation") }}
      </button>
    </div>

    <label class="tr-pop-row">
      <span>{{ t("reader.translateTitle") }}</span>
      <select
        class="s-select"
        :value="lang"
        :disabled="busy"
        @change="onLang(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
      </select>
    </label>

    <label class="tr-pop-row">
      <span>{{ t("reader.translateEngine") }}</span>
      <select
        class="s-select"
        :value="engine"
        :disabled="busy"
        @change="onEngine(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="e in ENGINES" :key="e.value" :value="e.value">{{ e.label() }}</option>
      </select>
    </label>

    <div v-if="llmNeedsKey" class="tr-pop-note tr-pop-warn">
      {{ t("reader.translateNeedsKey") }}
    </div>
    <div v-if="busy" class="tr-pop-note" :class="{ busy: total > 0 }">
      {{ t("reader.translating") }}{{ total > 0 ? ` ${done}/${total}` : "" }}
      <div
        v-if="total > 0"
        class="tr-pop-progress"
        role="progressbar"
        :aria-valuenow="done"
        aria-valuemin="0"
        :aria-valuemax="total"
      >
        <i :style="{ width: `${Math.min(100, (done / total) * 100)}%` }" />
      </div>
    </div>
    <div v-else-if="translated" class="tr-pop-note">
      {{ t("reader.translatedVia", { engine: engineLabel(engine) }) }}
    </div>
  </div>
</template>
