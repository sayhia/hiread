<script setup lang="ts">
// Storage: what the library costs on disk, and the one maintenance action a
// SQLite-backed library needs. There is deliberately no retention policy here —
// every book in a library was put there on purpose, so nothing should expire on
// its own.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import * as api from "../../api";
import { reportError, toast } from "../../stores/toasts";
import { formatBytes } from "./helpers";
import SettingsRow from "./SettingsRow.vue";

const { t } = useI18n();
const qc = useQueryClient();
const busy = ref(false);

const stats = useQuery({
  queryKey: ["storage-stats"],
  queryFn: api.storageStats,
  staleTime: 30_000,
});

/** VACUUM rebuilds the database file. Deleting a 40 MB illustrated book frees
 *  its pages for reuse but does not shrink the file — which is exactly when a
 *  user comes looking for this button. */
async function vacuum(): Promise<void> {
  busy.value = true;
  try {
    await api.vacuumDb();
    await qc.invalidateQueries({ queryKey: ["storage-stats"] });
    toast.show(t("settings.advanced.vacuumDone"));
  } catch (e) {
    reportError(e);
  } finally {
    busy.value = false;
  }
}

const s = computed(() => stats.data.value);
const usageDesc = computed(() =>
  s.value
    ? t("settings.advanced.dbUsageDesc", {
        books: s.value.bookCount,
        chapters: s.value.chapterCount,
      })
    : t("settings.advanced.calculating"),
);
/** How much of the database is book payload — images and PDF originals — rather
 *  than text and metadata. It is almost always the bulk of it. */
const payload = computed(() => (s.value ? formatBytes(s.value.resourceBytes) : "—"));
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.advanced.storage") }}</h3>
    <SettingsRow :label="t('settings.advanced.dbUsage')" :desc="usageDesc">
      <span class="s-value">{{ s ? formatBytes(s.dbBytes) : "—" }}</span>
    </SettingsRow>
    <SettingsRow
      :label="t('settings.advanced.bookPayload')"
      :desc="t('settings.advanced.bookPayloadDesc')"
    >
      <span class="s-value">{{ payload }}</span>
    </SettingsRow>
    <SettingsRow :label="t('settings.advanced.vacuum')" :desc="t('settings.advanced.vacuumDesc')">
      <button class="s-btn" @click="vacuum" :disabled="busy">
        {{ t("settings.advanced.compress") }}
      </button>
    </SettingsRow>
  </div>
</template>
