<script setup lang="ts">
// Full-screen image viewer. Opens from a click on an article-body image and
// cycles through every figure in the chapter via the on-screen arrows or the
// ← / → keys; Escape, Space, or a still click on the backdrop closes it. Wheel
// and pinch zoom the plate; a sideways wheel at 1:1 turns the plate the same
// way a swipe does; a drag pans once it is larger than the stage.
//
// The `.image-viewer` root class doubles as the "a modal is open" marker the
// global shortcut handlers bail on (App.vue onKey, Reader's space/`t` keys),
// so j/k article flips can't yank the article out from under the gallery.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { pageDirFromSide } from "../lib/reading/direction";
import { useUi } from "../stores/ui";
import { useFocusTrap } from "../composables/useFocusTrap";
import Icon from "./Icon.vue";

const props = defineProps<{
  /** The working (already-loaded, possibly proxied) src of every image in the
   *  article, in reading order. */
  srcs: string[];
  /** Optional captions, aligned with `srcs`. Empty strings are hidden. */
  alts?: string[];
  /** Index of the image the user clicked. */
  index: number;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const { t } = useI18n();
const ui = useUi();

const root = ref<HTMLElement>();
useFocusTrap(root);

const i = ref(props.index);
const many = computed(() => props.srcs.length > 1);
const caption = computed(() => (props.alts?.[i.value] ?? "").trim());
const vertical = computed(() => ui.readerOrientation === "vertical");

const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const dragging = ref(false);

function resetView() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  dragging.value = false;
}

watch(i, resetView);

const prev = () => {
  if (!many.value) return;
  i.value = (i.value - 1 + props.srcs.length) % props.srcs.length;
};
const next = () => {
  if (!many.value) return;
  i.value = (i.value + 1) % props.srcs.length;
};

function clampScale(n: number) {
  return Math.min(8, Math.max(1, n));
}

function zoomBy(factor: number) {
  const nextScale = clampScale(scale.value * factor);
  if (nextScale === 1) {
    resetView();
    return;
  }
  scale.value = nextScale;
}

let lastPlateWheel = 0;
const PLATE_GAP = 280;

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  const dx = ev.deltaX;
  const dy = ev.deltaY;
  // A sideways flick at 1:1 is a plate turn, same as a swipe: left (dx < 0)
  // goes on. Do not treat it as a zoom. One flick, one plate — inertia
  // used to skip half the set.
  if (scale.value === 1 && Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= 4) {
    const at = ev.timeStamp || Date.now();
    if (at - lastPlateWheel < PLATE_GAP) {
      lastPlateWheel = at;
      return;
    }
    lastPlateWheel = at;
    if (dx < 0) next();
    else prev();
    return;
  }
  if (scale.value > 1) {
    if (ev.ctrlKey || ev.metaKey) {
      zoomBy(dy < 0 ? 1.12 : 1 / 1.12);
    } else {
      tx.value -= dx;
      ty.value -= dy;
    }
    return;
  }
  zoomBy(dy < 0 ? 1.12 : 1 / 1.12);
}

function onDblClick() {
  if (scale.value > 1) resetView();
  else scale.value = 2.4;
}

let last: { x: number; y: number } | null = null;
let origin: { x: number; y: number } | null = null;
let moved = 0;
let pinch0 = 0;
let swallowClick = false;

function onPointerDown(ev: PointerEvent) {
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  last = { x: ev.clientX, y: ev.clientY };
  origin = { x: ev.clientX, y: ev.clientY };
  moved = 0;
  swallowClick = false;
  if (scale.value > 1) dragging.value = true;
}

function onPointerMove(ev: PointerEvent) {
  if (!last) return;
  const dx = ev.clientX - last.x;
  const dy = ev.clientY - last.y;
  last = { x: ev.clientX, y: ev.clientY };
  moved += Math.abs(dx) + Math.abs(dy);
  if (scale.value > 1) {
    tx.value += dx;
    ty.value += dy;
  }
}

