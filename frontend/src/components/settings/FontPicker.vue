<script setup lang="ts">
// One font picker (UI or reading axis): a select grouped by source — bundled /
// system / downloaded — with a "+ add font…" entry that reveals an inline
// add-by-URL field. Paste a direct font URL (e.g. a GitHub release .ttf/.otf)
// and the backend auto-detects the family name; if it can't (woff2), it asks
// for a name. A downloaded font selected here gets a delete button.

import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import { resolveReaderFont, resolveUiFont, SYSTEM_FONTS } from "../../lib/fonts";
import { reportError } from "../../stores/toasts";
import Icon from "../Icon.vue";
import SettingsRow from "./SettingsRow.vue";

const props = withDefaults(
  defineProps<{
    axis: "ui" | "reader";
    label: string;
    desc: string;
    /** Whether to show a line set in the chosen face. Off where the page
     *  already shows that face in a sample of its own — two samples of the
     *  same type, at different sizes and in different words, is not twice the
     *  information.
     *
     *  The default has to be spelled out: Vue casts a Boolean-typed prop, so
     *  an absent one arrives as `false` rather than as undefined, and every
     *  caller that did not mention it would lose its sample. */
    sample?: boolean;
  }>(),
  { sample: true },
);
const { t } = useI18n();
const ui = useUi();

const ADD = "__add__"; // sentinel select value

const value = computed(() => (props.axis === "ui" ? ui.uiFont : ui.readerFont));
const setValue = (v: string) => (props.axis === "ui" ? ui.setUiFont(v) : ui.setReaderFont(v));

const forAxis = (a: string) => a === props.axis || a === "both";
const installed = computed(() => ui.installedFonts.filter((f) => forAxis(f.axis)));

const selectedDownloadId = computed(() =>
  value.value.startsWith("downloaded:") ? value.value.slice(11) : null,
);
const canDelete = computed(
  () =>
    selectedDownloadId.value != null &&
    installed.value.some((f) => f.id === selectedDownloadId.value),
);

const preview = computed(() =>
  props.axis === "ui"
    ? resolveUiFont(value.value, ui.installedFonts) ?? "var(--ui)"
    : resolveReaderFont(value.value, ui.installedFonts).stack,
);

const selectRef = ref<HTMLSelectElement | null>(null);
const adding = ref(false);
const addUrl = ref("");
const addName = ref("");
const needName = ref(false);
const progress = ref<number | null>(null);

function onSelect(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  if (v === ADD) {
    adding.value = true;
    // The sentinel isn't a real value — snap the control back to the current one.
    nextTick(() => selectRef.value && (selectRef.value.value = value.value));
  } else {
    setValue(v);
  }
}

async function refreshInstalled() {
  try {
    ui.setInstalledFonts(await api.listInstalledFonts());
  } catch {
    /* keep the current list */
  }
}

function cancelAdd() {
  adding.value = false;
  addUrl.value = "";
  addName.value = "";
  needName.value = false;
}

async function addFont() {
  const url = addUrl.value.trim();
  if (!url || progress.value != null) return;
  if (needName.value && !addName.value.trim()) return;
  progress.value = 0;
  try {
    await api.addCustomFont(url, needName.value ? addName.value.trim() : "", "both", (p) => {
      progress.value = p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
    });
    await refreshInstalled();
    const f = ui.installedFonts.find((x) => x.source === url);
    if (f) setValue(`downloaded:${f.id}`);
    cancelAdd();
  } catch (e) {
    // woff2 / unreadable name table → ask the user for the family name and retry.
    if ((e as { code?: string })?.code === "fontNeedsFamily") needName.value = true;
    else reportError(e);
  } finally {
    progress.value = null;
  }
}

async function deleteSelected() {
  const id = selectedDownloadId.value;
  if (id == null) return;
  try {
    await api.deleteFont(id);
  } catch (e) {
    reportError(e);
  }
  const token = `downloaded:${id}`;
  if (ui.uiFont === token) ui.setUiFont("default");
  if (ui.readerFont === token) ui.setReaderFont("sans");
  await refreshInstalled();
}
</script>

<template>
  <SettingsRow :label="label" :desc="desc" v-slot="{ ariaLabel }">
    <div class="font-pick">
      <select
        ref="selectRef"
        class="s-select"
        :value="value"
        :aria-label="ariaLabel"
        @change="onSelect"
      >
        <optgroup :label="t('settings.fonts.bundled')">
          <option v-if="axis === 'ui'" value="default">{{ t("settings.fonts.appDefault") }}</option>
          <template v-else>
            <option value="serif">{{ t("settings.reading.serif") }}</option>
            <option value="sans">{{ t("settings.reading.sans") }}</option>
            <option value="hyperlegible">{{ t("settings.reading.hyperlegible") }}</option>
          </template>
        </optgroup>
        <optgroup :label="t('settings.fonts.system')">
          <option v-for="f in SYSTEM_FONTS" :key="f" :value="`system:${f}`">{{ f }}</option>
        </optgroup>
        <optgroup v-if="installed.length" :label="t('settings.fonts.downloaded')">
          <option v-for="f in installed" :key="f.id" :value="`downloaded:${f.id}`">{{ f.label }}</option>
        </optgroup>
        <optgroup :label="t('settings.fonts.add')">
          <option :value="ADD">+ {{ t("settings.fonts.addByUrl") }}</option>
        </optgroup>
      </select>
      <button
        v-if="canDelete"
        class="font-pick-del"
        :title="t('common.delete')"
        :aria-label="t('common.delete')"
        @click="deleteSelected"
      >
        <Icon name="trash" :size="14" />
      </button>
    </div>
  </SettingsRow>

  <div v-if="adding" class="font-add">
    <input
      class="s-input"
      v-model="addUrl"
      :placeholder="t('settings.fonts.urlPlaceholder')"
      @keydown.enter="addFont"
    />
    <input
      v-if="needName"
      class="s-input"
      v-model="addName"
      :placeholder="t('settings.fonts.familyPlaceholder')"
      @keydown.enter="addFont"
    />
    <p v-if="needName" class="font-add-hint">{{ t("settings.fonts.needName") }}</p>
    <div class="font-add-actions">
      <button class="s-btn" @click="cancelAdd">{{ t("common.cancel") }}</button>
      <button class="s-btn primary" :disabled="!addUrl.trim() || progress != null" @click="addFont">
        {{ progress != null ? `${progress}%` : t("settings.fonts.add") }}
      </button>
    </div>
  </div>

  <p v-if="sample" class="font-preview" :style="{ fontFamily: preview }">
    {{ axis === "ui" ? t("settings.fonts.previewUi") : t("settings.fonts.previewReader") }}
  </p>
</template>

<style scoped>
.font-pick {
  display: flex;
  align-items: center;
  gap: 8px;
}
.font-pick .s-select {
  flex: 1;
  min-width: 0;
}
.font-pick-del {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--hair);
  cursor: pointer;
}
.font-pick-del:hover {
  color: var(--accent);
  border-color: var(--hair-strong);
}
.font-add {
  margin: 10px 0 4px;
  padding: 12px;
  border: 1px solid var(--hair);
  border-radius: 10px;
  background: var(--panel-2);
}
.font-add .s-input {
  width: 100%;
  margin-bottom: 8px;
}
.font-add-hint {
  margin: 0 0 8px;
  font-size: 11.5px;
  color: var(--muted);
}
.font-add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.font-preview {
  margin: 8px 0 18px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ink-2);
}
</style>
