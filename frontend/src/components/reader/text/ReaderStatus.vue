<script setup lang="ts">
// The line at the foot of the page.
//
// A chapter says where it is at its head — chapter three of nine, eight
// minutes left, the section being read — and the head is on the first screen
// and nowhere else. Scrolling down it is a mild loss. Reading in pages it is
// total: from the second page on, a reader has nothing at all to go on, and
// there is no page number anywhere in the app to make up for it.
//
// So: a quiet line under the text, off unless it is wanted, holding only the
// three things worth knowing without looking up — where you are, how much of
// the chapter is left, and what time it is.

import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../../stores/ui";

const props = defineProps<{
  /** Which page of how many, when the chapter is read in pages. */
  page?: number;
  pages?: number;
  /** Which column of how many, when a vertical (古籍) chapter is scrolled —
   *  the scrolled reader's page. */
  col?: number;
  cols?: number;
  /** How far through, 0–1 — what a scrolled chapter has instead of a page. */
  ratio: number;
  /** Minutes left in the chapter. A PDF has pages, not words, so this is
   *  omitted rather than invented. */
  minutesLeft?: number;
  /** Hidden with the rest of the chrome while the reader is going down. */
  visible: boolean;
}>();

const { t, locale } = useI18n();
const ui = useUi();

const paged = computed(() => props.pages != null && props.pages > 1);

const place = computed(() => {
  if (!ui.readerShowPage) return "";
  if (paged.value) {
    return t("reader.pageOf", { n: props.page ?? 1, total: props.pages });
  }
  if (props.cols != null && props.cols > 1) {
    return t("reader.colOf", { n: props.col ?? 1, total: props.cols });
  }
  return t("reader.progressPct", { n: Math.round(props.ratio * 100) });
});

// The clock ticks on the minute rather than on the second: a reader glancing
// down wants the time, and a digit changing in the corner of the eye every
// second is the opposite of reading.
const now = ref("");
let clock: number | undefined;
function tick() {
  now.value = new Date().toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" });
  clock = window.setTimeout(tick, 60_000 - (Date.now() % 60_000));
}
watch(
  () => [ui.readerShowClock, locale.value] as const,
  ([on]) => {
    window.clearTimeout(clock);
    clock = undefined;
    if (on) tick();
    else now.value = "";
  },
  { immediate: true },
);
onBeforeUnmount(() => window.clearTimeout(clock));

const anything = computed(
  () => ui.readerShowPage || (ui.readerShowLeft && props.minutesLeft != null) || ui.readerShowClock,
);
</script>

<template>
  <div
    v-if="anything"
    class="reader-status"
    :class="{ hidden: !visible }"
    aria-live="off"
    :aria-hidden="visible ? undefined : 'true'"
  >
    <span v-if="place">{{ place }}</span>
    <span v-if="ui.readerShowLeft && minutesLeft != null">{{ t("reader.minutesLeft", { n: minutesLeft }) }}</span>
    <span v-if="ui.readerShowClock && now">{{ now }}</span>
  </div>
</template>
