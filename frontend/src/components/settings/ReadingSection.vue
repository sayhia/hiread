<script setup lang="ts">
// Reading preferences: the same settings as the panel over a book, with room
// to be exact about them.
//
// It was a second hand-written form over the same seventeen settings, which is
// why the page carried three separate samples of the reading type, why its
// sliders floated against the right edge at whatever width each one happened
// to want, and why its reset restored two settings the button's own enabled
// state never checked. The rows come from the schema now, the same as the
// panel's; the difference between the two surfaces is `mode`, and it means
// what it says — there is room here for the number behind a named position,
// for the margins as two settings rather than one, and for a sentence saying
// what a control is for.
//
// What is still written by hand is what is not a reading setting: the app's
// own font, the three preferences about what the reader is shown around a
// chapter, and the voice, which lives in the database rather than in the page.

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import { speechSupported } from "../../composables/useSpeech";
import { reportError, toast } from "../../stores/toasts";
import { resolveReaderFont } from "../../lib/fonts";
import { inkFor } from "../../lib/paper";
import { matchingReadingPreset, previewTypeStyle } from "../../lib/readerSettings";
import { groupsFor, settingsFor, settingVisible, type ReadingSettingKey } from "../../lib/reading/schema";
import { exportReading, importReading } from "../../lib/reading/transfer";

import ReadingControl from "../reader/shared/ReadingControl.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";
import SettingsSlider from "./SettingsSlider.vue";
import SettingsSelect from "./SettingsSelect.vue";
import FontPicker from "./FontPicker.vue";

const { t } = useI18n();
const ui = useUi();
const qc = useQueryClient();

/** The groups, and what belongs in each — from the schema, so this page and
 *  the panel cannot disagree about where a setting lives. */
const groups = computed(() =>
  groupsFor("text").map((g) => ({
    key: g,
    rows: settingsFor("text", g, "full").filter((s) =>
      settingVisible(s, ui.readerOrientation, ui.readerPageMode),
    ),
  })),
);

/** One sample, on the page's own colour, in the page's own type. There were
 *  three: this one, another under the UI font, and a third under the reading
 *  font — none of which agreed about what they were showing. */
const sample = computed(() => {
  const face = resolveReaderFont(ui.readerFont, ui.installedFonts);
  const style = previewTypeStyle({
    fontStack: face.stack,
    size: ui.readerSize,
    leading: ui.readerLeading,
    tracking: ui.readerTracking,
    justify: ui.readerJustify,
    width: ui.readerWidth,
    paraGap: ui.readerParaGap,
    indent: ui.readerIndent,
    orientation: ui.readerOrientation,
    typeset: ui.readerTypeset,
    adjust: face.adjust,
  });
  if (ui.readerInk === "custom") style.color = ui.readerInkCustom;
  else if (ui.readerInk === "black") style.color = "#131619";
  else if (ui.readerInk === "gray") style.color = "#3D444C";
  else if (ui.readerInk === "sepia") style.color = "#4A3826";
  return style;
});

const activePreset = computed(() =>
  matchingReadingPreset({
    theme: ui.theme,
    paper: ui.readerPaper,
    warmth: ui.readerWarmth,
    orientation: ui.readerOrientation,
    colSep: ui.readerColSep,
    size: ui.readerSize,
    leading: ui.readerLeading,
    tracking: ui.readerTracking,
  }),
);

const PRESETS = ["day", "comfort", "night"] as const;

// ── the voice ─────────────────────────────────────────────────────────────
// Stored in the database rather than in the page, because it belongs to the
// machine doing the speaking.
const SPEECH_RATE_DEFAULT = 1;
const voice = ref("");
const rate = ref(SPEECH_RATE_DEFAULT);
const voices = ref<SpeechSynthesisVoice[]>([]);

/** The reset here is the whole page: typeset, theme, the chapter aids, and
 *  the voice's speed. The in-reader Aa reset is typeset-only. */
const isDefault = computed(
  () => ui.isReadingPageDefault() && rate.value === SPEECH_RATE_DEFAULT && voice.value === "",
);

function resetPage() {
  ui.resetReadingPage();
  const voiceDirty = voice.value !== "";
  const rateDirty = rate.value !== SPEECH_RATE_DEFAULT;
  voice.value = "";
  rate.value = SPEECH_RATE_DEFAULT;
  if (voiceDirty) {
    api.setSetting("speech_voice", "").catch((e) => reportError(e));
    qc.invalidateQueries({ queryKey: ["setting", "speech_voice"] });
  }
  if (rateDirty) {
    api.setSetting("speech_rate", String(SPEECH_RATE_DEFAULT)).catch((e) => reportError(e));
    qc.invalidateQueries({ queryKey: ["setting", "speech_rate"] });
  }
}

