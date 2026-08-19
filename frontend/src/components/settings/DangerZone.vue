<script setup lang="ts">
// Danger zone: reset settings, wipe all local data. Each action is gated by a
// themed ConfirmDialog rather than the native, unstyled window.confirm.
// Toasts go through the global store.

import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import * as api from "../../api";
import { reportError, toast } from "../../stores/toasts";
import SettingsRow from "./SettingsRow.vue";
import ConfirmDialog from "../ConfirmDialog.vue";

const { t } = useI18n();
const qc = useQueryClient();

const confirming = ref<null | "reset" | "clear">(null);

async function doReset(): Promise<void> {
  try {
    await api.resetSettings();
    // Frontend prefs live entirely in localStorage (theme, reading metrics,
    // last view…). A partial allowlist left most of them behind after Reset.
    localStorage.clear();
    toast.show(t("settings.advanced.resetDone"));
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    reportError(e);
  }
}

async function doClear(): Promise<void> {
  try {
    await api.clearLibrary();
    await qc.invalidateQueries();
    toast.show(t("settings.advanced.clearDone"));
  } catch (e) {
    reportError(e);
  }
}

// ConfirmDialog does not auto-close on confirm, so the confirm handlers run
// the action and then dismiss the dialog themselves.
function onResetConfirm(): void {
  confirming.value = null;
  doReset();
}
function onClearConfirm(): void {
  confirming.value = null;
  doClear();
}
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.advanced.dangerZone") }}</h3>
    <SettingsRow
      :label="t('settings.advanced.resetSettings')"
      :desc="t('settings.advanced.resetSettingsDesc')"
    >
      <button class="s-btn" @click="confirming = 'reset'">
        {{ t("settings.advanced.reset") }}
      </button>
    </SettingsRow>
    <SettingsRow
      :label="t('settings.advanced.clearData')"
      :desc="t('settings.advanced.clearDataDesc')"
    >
      <button class="s-btn danger" @click="confirming = 'clear'">
        {{ t("settings.advanced.clear") }}
      </button>
    </SettingsRow>

    <ConfirmDialog
      v-if="confirming === 'reset'"
      :title="t('settings.advanced.resetSettings')"
      :message="t('settings.advanced.resetConfirm')"
      :confirm-label="t('settings.advanced.reset')"
      @confirm="onResetConfirm"
      @cancel="confirming = null"
    />
    <ConfirmDialog
      v-if="confirming === 'clear'"
      :title="t('settings.advanced.clearData')"
      :message="t('settings.advanced.clearConfirm')"
      :confirm-label="t('common.delete')"
      @confirm="onClearConfirm"
      @cancel="confirming = null"
    />
  </div>
</template>