function onPointerUp(ev: PointerEvent) {
  dragging.value = false;
  const start = origin;
  last = null;
  origin = null;
  if (moved > 6) swallowClick = true;
  if (scale.value === 1 && start && moved > 64) {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (Math.abs(dx) > Math.abs(dy) * 1.1) {
      if (dx < 0) next();
      else prev();
    }
  }
}

function onStageClick(ev: MouseEvent) {
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  if ((ev.target as Element | null)?.closest?.(".iv-img")) return;
  emit("close");
}

function onTouchStart(ev: TouchEvent) {
  if (ev.touches.length === 2) {
    const [a, b] = [ev.touches[0], ev.touches[1]];
    pinch0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
}

function onTouchMove(ev: TouchEvent) {
  if (ev.touches.length !== 2 || !(pinch0 > 0)) return;
  ev.preventDefault();
  const [a, b] = [ev.touches[0], ev.touches[1]];
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  zoomBy(dist / pinch0);
  pinch0 = dist;
}

function onTouchEnd() {
  if (pinch0 > 0) swallowClick = true;
  pinch0 = 0;
}

// Capture-phase so the viewer wins over App.vue's reader shortcuts (← / →
// flip articles, Escape closes the reader overlay) while it is open.
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" || e.key === " ") emit("close");
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const side = e.key === "ArrowLeft" ? "left" : "right";
    if (pageDirFromSide(side, ui.readerOrientation) === 1) next();
    else prev();
  } else if (e.key === "j" || e.key === "J" || e.key === "PageDown") {
    next();
  } else if (e.key === "k" || e.key === "K" || e.key === "PageUp") {
    prev();
  }
  else if (e.key === "Home") i.value = 0;
  else if (e.key === "End") i.value = Math.max(0, props.srcs.length - 1);
  else if (e.key === "+" || e.key === "=") zoomBy(1.2);
  else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2);
  else if (e.key === "0") resetView();
  else return;
  e.preventDefault();
  e.stopPropagation();
}
onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  void nextTick(() => {
    root.value?.querySelector<HTMLElement>(".iv-close")?.focus();
  });
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}));

// A vertical (古籍) page puts the next column on the left; the CSS file is
// not ours to edit, so the sides swap here.
const prevStyle = computed(() =>
  vertical.value ? { left: "auto", right: "16px" } : undefined,
);
const nextStyle = computed(() =>
  vertical.value ? { left: "16px", right: "auto" } : undefined,
);
</script>

<template>
  <div
    ref="root"
    class="image-viewer"
    :class="{ 'iv-vert': vertical }"
    role="dialog"
    aria-modal="true"
    :aria-label="caption || t('reader.viewerTitle')"
    @click="onStageClick"
  >
    <button
      class="iv-btn iv-close"
      :aria-label="t('reader.viewerClose')"
      :title="t('reader.viewerClose')"
      @click.stop="emit('close')"
    >
      <Icon name="x" :size="18" />
    </button>

    <button
      v-if="many"
      class="iv-btn iv-prev"
      :style="prevStyle"
      :aria-label="t('reader.viewerPrev')"
      @click.stop="prev()"
    >
      <Icon name="chevron-right" :size="22" />
    </button>

    <div
      class="iv-stage"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick.prevent="onDblClick"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
    >
      <img
        class="iv-img"
        :class="{ 'is-zoomed': scale > 1, 'is-dragging': dragging }"
        :src="srcs[i]"
        :alt="caption"
        :style="imgStyle"
        draggable="false"
        @click.stop
      />
    </div>

    <button
      v-if="many"
      class="iv-btn iv-next"
      :style="nextStyle"
      :aria-label="t('reader.viewerNext')"
      @click.stop="next()"
    >
      <Icon name="chevron-right" :size="22" />
    </button>

    <div v-if="many || caption" class="iv-meta" @click.stop>
      <span v-if="caption" class="iv-caption">{{ caption }}</span>
      <span v-if="many" class="iv-counter">{{ i + 1 }} / {{ srcs.length }}</span>
    </div>
  </div>
</template>
