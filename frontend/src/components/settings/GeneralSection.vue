<script setup lang="ts">
// General: app icon, read behaviour, and startup view.

import { useI18n } from "vue-i18n";
import { useUi } from "../../stores/ui";
import { APP_ICONS, iconPng, type AppIcon } from "../../lib/appIcon";
import SettingsRow from "./SettingsRow.vue";
import SettingsToggle from "./SettingsToggle.vue";
import SettingsSelect from "./SettingsSelect.vue";
import type { StartupView } from "../../stores/ui";

const { t } = useI18n();
const ui = useUi();
</script>

<template>
  <div class="settings-group">
    <SettingsRow
      :label="t('settings.general.appIcon')"
      :desc="t('settings.general.appIconDesc')"
    >
      <div class="s-icon-picks" role="radiogroup" :aria-label="t('settings.general.appIcon')">
        <button
          v-for="id in APP_ICONS"
          :key="id"
          type="button"
          class="s-icon-pick"
          :class="{ on: ui.appIcon === id }"
          role="radio"
          :aria-checked="ui.appIcon === id"
          :title="t(`settings.general.icon.${id}`)"
          :aria-label="`${t(`settings.general.icon.${id}`)} — ${t(`settings.general.icon.${id}Hint`)}`"
          @click="ui.setAppIcon(id as AppIcon)"
        >
          <img class="s-icon-pick-img" :src="iconPng(id)" alt="" />
        </button>
      </div>
    </SettingsRow>
  </div>

  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.general.readBehavior") }}</h3>
    <SettingsRow
      :label="t('settings.general.autoAdvanceChapter')"
      :desc="t('settings.general.autoAdvanceChapterDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsToggle
        :checked="ui.prefs.autoAdvanceChapter"
        :aria-label="ariaLabel"
        @change="ui.setPref({ autoAdvanceChapter: $event })"
      />
    </SettingsRow>
    <SettingsRow
      :label="t('settings.general.markFinishedAtEnd')"
      :desc="t('settings.general.markFinishedAtEndDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsToggle
        :checked="ui.prefs.markFinishedAtEnd"
        :aria-label="ariaLabel"
        @change="ui.setPref({ markFinishedAtEnd: $event })"
      />
    </SettingsRow>
  </div>

  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.general.startup") }}</h3>
    <SettingsRow
      :label="t('settings.general.startupView')"
      :desc="t('settings.general.startupViewDesc')"
      v-slot="{ ariaLabel }"
    >
      <SettingsSelect
        :value="ui.prefs.startupView"
        :options="[
          { value: 'all', label: t('settings.general.startupAll') },
          { value: 'reading', label: t('smart.reading') },
          { value: 'favorite', label: t('smart.favorite') },
          { value: 'finished', label: t('smart.finished') },
          { value: 'highlights', label: t('smart.highlights') },
          { value: 'last', label: t('settings.general.startupLast') },
        ]"
        :aria-label="ariaLabel"
        @change="ui.setPref({ startupView: $event as StartupView })"
      />
    </SettingsRow>
  </div>
</template>