const voiceOptions = computed(() => [
  { value: "", label: t("settings.reading.speechVoiceDefault") },
  ...voices.value.map((v) => ({ value: v.name, label: `${v.name} · ${v.lang}` })),
]);

let loadVoices: (() => void) | undefined;
onMounted(() => {
  if (speechSupported()) {
    loadVoices = () => (voices.value = window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
  }
  Promise.all([api.getSetting("speech_voice"), api.getSetting("speech_rate")])
    .then(([v, r]) => {
      voice.value = v ?? "";
      rate.value = Number(r ?? 1) || 1;
    })
    .catch(() => {});
});

onBeforeUnmount(() => {
  if (loadVoices) window.speechSynthesis.removeEventListener?.("voiceschanged", loadVoices);
});

function onVoiceChange(v: string) {
  voice.value = v;
  api.setSetting("speech_voice", v).catch((e) => reportError(e));
  qc.invalidateQueries({ queryKey: ["setting", "speech_voice"] });
}

// ── taking these settings elsewhere ───────────────────────────────────────
// Both sides go through Go: the WKWebView has no download handler, so an
// `<a download>` saves nothing here and says nothing about it either.
const busy = ref(false);

async function doExport() {
  busy.value = true;
  try {
    const path = await api.exportReadingFile(exportReading((k) => ui.readingValue(k)));
    if (path) toast.show(t("reading.exported", { path }));
  } catch (e) {
    reportError(e);
  } finally {
    busy.value = false;
  }
}

async function doImport() {
  busy.value = true;
  try {
    const text = await api.importReadingFile();
    if (!text) return; // cancelled
    const { values, skipped } = importReading(text);
    for (const { key, value } of values) ui.setReading(key as ReadingSettingKey, value, "global");
    toast.show(
      skipped.length
        ? t("reading.importedSome", { n: values.length, skipped: skipped.length })
        : t("reading.imported", { n: values.length }),
    );
  } catch {
    // A file that is not a settings file is the reader picking the wrong one,
    // not a fault worth a stack trace.
    toast.error(t("reading.importFailed"));
  } finally {
    busy.value = false;
  }
}

function onRateInput(percent: number) {
  rate.value = percent / 100;
}

function onRateCommit(percent: number) {
  onRateInput(percent);
  api.setSetting("speech_rate", String(rate.value)).catch((e) => reportError(e));
  qc.invalidateQueries({ queryKey: ["setting", "speech_rate"] });
}
</script>

<template>
  <div class="reading-settings">
    <!-- The page as it will be, and the two ways to change all of it at once. -->
    <div class="rs-hero">
      <div
        class="rs-hero-sheet"
        :data-paper="ui.readerPaper"
        :data-tex="ui.readerTexture"
        :style="{
          ...(ui.readerPaper === 'custom' ? { backgroundColor: ui.readerPaperCustom } : {}),
        }"
      >
        <div v-if="ui.readerWarmth > 0" class="rs-hero-warm" aria-hidden="true" />
        <p
          class="rs-hero-sample"
          :data-orientation="ui.readerOrientation"
          :style="{
            ...sample,
            ...(ui.readerPaper === 'custom' && ui.readerInk === 'auto'
              ? { color: inkFor(ui.readerPaperCustom).ink }
              : {}),
            ...(ui.readerGrayscale ? { filter: 'grayscale(1)' } : {}),
          }"
        >{{ t("settings.reading.previewText") }}</p>
      </div>
      <div class="rs-hero-side">
        <span class="rs-hero-label">{{ t("reading.presets") }}</span>
        <div class="rs-hero-presets rp-preset-row">
          <button
            v-for="p in PRESETS"
            :key="p"
            type="button"
            :class="[`rp-preset ${p}`, { on: activePreset === p }]"
            :aria-pressed="activePreset === p"
            @click="ui.applyReadingPreset(p)"
          >
            <span class="rp-preset-swatch" />
            {{ t(`reader.type.preset_${p}`) }}
          </button>
          <button
            type="button"
            class="rp-preset vertical"
            :class="{ on: activePreset === 'vertical' }"
            :aria-pressed="activePreset === 'vertical'"
            @click="ui.applyVerticalPreset()"
          >
            <span class="rp-preset-swatch" />
            {{ t("reader.type.preset_vertical") }}
          </button>
        </div>
        <button class="rs-hero-reset" :disabled="isDefault" @click="resetPage">
          {{ t("settings.reading.reset") }}
        </button>
      </div>
    </div>

    <!-- Every reading setting, in the order the schema gives them. -->
    <div v-for="g in groups" :key="g.key" class="settings-group">
      <h3 class="settings-group-title">{{ t(`reading.group.${g.key}`) }}</h3>

      <template v-for="s in g.rows" :key="s.key">
        <!-- The face is the one row the panel's three names cannot cover: here
             there is room for everything installed, and for installing one. -->
        <FontPicker
          v-if="s.key === 'readerFont'"
          axis="reader"
          :label="t('reading.readerFont')"
          :desc="t('reading.readerFontDesc')"
          :sample="false"
        />
        <ReadingControl v-else :setting="s" mode="full" />
      </template>
      <div v-if="g.key === 'page'" class="rs-row rs-full">
        <div class="rs-text">
          <span class="rs-label">{{ t("reader.type.theme") }}</span>
          <span class="rs-hint">{{ t("settings.appearance.appearanceDesc") }}</span>
        </div>
        <div class="rs-control">
          <div class="rs-seg" role="group" :aria-label="t('reader.type.theme')">
            <button
              v-for="th in (['light', 'dark', 'auto'] as const)"
              :key="th"
              type="button"
              :class="{ on: ui.theme === th }"
              :aria-pressed="ui.theme === th"
              @click="ui.setTheme(th)"
            >
              {{ t(`reader.type.theme_${th}`) }}
            </button>
          </div>
        </div>
      </div>

      <!-- The app's own font sits with the book's, because a reader comparing
           them is comparing them. -->
      <FontPicker
        v-if="g.key === 'type'"
        axis="ui"
        :label="t('settings.fonts.uiFont')"
        :desc="t('settings.fonts.uiFontDesc')"
      />
    </div>

    <!-- Not reading settings: what the reader is shown around a chapter. -->
    <div class="settings-group">
      <h3 class="settings-group-title">{{ t("reading.aids") }}</h3>
      <p class="settings-group-desc">{{ t("reading.aidsDesc") }}</p>
      <SettingsRow
        :label="t('settings.reading.trimBlanks')"
        :desc="t('settings.reading.trimBlanksDesc')"
        v-slot="{ ariaLabel }"
      >
        <SettingsToggle
          :checked="ui.prefs.trimBlankParagraphs"
          :aria-label="ariaLabel"
          @change="(v: boolean) => ui.setPref({ trimBlankParagraphs: v })"
        />
      </SettingsRow>
      <SettingsRow
        :label="t('settings.reading.readingTime')"
        :desc="t('settings.reading.readingTimeDesc')"
        v-slot="{ ariaLabel }"
      >
        <SettingsToggle
          :checked="ui.prefs.showReadingTime"
          :aria-label="ariaLabel"
          @change="(v: boolean) => ui.setPref({ showReadingTime: v })"
        />
      </SettingsRow>
      <SettingsRow
        :label="t('settings.reading.transSwitch')"
        :desc="t('settings.reading.transSwitchDesc')"
        v-slot="{ ariaLabel }"
      >
        <SettingsToggle
          :checked="ui.prefs.showTransSwitch"
          :aria-label="ariaLabel"
          @change="(v: boolean) => ui.setPref({ showTransSwitch: v })"
        />
      </SettingsRow>
    </div>

    <div class="settings-group">
      <h3 class="settings-group-title">{{ t("reading.transfer") }}</h3>
      <p class="settings-group-desc">{{ t("reading.transferDesc") }}</p>
      <div class="rs-transfer">
        <button class="s-btn" :disabled="busy" @click="doExport">{{ t("reading.export") }}</button>
        <button class="s-btn" :disabled="busy" @click="doImport">{{ t("reading.import") }}</button>
      </div>
    </div>

    <div v-if="speechSupported()" class="settings-group">
      <h3 class="settings-group-title">{{ t("settings.reading.speech") }}</h3>
      <p class="settings-group-desc">{{ t("settings.reading.speechDesc") }}</p>
      <SettingsRow
        :label="t('settings.reading.speechVoice')"
        :desc="t('settings.reading.speechVoiceDesc')"
        v-slot="{ ariaLabel }"
      >
        <SettingsSelect
          :value="voice"
          :options="voiceOptions"
          :aria-label="ariaLabel"
          @change="onVoiceChange"
        />
      </SettingsRow>
      <SettingsRow :label="t('settings.reading.speechRate')" v-slot="{ ariaLabel }">
        <SettingsSlider
          :value="Math.round(rate * 100)"
          :min="50"
          :max="200"
          :step="5"
          unit="%"
          :aria-label="ariaLabel"
          @change="onRateInput"
          @commit="onRateCommit"
        />
      </SettingsRow>
    </div>
  </div>
</template>
