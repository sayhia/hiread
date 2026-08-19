<script setup lang="ts">
// Appearance: UI language, theme + dark shade, accent, density / list style,
// and detail toggles.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../stores/ui";
import { LANGUAGES, setLanguage, type Language } from "../../i18n";
import { ACCENTS } from "../../lib/accents";
import type { Theme, DarkShade, Accent, Density, ViewMode } from "../../stores/ui";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";
import SettingsSelect from "./SettingsSelect.vue";
import SettingsSegmented from "./SettingsSegmented.vue";

const { t, locale } = useI18n();
const ui = useUi();

// Swatches render from the SAME palette App.vue applies (lib/accents.ts) —
// a hardcoded hex copy here once drifted from the applied colours. Theme-aware
// so the swatch previews the exact value the current theme will use.
// Six curated presets; anything else lives behind the custom wheel swatch.
const ACCENT_OPTIONS = [
  { value: "azure",     labelKey: "settings.appearance.accentAzure" },
  { value: "cyan",      labelKey: "settings.appearance.accentCyan" },
  { value: "emerald",   labelKey: "settings.appearance.accentEmerald" },
  { value: "indigo",    labelKey: "settings.appearance.accentIndigo" },
  { value: "violet",    labelKey: "settings.appearance.accentViolet" },
  { value: "slate",     labelKey: "settings.appearance.accentSlate" },
  { value: "amber",     labelKey: "settings.appearance.accentAmber" },
  { value: "vermilion", labelKey: "settings.appearance.accentVermilion" },
] as const;
const accents = computed(() =>
  ACCENT_OPTIONS.map((o) => ({
    value: o.value,
    color: ui.resolvedTheme === "dark" ? ACCENTS[o.value].dAccent : ACCENTS[o.value].accent,
    label: t(o.labelKey),
  })),
);
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.appearance.language") }}</h3>
    <SettingsRow
      :label="t('settings.appearance.uiLanguage')"
      :desc="t('settings.appearance.languageDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSelect
        :value="locale"
        :options="LANGUAGES.map((l) => ({ value: l.code, label: l.label }))"
        :aria-label="ariaLabel"
        @change="setLanguage($event as Language)"
      />
    </SettingsRow>
  </div>

  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.appearance.theme") }}</h3>
    <SettingsRow
      :label="t('settings.appearance.appearance')"
      :desc="t('settings.appearance.appearanceDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSegmented
        :value="ui.theme"
        :options="[
          { value: 'light', label: t('settings.appearance.light') },
          { value: 'dark', label: t('settings.appearance.dark') },
          { value: 'auto', label: t('settings.appearance.auto') },
        ]"
        :aria-label="ariaLabel"
        @change="ui.setTheme($event as Theme)"
      />
    </SettingsRow>
    <SettingsRow
      v-if="ui.resolvedTheme === 'dark'"
      :label="t('settings.appearance.darkShade')"
      :desc="t('settings.appearance.darkShadeDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSegmented
        :value="ui.darkShade"
        :options="[
          { value: 'default', label: t('settings.appearance.darkShadeDefault') },
          { value: 'dimmer', label: t('settings.appearance.darkShadeDimmer') },
          { value: 'black', label: t('settings.appearance.darkShadeBlack') },
        ]"
        :aria-label="ariaLabel"
        @change="ui.setDarkShade($event as DarkShade)"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.appearance.accent')"
      :desc="t('settings.appearance.accentDesc')"
    >
      <div class="s-swatches" role="group">
        <button
          v-for="a in accents"
          :key="a.value"
          class="s-swatch"
          :class="{ on: ui.accent === a.value }"
          :style="{ background: a.color }"
          :title="a.label"
          :aria-label="a.label"
          :aria-pressed="ui.accent === a.value"
          @click="ui.setAccent(a.value as Accent)"
        />
        <!-- Custom: a hue-wheel swatch whose centre shows the current pick.
             The native colour input covers the whole swatch; @input streams
             while dragging in the picker, so the app live-previews the hue. -->
        <label
          class="s-swatch s-swatch-custom"
          :class="{ on: ui.accent === 'custom' }"
          :style="{ '--cust': ui.customAccent }"
          :title="t('settings.appearance.accentCustom')"
          @click="ui.setAccent('custom')"
        >
          <input
            type="color"
            :value="ui.customAccent"
            :aria-label="t('settings.appearance.accentCustom')"
            @input="ui.setCustomAccent(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </SettingsRow>
  </div>

  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.appearance.layout") }}</h3>
    <SettingsRow
      :label="t('settings.appearance.density')"
      :desc="t('settings.appearance.densityDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSegmented
        :value="ui.density"
        :options="[
          { value: 'compact', label: t('settings.appearance.densityCompact') },
          { value: 'cozy', label: t('settings.appearance.densityCozy') },
          { value: 'spacious', label: t('settings.appearance.densitySpacious') },
        ]"
        :aria-label="ariaLabel"
        @change="ui.setDensity($event as Density)"
      />
    </SettingsRow>
    <SettingsRow :label="t('settings.appearance.listStyle')" v-slot="{ ariaLabel }">
      <SettingsSegmented
        :value="ui.viewMode"
        :options="[
          { value: 'grid', label: t('settings.appearance.listStyleGrid') },
          { value: 'list', label: t('settings.appearance.listStyleList') },
        ]"
        :aria-label="ariaLabel"
        @change="ui.setViewMode($event as ViewMode)"
      />
    </SettingsRow>
  </div>

  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.appearance.details") }}</h3>
    <SettingsRow :label="t('settings.appearance.sidebarCounts')" v-slot="{ ariaLabel }">
      <SettingsToggle
        :checked="ui.prefs.showSidebarCounts"
        :aria-label="ariaLabel"
        @change="ui.setPref({ showSidebarCounts: $event })"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.appearance.cardThumbs')"
      :desc="t('settings.appearance.cardThumbsDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsToggle
        :checked="ui.prefs.showCovers"
        :aria-label="ariaLabel"
        @change="ui.setPref({ showCovers: $event })"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.appearance.reduceMotion')"
      :desc="t('settings.appearance.reduceMotionDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsToggle
        :checked="ui.prefs.reduceMotion"
        :aria-label="ariaLabel"
        @change="ui.setPref({ reduceMotion: $event })"
      />
    </SettingsRow>
  </div>
</template>
