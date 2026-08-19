<script setup lang="ts">
// A checkbox styled as an iOS-style switch.

defineProps<{
  checked: boolean;
  ariaLabel?: string;
}>();

const emit = defineEmits<{
  (e: "change", value: boolean): void;
}>();
</script>

<template>
  <input
    type="checkbox"
    class="s-toggle"
    :checked="checked"
    :aria-label="ariaLabel"
    @change="emit('change', ($event.target as HTMLInputElement).checked)"
  />
</template>
