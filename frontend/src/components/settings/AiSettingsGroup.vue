<script setup lang="ts">
// Translation defaults: the engine ("llm" reuses the active AI provider; the rest
// are standalone machine-translation services), the target language, and the
// auto-translate toggle — which the reader reads to translate each chapter as it
// opens, and to keep the next one warm. The AI provider config itself lives in
// AiProvidersGroup. Fields persist on change; toasts go through the global store.

import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../api";
import { reportError, toast } from "../../stores/toasts";
import { LANGUAGES } from "../../i18n";
import SettingsRow from "./SettingsRow.vue";
import SettingsSelect from "./SettingsSelect.vue";
import SettingsToggle from "./SettingsToggle.vue";

/** The default article-translation engine. "llm" reuses the active AI provider;
 *  the rest are standalone machine-translation services. */
type TranslateEngine = "llm" | "google" | "deepl" | "bing";

const { t, locale } = useI18n();
const qc = useQueryClient();

const engine = ref<TranslateEngine>("llm");
// Default target language for translation. Empty = follow the UI language until
// the user picks one.
const translateLang = ref("");
// Translate each chapter on open, and prefetch the next one while reading.
const autoTranslate = ref(false);

onMounted(() => {
  Promise.all([
    api.getSetting("translate_engine"),
    api.getSetting("translate_target_lang"),
    api.getSetting("translate_auto"),
  ])
    .then(([eng, tl, auto]) => {
      if (eng === "google" || eng === "deepl" || eng === "bing" || eng === "llm") engine.value = eng;
      if (tl) translateLang.value = tl;
      autoTranslate.value = auto === "1";
    })
    .catch(() => {});
});

function save(key: string, value: string, label: string): void {
  api
    .setSetting(key, value)
    .then(() => toast.show(t("settings.advanced.aiSaved", { label })))
    .catch((e) => reportError(e));
}

function onEngineChange(v: TranslateEngine): void {
  engine.value = v;
  save("translate_engine", v, t("settings.advanced.translateEngineLabel"));
  // The reader reads this default when starting a translation — refresh it so
  // the change takes effect on the next translate.
  qc.invalidateQueries({ queryKey: ["setting", "translate_engine"] });
}

function onTranslateLangChange(v: string): void {
  translateLang.value = v;
  save("translate_target_lang", v, t("settings.advanced.translateLangLabel"));
  qc.invalidateQueries({ queryKey: ["setting", "translate_target_lang"] });
}

function onAutoTranslateChange(v: boolean): void {
  autoTranslate.value = v;
  save("translate_auto", v ? "1" : "0", t("settings.advanced.translateAutoLabel"));
  qc.invalidateQueries({ queryKey: ["setting", "translate_auto"] });
}
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.advanced.translationTitle") }}</h3>
    <SettingsRow
      :label="t('settings.advanced.translateEngine')"
      :desc="t('settings.advanced.translateEngineDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSelect
        :value="engine"
        :options="[
          { value: 'llm', label: t('settings.advanced.translateEngineLlm') },
          { value: 'google', label: 'Google' },
          { value: 'deepl', label: 'DeepL' },
          { value: 'bing', label: 'Bing' },
        ]"
        :aria-label="ariaLabel"
        @change="onEngineChange($event as TranslateEngine)"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.advanced.translateLang')"
      :desc="t('settings.advanced.translateLangDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSelect
        :value="translateLang || locale"
        :options="LANGUAGES.map((l) => ({ value: l.code, label: l.label }))"
        :aria-label="ariaLabel"
        @change="onTranslateLangChange($event)"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.advanced.translateAuto')"
      :desc="t('settings.advanced.translateAutoDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsToggle
        :checked="autoTranslate"
        :aria-label="ariaLabel"
        @change="onAutoTranslateChange($event)"
      />
    </SettingsRow>
  </div>
</template>
