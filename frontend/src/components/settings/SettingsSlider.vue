<script setup lang="ts">
// A range slider with a live numeric readout.
//
// Two callbacks with different costs:
//   • `change` fires on every drag tick — for cheap, live updates (reader
//     preview).
//   • `commit` fires once the drag / keypress settles — for costly side
//     effects (a backend write, an HTTP-client rebuild) that must not run ~20×
//     across a single drag.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    value: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    ariaLabel?: string;
  }>(),
  {
    step: 1,
    unit: "",
  },
);

const emit = defineEmits<{
  (e: "change", value: number): void;
  (e: "commit", value: number): void;
}>();

const { t } = useI18n();
const name = computed(() => props.ariaLabel || "");
const atMin = computed(() => draft.value <= props.min);
const atMax = computed(() => draft.value >= props.max);

function nudge(dir: -1 | 1) {
  const next = Math.min(props.max, Math.max(props.min, draft.value + dir * (props.step || 1)));
  if (next === draft.value) return;
  draft.value = next;
  emit("change", next);
  emit("commit", next);
}

// The keys that actually move an `<input type="range">`. `keyup` fires for
// every key release while the slider is focused — Tab (which merely lands or
// leaves focus), Shift, the modifier keys — so committing on a bare keyup would
// run `commit` for a key that never changed the value. For the network-timeout
// slider that side effect is a full HTTP-client rebuild, so a user simply
// Tab-navigating through Settings would trigger one. Restrict the commit to
// releases of a value-changing key.
const SLIDER_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
]);

const draft = ref(props.value);
// Follow external changes (async settings load, reset) when not mid-drag.
watch(
  () => props.value,
  (v) => {
    draft.value = v;
  },
);

function onInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  draft.value = v;
  emit("change", v);
}
function onPointerUp(e: PointerEvent): void {
  emit("commit", Number((e.target as HTMLInputElement).value));
}
function onKeyUp(e: KeyboardEvent): void {
  if (SLIDER_KEYS.has(e.key)) {
    emit("commit", Number((e.target as HTMLInputElement).value));
  }
}
</script>

<template>
  <button
    type="button"
    class="rs-step"
    :disabled="atMin"
    :aria-label="t('reading.stepDown', { name })"
    @click="nudge(-1)"
  >−</button>
  <input
    type="range"
    class="s-slider"
    :min="min"
    :max="max"
    :step="step"
    :value="draft"
    :aria-label="ariaLabel"
    :aria-valuetext="`${draft}${unit}`"
    @input="onInput"
    @pointerup="onPointerUp"
    @keyup="onKeyUp"
  />
  <button
    type="button"
    class="rs-step"
    :disabled="atMax"
    :aria-label="t('reading.stepUp', { name })"
    @click="nudge(1)"
  >+</button>
  <span class="s-value">{{ draft }}{{ unit }}</span>
</template>
