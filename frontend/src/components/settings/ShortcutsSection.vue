<script setup lang="ts">
// Shortcuts: a static, grouped keyboard cheat sheet. Modifier glyphs come
// from the platform helper.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { modKey } from "../../lib/platform";
import { useUi } from "../../stores/ui";

const { t } = useI18n();
const ui = useUi();

/** J/K page when the chapter runs across (paged or 古籍), the same turn
 *  the arrows describe. Only orientation remaps ←/→ themselves. */
const pages = computed(
  () => ui.readerPageMode === "paged" || ui.readerOrientation === "vertical",
);

function turn(dir: "next" | "prev") {
  if (ui.readerOrientation === "vertical") return t(`settings.shortcuts.${dir}Column`);
  if (pages.value) return t(`settings.shortcuts.${dir}Page`);
  return t(`settings.shortcuts.${dir}Chapter`);
}

const groups = computed(() => [
  {
    title: t("settings.shortcuts.navigation"),
    items: [
      ui.readerOrientation === "vertical"
        ? { desc: t("settings.shortcuts.prevColumn"), keys: ["→"] }
        : { desc: t("settings.shortcuts.nextChapter"), keys: ["→"] },
      ui.readerOrientation === "vertical"
        ? { desc: t("settings.shortcuts.nextColumn"), keys: ["←"] }
        : { desc: t("settings.shortcuts.prevChapter"), keys: ["←"] },
      { desc: turn("next"), keys: ["J"] },
      { desc: turn("prev"), keys: ["K"] },
      { desc: t("settings.shortcuts.pageDown"), keys: ["Space"] },
      { desc: t("settings.shortcuts.pageUp"), keys: ["⇧", "Space"] },
      { desc: t("settings.shortcuts.chapterEnds"), keys: ["Home", "End"] },
      { desc: t("settings.shortcuts.toc"), keys: ["C"] },
      { desc: t("reader.searchInBook"), keys: [modKey, "F", "/"] },
      { desc: t("settings.shortcuts.closeBook"), keys: ["Esc"] },
    ],
  },
  {
    title: t("settings.shortcuts.actions"),
    items: [
      { desc: t("settings.shortcuts.addBooks"), keys: [modKey, "O"] },
      { desc: t("settings.shortcuts.aiSummary"), keys: ["I"] },
      { desc: t("settings.shortcuts.translate"), keys: ["T"] },
      { desc: t("settings.shortcuts.typography"), keys: ["A"] },
      { desc: t("settings.shortcuts.autoScroll"), keys: ["S"] },
      { desc: t("settings.shortcuts.readAloud"), keys: ["R"] },
      { desc: t("settings.shortcuts.skipSentence"), keys: ["[", "]"] },
    ],
  },
  {
    title: t("settings.shortcuts.readingPdf"),
    items: [
      { desc: t("settings.shortcuts.nextPage"), keys: ["Space"] },
      { desc: t("settings.shortcuts.pageEnds"), keys: ["Home", "End"] },
      { desc: t("reader.zoomIn"), keys: ["+"] },
      { desc: t("reader.zoomOut"), keys: ["−"] },
      { desc: t("reader.zoomFit"), keys: ["0"] },
    ],
  },
  {
    title: t("settings.shortcuts.view"),
    items: [
      { desc: t("settings.shortcuts.focusReading"), keys: ["F"] },
      { desc: t("settings.shortcuts.toggleTheme"), keys: ["⇧", "D"] },
    ],
  },
  {
    title: t("settings.shortcuts.global"),
    items: [
      { desc: t("settings.shortcuts.commandPalette"), keys: [modKey, "K"] },
      { desc: t("settings.shortcuts.openSettings"), keys: [modKey, ","] },
    ],
  },
]);
</script>

<template>
  <div class="settings-group" v-for="g in groups" :key="g.title">
    <h3 class="settings-group-title">{{ g.title }}</h3>
    <div class="s-shortcuts">
      <div class="s-shortcut" v-for="(it, i) in g.items" :key="i">
        <span class="desc">{{ it.desc }}</span>
        <span class="keys">
          <span class="s-key" v-for="(k, j) in it.keys" :key="j">{{ k }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
