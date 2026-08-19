<script setup lang="ts">
// Downloaded fonts as managed assets: total disk used, each font's size + which
// axis uses it + delete, and a "remove unused" cleanup. Choosing a font lives in
// Reading; this is the storage/asset side (sits with the DB/cache controls).

import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import { reportError, toast } from "../../stores/toasts";
import { formatBytes } from "./helpers";
import Icon from "../Icon.vue";

const { t } = useI18n();
const ui = useUi();

onMounted(refresh);
async function refresh() {
  try {
    ui.setInstalledFonts(await api.listInstalledFonts());
  } catch {
    /* keep the current list */
  }
}

const fonts = computed(() => ui.installedFonts);
const totalBytes = computed(() => fonts.value.reduce((n, f) => n + (f.bytes || 0), 0));

function usedBy(id: string): ("ui" | "reader")[] {
  const out: ("ui" | "reader")[] = [];
  if (ui.uiFont === `downloaded:${id}`) out.push("ui");
  if (ui.readerFont === `downloaded:${id}`) out.push("reader");
  return out;
}

async function remove(id: string) {
  try {
    await api.deleteFont(id);
  } catch (e) {
    reportError(e);
  }
  if (ui.uiFont === `downloaded:${id}`) ui.setUiFont("default");
  if (ui.readerFont === `downloaded:${id}`) ui.setReaderFont("sans");
  await refresh();
}

async function removeUnused() {
  const unused = fonts.value.filter((f) => usedBy(f.id).length === 0);
  if (!unused.length) {
    toast.show(t("settings.fonts.noneUnused"));
    return;
  }
  for (const f of unused) {
    try {
      await api.deleteFont(f.id);
    } catch (e) {
      reportError(e);
    }
  }
  await refresh();
  toast.show(t("settings.fonts.removedUnused", { count: unused.length }));
}
</script>

<template>
  <div class="settings-group">
    <h3 class="settings-group-title">{{ t("settings.fonts.storageTitle") }}</h3>
    <p v-if="!fonts.length" class="fs-empty">{{ t("settings.fonts.noneDownloaded") }}</p>
    <template v-else>
      <div class="fs-head">
        <span class="fs-total">{{ fonts.length }} · {{ formatBytes(totalBytes) }}</span>
        <button class="s-btn" @click="removeUnused">{{ t("settings.fonts.removeUnused") }}</button>
      </div>
      <div class="fs-list">
        <div v-for="f in fonts" :key="f.id" class="fs-item">
          <div class="fs-meta">
            <span class="fs-name">{{ f.label }}</span>
            <span class="fs-sub">
              {{ formatBytes(f.bytes) }}<template v-if="f.license"> · {{ f.license }}</template>
            </span>
          </div>
          <span v-for="u in usedBy(f.id)" :key="u" class="fs-badge">
            {{ u === "ui" ? t("settings.fonts.uiFont") : t("settings.fonts.readerFont") }}
          </span>
          <button
            class="fs-del"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            @click="remove(f.id)"
          >
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fs-empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
}
.fs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.fs-total {
  font-size: 13px;
  color: var(--ink-2);
}
.fs-list {
  border: 1px solid var(--hair);
  border-radius: 10px;
  overflow: hidden;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
}
.fs-item + .fs-item {
  border-top: 1px solid var(--hair);
}
.fs-meta {
  flex: 1;
  min-width: 0;
}
.fs-name {
  display: block;
  font-size: 13px;
  color: var(--ink);
}
.fs-sub {
  display: block;
  margin-top: 1px;
  font-size: 11px;
  color: var(--muted);
}
.fs-badge {
  flex: none;
  font-size: 10.5px;
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 2px 8px;
}
.fs-del {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius, 8px);
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--hair);
  cursor: pointer;
}
.fs-del:hover {
  color: var(--accent);
  border-color: var(--hair-strong);
}
</style>
