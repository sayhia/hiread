<script setup lang="ts">
// The settings a reader reaches for over an open book.
//
// It used to be a hand-written form: a size stepper, then three boxed segment
// rows, then a paper row, then two more toggles, each with its own shape and
// its own spacing, and a header whose close button fell onto a second line
// because the rule that would have put it beside the title was never written.
// Adding a setting meant drawing it here and again in Settings.
//
// It walks the schema now. Every setting in a group is a row — name on the
// left, control on the right, one row height, one control width — and the
// control draws itself from what kind of setting it is. What this component
// still decides is what belongs over a page rather than in Settings: named
// positions instead of numbers, three groups at a time behind a tab strip
// rather than one long scroll, and the two things that are about *this book*
// rather than about reading in general — the presets and the per-book switch.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../../stores/ui";
import { useDismiss } from "../../../composables/useDismiss";
import { useFocusTrap } from "../../../composables/useFocusTrap";
import { swallowPageClick } from "../../../composables/reader/useTextReaderInput";
import {
  groupsFor,
  settingsFor,
  settingVisible,
  type ReadingSurface,
  type SettingGroup,
} from "../../../lib/reading/schema";
import { matchingReadingPreset } from "../../../lib/readerSettings";
import ReadingControl from "./ReadingControl.vue";
import Icon from "../../Icon.vue";

const props = defineProps<{
  bookId: number;
  /** A PDF is a picture of a page: only the surface settings reach it. */
  isPdf?: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}>();

const { t } = useI18n();
const ui = useUi();

const panel = ref<HTMLDivElement>();
useDismiss(panel, () => {
  swallowPageClick();
  props.onClose();
}, {
  ignore: (e) => !!(e.target as Element | null)?.closest?.(".tb-type"),
});
useFocusTrap(panel);

const surface = computed<ReadingSurface>(() => (props.isPdf ? "pdf" : "text"));
const groups = computed(() => groupsFor(surface.value));
const TAB_KEY = "reading.aaTab";
function tabOrFirst(want: string | null): SettingGroup {
  const g = groups.value;
  return g.includes(want as SettingGroup) ? (want as SettingGroup) : (g[0] ?? "page");
}
const tab = ref<SettingGroup>(tabOrFirst(localStorage.getItem(TAB_KEY)));
watch(tab, (g) => localStorage.setItem(TAB_KEY, g));
watch(
  () => groups.value.join(),
  () => {
    if (!groups.value.includes(tab.value)) tab.value = groups.value[0] ?? "page";
  },
);
const rows = computed(() =>
  settingsFor(surface.value, tab.value, "compact").filter((s) =>
    settingVisible(s, ui.readerOrientation, ui.readerPageMode),
  ),
);

function onTabKey(e: KeyboardEvent) {
  e.stopPropagation();
  const list = groups.value;
  const i = list.indexOf(tab.value);
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    tab.value = list[(i + 1) % list.length];
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    tab.value = list[(i - 1 + list.length) % list.length];
  } else if (e.key === "Home") {
    e.preventDefault();
    tab.value = list[0];
  } else if (e.key === "End") {
    e.preventDefault();
    tab.value = list[list.length - 1];
  } else {
    return;
  }
  void nextTick(() => {
    panel.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
}

const PRESETS = ["day", "comfort", "night"] as const;
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

/** The app's theme, not the page's — so it is not a reading setting and has no
 *  row in the schema. It is offered here anyway, because the reader who wants
 *  it wants it at the moment the room gets dark, and that moment is spent
 *  looking at a page rather than at Settings. */
const THEMES = [
  { value: "light", key: "light" },
  { value: "dark", key: "dark" },
  { value: "auto", key: "auto" },
] as const;

/** The reset here is the one a reader reaches from over a page, so it puts
 *  back what a book can hold and leaves the global habits alone. */
const isDefault = computed(() => ui.isReadingDefault("book"));
</script>

<template>
  <div
    class="rp"
    :class="{ 'rp-pdf': isPdf }"
    ref="panel"
    role="dialog"
    aria-modal="true"
    :aria-label="t('reading.title')"
  >
    <header class="rp-head">
      <strong>{{ t("reading.title") }}</strong>
      <button class="rp-close" @click="onClose" :aria-label="t('common.close')">
        <Icon name="x" :size="14" />
      </button>
    </header>

    <div v-if="groups.length > 1" class="rp-tabs" role="tablist" @keydown="onTabKey">
      <button
        v-for="g in groups"
        :key="g"
        role="tab"
        :class="{ on: tab === g }"
        :aria-selected="tab === g"
        :tabindex="tab === g ? 0 : -1"
        @click="tab = g"
      >
        {{ t(`reading.group.${g}`) }}
      </button>
    </div>

    <div class="rp-body">
      <!-- What a reader actually wants most of the time: the whole page at
           once, rather than four settings that have to agree. -->
      <div v-if="tab === 'page'" class="rp-row rp-presets">
        <span class="rp-row-label">{{ t("reading.presets") }}</span>
        <div class="rp-preset-row">
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
            v-if="!isPdf"
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
      </div>

      <ReadingControl v-for="s in rows" :key="s.key" :setting="s" mode="compact" />

      <div v-if="tab === 'page'" class="rs-row rs-compact">
        <div class="rs-text"><span class="rs-label">{{ t("reader.type.theme") }}</span></div>
        <div class="rs-control">
          <div class="rs-seg" role="group" :aria-label="t('reader.type.theme')">
            <button
              v-for="th in THEMES"
              :key="th.value"
              type="button"
              :class="{ on: ui.theme === th.value }"
              :aria-pressed="ui.theme === th.value"
              @click="ui.setTheme(th.value)"
            >
              {{ t(`reader.type.theme_${th.key}`) }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <footer class="rp-foot">
      <label class="rp-perbook">
        <span>
          <strong>{{ t("reading.perBook") }}</strong>
          <em>{{ t("reading.perBookDesc") }}</em>
        </span>
        <input
          type="checkbox"
          class="rs-switch"
          :checked="ui.perBook"
          @change="ui.setPerBook(bookId, ($event.target as HTMLInputElement).checked)"
        />
      </label>
      <div class="rp-foot-acts">
        <button class="rp-reset" :disabled="isDefault" @click="ui.resetReading('book')">
          {{ t("reading.reset") }}
        </button>
        <button class="rp-more" @click="onOpenSettings">
          <Icon name="settings" :size="13" />
          {{ t("reading.more") }}
        </button>
      </div>
    </footer>
  </div>
</template>
