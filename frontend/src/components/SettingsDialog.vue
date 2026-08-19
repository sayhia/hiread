<script setup lang="ts">
// The tabbed preferences dialog (Vue 3 + vue-query + Wails).
//
//   • Props/callbacks → emits: `onClose` becomes `close`;
//     `onToast` is dropped — sections raise toasts through the global store.
//   • The shared row controls (Row / Toggle / Select / Segmented / Slider /
//     SettingFlag) and each section live in ./settings/ as small SFCs, since
//     cloneElement-style aria-label injection has no Vue equivalent and the
//     file is large. A single SFC was an option; this keeps each piece readable.
//   • The app version is read best-effort from a backend setting, "Launch at
//     login" is a persisted flag, and the About update check reports up-to-date.

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useFocusTrap } from "../composables/useFocusTrap";
import { modCombo } from "../lib/platform";
import Icon, { type IconName } from "./Icon.vue";
import { useAppVersion } from "./settings/useAppVersion";
import GeneralSection from "./settings/GeneralSection.vue";
import AppearanceSection from "./settings/AppearanceSection.vue";
import ReadingSection from "./settings/ReadingSection.vue";
import ShortcutsSection from "./settings/ShortcutsSection.vue";
import AiSection from "./settings/AiSection.vue";
import AdvancedSection from "./settings/AdvancedSection.vue";
import AboutSection from "./settings/AboutSection.vue";

const props = defineProps<{
  initialSection?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { t } = useI18n();

// `labelKey` holds an i18n key — resolved with t() at render time.
// Per-section icon-tile colours — a cohesive cool range (blue / cyan / teal /
// violet / slate), no warm hues, so the settings nav matches hiread's identity.
const SECTIONS: { id: string; labelKey: string; icon: IconName; color: string }[] = [
  { id: "general", labelKey: "settings.nav.general", icon: "settings", color: "#64748B" },
  { id: "appearance", labelKey: "settings.nav.appearance", icon: "globe", color: "#3D7DFF" },
  { id: "reading", labelKey: "settings.nav.reading", icon: "eye", color: "#0E9FB5" },
  { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: "command", color: "#5B6CD6" },
  { id: "ai", labelKey: "settings.nav.ai", icon: "sparkle-fill", color: "#7C5CFF" },
  { id: "advanced", labelKey: "settings.nav.advanced", icon: "sort", color: "#566273" },
  { id: "about", labelKey: "settings.nav.about", icon: "sparkle", color: "#1E54CC" },
];

const SECTION_IDS = SECTIONS.map((s) => s.id);
function loadSection(): string {
  if (props.initialSection && SECTION_IDS.includes(props.initialSection)) {
    return props.initialSection;
  }
  try {
    const raw = localStorage.getItem("settings.section");
    if (raw && SECTION_IDS.includes(raw)) return raw;
  } catch {
    /* private mode */
  }
  return "general";
}
const section = ref(loadSection());
watch(section, (id) => {
  try {
    localStorage.setItem("settings.section", id);
  } catch {
    /* private mode */
  }
});
const windowRef = ref<HTMLDivElement | null>(null);
const version = useAppVersion();
useFocusTrap(windowRef, true, { autoFocus: false });

const cur = computed(() => SECTIONS.find((s) => s.id === section.value)!);

const subs = computed<Record<string, string>>(() => ({
  general: t("settings.sub.general"),
  appearance: t("settings.sub.appearance"),
  reading: t("settings.sub.reading"),
  shortcuts: t("settings.sub.shortcuts"),
  ai: t("settings.sub.ai"),
  advanced: t("settings.sub.advanced"),
  about: t("settings.sub.about"),
}));

// Escape closes the dialog regardless of which control holds focus. Captured so
// it pre-empts background handlers (App.vue's global key map skips Settings).
function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // A nested prompt / confirm owns Escape first.
  // Only a nested confirm/prompt inside Settings owns Esc. A sibling
  // overlay (AI, book details) also uses .modal-backdrop — skipping those
  // left Settings up and closed the chat underneath.
  if (document.querySelector(".prompt-dialog, [role='alertdialog']")) return;
  e.stopPropagation();
  emit("close");
}
onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  void nextTick(() => {
    windowRef.value?.querySelector<HTMLElement>(".settings-nav-item.active")?.focus();
  });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));

function onNavKey(e: KeyboardEvent) {
  const i = SECTION_IDS.indexOf(section.value);
  if (i < 0) return;
  let next: string | undefined;
  if (e.key === "ArrowDown" || e.key === "ArrowRight") {
    next = SECTION_IDS[(i + 1) % SECTION_IDS.length];
  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
    next = SECTION_IDS[(i - 1 + SECTION_IDS.length) % SECTION_IDS.length];
  } else if (e.key === "Home") {
    next = SECTION_IDS[0];
  } else if (e.key === "End") {
    next = SECTION_IDS[SECTION_IDS.length - 1];
  }
  if (!next) return;
  e.preventDefault();
  section.value = next;
  nextTick(() =>
    windowRef.value?.querySelector<HTMLElement>(".settings-nav-item.active")?.focus(),
  );
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-backdrop" @click="emit('close')">
      <div
        class="settings-window"
        ref="windowRef"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.title')"
        @click.stop
      >
        <div class="settings-sidebar" role="tablist" :aria-label="t('settings.title')" @keydown="onNavKey">
          <div class="settings-sidebar-title">
            {{ t("settings.title") }}
            <span class="badge">{{ modCombo(",") }}</span>
          </div>
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            type="button"
            role="tab"
            class="settings-nav-item"
            :class="{ active: section === s.id }"
            :aria-selected="section === s.id"
            :tabindex="section === s.id ? 0 : -1"
            @click="section = s.id"
          >
            <span class="nav-ico" :style="{ background: s.color }">
              <Icon :name="s.icon" :size="11" color="#fff" />
            </span>
            {{ t(s.labelKey) }}
          </button>
          <div class="settings-nav-spacer" />
          <div class="settings-version">Hiread<template v-if="version"> {{ version }}</template></div>
        </div>

        <div class="settings-content">
          <div class="settings-header">
            <h2>{{ t(cur.labelKey) }}</h2>
            <span class="sub">{{ subs[section] }}</span>
          </div>
          <button
            class="settings-close"
            @click="emit('close')"
            :title="t('settings.closeTitle')"
            :aria-label="t('settings.closeTitle')"
          >
            <Icon name="x" :size="15" />
          </button>

          <div class="settings-scroll">
            <GeneralSection v-if="section === 'general'" />
            <AppearanceSection v-else-if="section === 'appearance'" />
            <ReadingSection v-else-if="section === 'reading'" />
            <ShortcutsSection v-else-if="section === 'shortcuts'" />
            <AiSection v-else-if="section === 'ai'" />
            <AdvancedSection v-else-if="section === 'advanced'" />
            <AboutSection v-else-if="section === 'about'" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
