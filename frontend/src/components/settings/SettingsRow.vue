<script setup lang="ts">
// A labelled settings row: a left-hand label (+ optional description) and a
// right-hand control.
//
// The row's control is named with the row label so screen readers announce
// more than a bare "checkbox" / "slider" / "combobox". Vue can't clone a
// child to inject a prop, so the label is exposed to the default slot as a
// slot prop; each control component accepts an `ariaLabel` prop the row
// binds to it.

defineProps<{
  label: string;
  desc?: string;
}>();
</script>

<template>
  <div class="settings-row">
    <div class="settings-row-text">
      <div class="settings-row-label">{{ label }}</div>
      <div v-if="desc" class="settings-row-desc">{{ desc }}</div>
    </div>
    <div class="settings-row-control">
      <!-- Expose the row label to the control slot as `ariaLabel` (camelCase —
           Vue does not transform slot prop names, so `v-slot="{ ariaLabel }"`
           must match this key exactly). -->
      <slot :ariaLabel="label" />
    </div>
  </div>
</template>
