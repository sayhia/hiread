<script setup lang="ts">
// A message-only confirmation modal — the themed replacement for the native
// `window.confirm` on destructive actions. Mirrors PromptDialog's chrome.
//
// Cancel takes initial focus on purpose: an absent-minded Enter then backs out
// of the action rather than carrying out the irreversible one.

import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useFocusTrap } from "../composables/useFocusTrap";

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    confirmLabel: string;
    /** Style the confirm button as destructive. On by default — this dialog
     *  exists for destructive confirmations. */
    danger?: boolean;
  }>(),
  {
    danger: true,
  },
);

const emit = defineEmits<{
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

const { t } = useI18n();

const dialogRef = ref<HTMLElement>();
useFocusTrap(dialogRef);

// Cancel button gets initial focus.
const cancelRef = ref<HTMLButtonElement>();
let trigger: HTMLElement | null = null;

// Escape must close regardless of which control holds focus.
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("cancel");
  }
};

onMounted(() => {
  trigger = document.activeElement as HTMLElement | null;
  cancelRef.value?.focus();
  window.addEventListener("keydown", onKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  trigger?.focus?.();
});

const confirm = () => {
  emit("confirm");
};
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click="emit('cancel')">
      <div
        class="modal"
        ref="dialogRef"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        @click.stop
      >
        <h2 id="confirm-dialog-title">{{ title }}</h2>
        <p id="confirm-dialog-message" class="modal-hint">
          {{ message }}
        </p>
        <div class="modal-actions">
          <button class="s-btn" ref="cancelRef" @click="emit('cancel')">
            {{ t("common.cancel") }}
          </button>
          <button
            class="s-btn primary"
            :class="{ danger }"
            @click="confirm"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
