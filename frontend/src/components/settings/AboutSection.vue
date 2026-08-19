<script setup lang="ts">
// About — the app mark, name, tagline, version, a real update check against
// the repository's release feed, the project links, a copy-diagnostics
// affordance for bug reports, and a colophon. The mark is
// frontend/public/icons/{night,dawn,gold,platinum}.png — the moon-and-book mark shared
// with the macOS dock / window, following the appearance setting.

import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Browser } from "@wailsio/runtime";
import * as api from "../../api";
import { useUi } from "../../stores/ui";
import { reportError, toast } from "../../stores/toasts";
import type { AppInfo, UpdateInfo } from "../../types";
import Icon from "../Icon.vue";

const { t } = useI18n();
const ui = useUi();

// Build identity from the backend (the Go const is the single source of
// truth). A fallback version keeps the pane sensible if the call fails.
const info = ref<AppInfo | null>(null);
onMounted(() => {
  api
    .appInfo()
    .then((v) => (info.value = v))
    .catch(() => {});
});

// Project links — opened in the system browser (not the webview).
const REPO_URL = "https://github.com/sunmking/hiread";
const links = [
  { label: "GitHub", url: REPO_URL, icon: "globe" as const },
  { labelKey: "settings.about.reportIssue", url: `${REPO_URL}/issues`, icon: "alert" as const },
  { labelKey: "settings.about.releaseNotes", url: `${REPO_URL}/releases`, icon: "list" as const },
];
function openLink(url: string): void {
  Browser.OpenURL(url).catch(() => {});
}

// ── update check — real: the backend asks the release feed. ──
const checking = ref(false);
const update = ref<UpdateInfo | null>(null);
async function onCheck(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  try {
    update.value = await api.checkForUpdate();
    if (!update.value.hasUpdate) toast.show(t("update.upToDate"));
  } catch (e) {
    reportError(e);
  } finally {
    checking.value = false;
  }
}

// ── copy diagnostics — version + platform, ready to paste into a report. ──
async function copyDiagnostics(): Promise<void> {
  const v = info.value;
  const line = v
    ? `Hiread v${v.version} (${v.os}/${v.arch})`
    : "Hiread (version unavailable)";
  try {
    await navigator.clipboard.writeText(line);
    toast.show(t("settings.about.diagCopied"));
  } catch (e) {
    reportError(e);
  }
}
</script>

<template>
  <div class="s-about">
    <div class="about-hero">
      <img
        class="about-mark"
        :src="ui.iconSrc"
        :data-tone="ui.appIcon"
        alt="Hiread"
        width="76"
        height="76"
      />
      <h1 class="app-name">Hiread</h1>
      <p class="tagline">{{ t("settings.about.tagline") }}</p>
      <button
        class="version-chip"
        :title="t('settings.about.copyDiag')"
        @click="copyDiagnostics"
      >
        v{{ info?.version ?? "…" }}
        <span v-if="info" class="version-platform">{{ info.os }}/{{ info.arch }}</span>
      </button>
    </div>

    <!-- A found update surfaces inline, not just as a transient toast. -->
    <div v-if="update?.hasUpdate" class="about-update">
      <Icon name="sparkle" :size="14" />
      <span>{{ t("update.available", { version: update.latest }) }}</span>
      <button
        v-if="update.releaseUrl"
        class="s-btn primary"
        @click="openLink(update.releaseUrl)"
      >
        {{ t("update.download") }}
      </button>
    </div>

    <div class="about-actions">
      <button class="about-btn" @click="onCheck" :disabled="checking">
        <Icon name="refresh" :size="14" :class="checking ? 'spinning' : ''" />
        {{ checking ? t("update.checking") : t("update.checkButton") }}
      </button>
      <a
        v-for="l in links"
        :key="l.url"
        class="about-btn ghost"
        href="#"
        @click.prevent="openLink(l.url)"
      >
        <Icon :name="l.icon" :size="14" />
        {{ "label" in l && l.label ? l.label : t(l.labelKey!) }}
      </a>
    </div>

    <div class="about-colophon">
      <div class="about-colophon-label">{{ t("settings.about.colophon") }}</div>
      <p>{{ t("settings.about.creditsBuilt") }}</p>
      <p class="about-thanks">{{ t("settings.about.creditsThanks") }}</p>
    </div>
  </div>
</template>
