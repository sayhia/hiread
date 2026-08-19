<script setup lang="ts">
// A single-field modal prompt — feed / folder rename, new folder, export-to.

import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useFocusTrap } from "../composables/useFocusTrap";

const props = withDefaults(
  defineProps<{
    title: string;
    label?: string;
    placeholder?: string;
    initial?: string;
    confirmLabel?: string;
  }>(),
  {
    initial: "",
  },
);

const emit = defineEmits<{
  (e: "submit", value: string): void;
  (e: "cancel"): void;
}>();

const { t } = useI18n();

const value = ref(props.initial);
const dialogRef = ref<HTMLElement>();
const inputRef = ref<HTMLInputElement>();
useFocusTrap(dialogRef);

// Escape must close the dialog regardless of which control has focus —
// an input-level handler dies as soon as the user tabs to a button.
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("cancel");
  }
};

let trigger: HTMLElement | null = null;

onMounted(() => {
  trigger = document.activeElement as HTMLElement | null;
  inputRef.value?.focus();
  // For a rename (the field opens pre-filled), select the text so the user
  // can type a replacement immediately — standard rename UX.
  if (props.initial) inputRef.value?.select();
  window.addEventListener("keydown", onKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  trigger?.focus?.();
});

const submit = () => {
  const v = value.value.trim();
  if (!v) return;
  emit("submit", v);
};

const onEnter = (e: KeyboardEvent) => {
  // Ignore the Enter that confirms an IME candidate (CJK input) — otherwise
  // it submits the dialog with a half-composed name.
  if (e.isComposing) return;
  submit();
};
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop prompt-dialog" @click="emit('cancel')">
      <div
        class="modal"
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        @click.stop
      >
        <h2 id="prompt-dialog-title">{{ title }}</h2>
        <input
          class="modal-input"
          ref="inputRef"
          v-model="value"
          :placeholder="placeholder"
          :aria-label="label ?? placeholder ?? title"
          :style="{ marginTop: '8px' }"
          @keydown.enter="onEnter"
        />
        <div class="modal-actions">
          <button class="s-btn" @click="emit('cancel')">
            {{ t("common.cancel") }}
          </button>
          <button
            class="s-btn primary"
            :disabled="!value.trim()"
            @click="submit"
          >
            {{ confirmLabel ?? t("common.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
