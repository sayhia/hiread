// Global toast notifications (Pinia). A single transient pill at the bottom of
// the window; any module can raise one via the `toast` helper without threading
// callbacks through props.

import { defineStore } from "pinia";
import { ref } from "vue";
import i18n from "../i18n";
import { errorText } from "../lib/errors";

export type ToastTone = "default" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  kbd?: string;
  tone: ToastTone;
  action?: ToastAction;
  duration: number;
}

let seq = 0;

export const useToasts = defineStore("toasts", () => {
  const current = ref<ToastItem | null>(null);
  // One waiting pill. An action toast (Undo) owns the visible slot until it
  // commits or is dismissed; toast.show / reportError wait here instead of
  // replacing the Undo button. A later waiting toast overwrites this one.
  let pending: ToastItem | null = null;

  function push(t: Omit<ToastItem, "id">): number {
    const id = ++seq;
    const item: ToastItem = { ...t, id };
    // A toast that still has `action` keeps the slot. Info/error toasts queue;
    // a new action toast (another Undo) takes over, matching one visible pill.
    if (current.value?.action && !item.action) {
      pending = item;
      return id;
    }
    current.value = item;
    return id;
  }
  function dismiss(id?: number) {
    if (id !== undefined && pending?.id === id && current.value?.id !== id) {
      pending = null;
      return;
    }
    const cur = current.value;
    if (cur && (id === undefined || cur.id === id)) {
      current.value = pending;
      pending = null;
    }
  }
  return { current, push, dismiss };
});

const SUCCESS_MS = 1900;
const ERROR_MS = 7000;
const UNDO_MS = 6000;

export const toast = {
  show: (text: string, kbd?: string) =>
    useToasts().push({ text, kbd, tone: "default", duration: SUCCESS_MS }),
  error: (text: string) => useToasts().push({ text, tone: "error", duration: ERROR_MS }),
};

/** Raise an error toast from any caught exception. */
export function reportError(e: unknown): void {
  toast.error(errorText(e));
}

/** Run a destructive action behind a grace period, with an Undo toast. */
export function withUndo(opts: {
  text: string;
  apply: () => void;
  commit: () => void;
  revert: () => void;
}): void {
  opts.apply();
  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    opts.commit();
  }, UNDO_MS);
  useToasts().push({
    text: opts.text,
    tone: "default",
    duration: UNDO_MS,
    action: {
      label: i18n.global.t("common.undo"),
      run: () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        opts.revert();
      },
    },
  });
}
