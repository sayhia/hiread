<script setup lang="ts">
// The dedicated AI settings section: provider / key / model + translation (the
// existing AiSettingsGroup, moved here out of Advanced), plus the runtime-tunable
// assistant knobs the Q&A reads on each request. The knobs persist to settings
// keys the backend resolves per call (services/ai.go intSetting), so a change
// takes effect without rebuilding. Ranges mirror the backend clamps; the
// frontend also reads ai_history_turns / ai_source_chip_cap in AIAssistant.vue.

import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../../api";
import { reportError, toast } from "../../stores/toasts";
import Icon from "../Icon.vue";
import AiProvidersGroup from "./AiProvidersGroup.vue";
import AiSettingsGroup from "./AiSettingsGroup.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsSlider from "./SettingsSlider.vue";

const { t } = useI18n();

// Tuning is advanced and rarely touched — collapse it by default so the section
// leads with provider + translation; click the header to reveal the sliders.
const tuningOpen = ref(false);

const ragLimit = ref(20);
const recentLimit = ref(40);
const summaryChars = ref(500);
const historyTurns = ref(6);
const chipCap = ref(12);

function num(v: string | null, def: number, lo: number, hi: number): number {
  const n = v == null ? NaN : parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

onMounted(() => {
  Promise.all([
    api.getSetting("ai_rag_limit"),
    api.getSetting("ai_recent_limit"),
    api.getSetting("ai_summary_chars"),
    api.getSetting("ai_history_turns"),
    api.getSetting("ai_source_chip_cap"),
  ])
    .then(([rag, rec, sum, hist, chip]) => {
      ragLimit.value = num(rag, 20, 1, 200);
      recentLimit.value = num(rec, 40, 1, 200);
      summaryChars.value = num(sum, 500, 100, 4000);
      historyTurns.value = num(hist, 6, 0, 50);
      chipCap.value = num(chip, 12, 1, 100);
    })
    .catch(() => {});
});

// Persist a knob on drag-settle. The backend re-reads it on the next Ask,
// so no reload is needed for it to take effect.
function onCommit(key: string, value: number, label: string): void {
  api
    .setSetting(key, String(value))
    .then(() => toast.show(t("settings.advanced.aiSaved", { label })))
    .catch((e) => reportError(e));
}
</script>

<template>
  <AiProvidersGroup />
  <AiSettingsGroup />
  <div class="settings-group">
    <button
      type="button"
      class="settings-collapse-head"
      :aria-expanded="tuningOpen"
      @click="tuningOpen = !tuningOpen"
    >
      <Icon :name="tuningOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
      <span class="settings-group-title">{{ t("settings.ai.tuningTitle") }}</span>
    </button>
    <template v-if="tuningOpen">
    <p class="settings-group-desc">{{ t("settings.ai.tuningDesc") }}</p>

    <SettingsRow
      :label="t('settings.ai.ragLimit')"
      :desc="t('settings.ai.ragLimitDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSlider
        :value="ragLimit"
        :min="1"
        :max="200"
        :aria-label="ariaLabel"
        @change="ragLimit = $event"
        @commit="onCommit('ai_rag_limit', $event, t('settings.ai.ragLimit'))"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.ai.recentLimit')"
      :desc="t('settings.ai.recentLimitDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSlider
        :value="recentLimit"
        :min="1"
        :max="200"
        :aria-label="ariaLabel"
        @change="recentLimit = $event"
        @commit="onCommit('ai_recent_limit', $event, t('settings.ai.recentLimit'))"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.ai.summaryChars')"
      :desc="t('settings.ai.summaryCharsDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSlider
        :value="summaryChars"
        :min="100"
        :max="4000"
        :step="50"
        :aria-label="ariaLabel"
        @change="summaryChars = $event"
        @commit="onCommit('ai_summary_chars', $event, t('settings.ai.summaryChars'))"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.ai.historyTurns')"
      :desc="t('settings.ai.historyTurnsDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSlider
        :value="historyTurns"
        :min="0"
        :max="50"
        :aria-label="ariaLabel"
        @change="historyTurns = $event"
        @commit="onCommit('ai_history_turns', $event, t('settings.ai.historyTurns'))"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.ai.chipCap')"
      :desc="t('settings.ai.chipCapDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSlider
        :value="chipCap"
        :min="1"
        :max="100"
        :aria-label="ariaLabel"
        @change="chipCap = $event"
        @commit="onCommit('ai_source_chip_cap', $event, t('settings.ai.chipCap'))"
      />
    </SettingsRow>
    </template>
  </div>
</template>
