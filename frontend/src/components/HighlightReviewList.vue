<script setup lang="ts">
// Review tab body: 3 fixed lookback windows (3 days / 2 weeks / 2 months),
// each showing up to 5 randomly-sampled highlights. The sample is seeded by
// today's date plus a "reshuffle" counter, so re-opening the tab on the same
// day shows the same set until the user explicitly asks for a new one — see
// bucketize()/sample() in lib/highlightBuckets.ts for the determinism
// contract this depends on.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { bucketize, sample } from "../lib/highlightBuckets";
import type { HighlightWithContext } from "../types";
import HighlightCard from "./HighlightCard.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ allRows: HighlightWithContext[] }>();
const emit = defineEmits<{
  (e: "select", h: HighlightWithContext): void;
  (e: "open-external", h: HighlightWithContext): void;
  (e: "menu", h: HighlightWithContext, ev: MouseEvent): void;
}>();

const { t } = useI18n();

const selectedId = ref<number | null>(null);
const reshuffleCount = ref(0);
// One-shot spin on the Shuffle icon — the resample itself is an instant,
// purely client-side computed re-run with no loading state of its own, so
// without this the click has zero visible feedback and reads as dead. Reuses
// styles.css's shared `spin` keyframe (already used for refresh/AI-busy
// icons) but runs it once, not `infinite` — see the scoped
// `.hl-reshuffle-spin` rule below, removed on `animationend` rather than an
// arbitrary timeout so it never gets cut off mid-rotation.
const justReshuffled = ref(false);

const dateSeed = new Date().toISOString().slice(0, 10);
const seed = computed(() => `${dateSeed}#${reshuffleCount.value}`);

interface Bucket {
  key: "threeDays" | "twoWeeks" | "twoMonths";
  label: string;
  items: HighlightWithContext[];
}

const buckets = computed<Bucket[]>(() => {
  const b = bucketize(props.allRows);
  const list: Bucket[] = [
    { key: "threeDays", label: t("highlights.review.buckets.threeDays"), items: sample(b.threeDays, seed.value, 5) },
    { key: "twoWeeks", label: t("highlights.review.buckets.twoWeeks"), items: sample(b.twoWeeks, seed.value, 5) },
    { key: "twoMonths", label: t("highlights.review.buckets.twoMonths"), items: sample(b.twoMonths, seed.value, 5) },
  ];
  return list.filter((bucket) => bucket.items.length > 0);
});

const isEmpty = computed(() => buckets.value.length === 0);

function reshuffle(): void {
  reshuffleCount.value += 1;
  selectedId.value = null;
  justReshuffled.value = false;
  // Re-trigger the animation even on rapid repeat clicks: toggling off then
  // back on next frame restarts the CSS animation instead of a no-op class
  // re-add (which the browser would ignore since the class never left).
  requestAnimationFrame(() => { justReshuffled.value = true; });
}
function onReshuffleSpinEnd(): void {
  justReshuffled.value = false;
}

function onSelect(h: HighlightWithContext): void {
  emit("select", h);
}
function onOpenExternal(h: HighlightWithContext): void {
  emit("open-external", h);
}
function onMenu(h: HighlightWithContext, ev: MouseEvent): void {
  selectedId.value = h.id;
  emit("menu", h, ev);
}
</script>

<template>
  <div class="hl-review">
    <div class="list-meta">
      <button type="button" class="list-meta-btn" @click="reshuffle">
        <span
          class="hl-reshuffle-ico"
          :class="{ 'hl-reshuffle-spin': justReshuffled }"
          @animationend="onReshuffleSpinEnd"
        >
          <Icon name="refresh" :size="12" />
        </span>
        {{ t("highlights.review.reshuffle") }}
      </button>
    </div>

    <div v-if="isEmpty" class="empty" style="min-height: 320px">
      <div class="glyph"><Icon name="highlighter" :size="22" /></div>
      <div class="hl-empty-title">{{ t("highlights.review.empty") }}</div>
    </div>

    <div v-else>
      <section v-for="bucket in buckets" :key="bucket.key" class="hl-group">
        <header class="hl-group-head">
          <span class="hl-group-title">{{ bucket.label }}</span>
          <span class="hl-group-count">{{ bucket.items.length }}</span>
        </header>
        <ul class="hl-list">
          <li v-for="h in bucket.items" :key="h.id" :data-hl-row="h.id">
            <HighlightCard
              :highlight="h"
              :selected="h.id === selectedId"
              @select="onSelect"
              @open-external="onOpenExternal"
              @menu="onMenu"
            />
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.hl-review { display: flex; flex-direction: column; min-height: 0; }
/* This tab's toolbar renders directly under HighlightsPane's <header>, not
   inside it — .list-header normally supplies the left/right breathing room
   and the separating hairline that .list-meta relies on, so this component
   must provide both itself or the "Shuffle" chip reads as flush-left and
   floating with nothing below it. */
.hl-review > .list-meta {
  padding: 10px var(--list-px);
  margin-top: 0;
  border-bottom: 1px solid var(--hair);
}
.hl-reshuffle-ico { display: inline-flex; }
/* One-shot spin feedback on click — reuses styles.css's shared `spin`
   keyframe but runs it once (not `infinite`, unlike `.spinning`), removed
   via @animationend in the script above. */
.hl-reshuffle-spin { animation: spin 0.4s ease-out 1; }
</style>
