<script setup lang="ts">
// A segmented button group — a horizontal set of mutually-exclusive options.
// Plain `string` value (callers cast the emitted value to a narrower type),
// matching SettingsSelect.

defineProps<{
  value: string;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{
  (e: "change", value: string): void;
}>();
</script>

<template>
  <div class="s-seg" role="group" :aria-label="ariaLabel">
    <button
      v-for="o in options"
      :key="o.value"
      :class="{ on: value === o.value }"
      :aria-pressed="value === o.value"
      @click="emit('change', o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
