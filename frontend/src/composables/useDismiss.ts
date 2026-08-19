// Outside-click / Escape dismissal for floating popovers (context menus,
// pickers, share menus). Every popover reimplemented the same logic: a
// `mousedown` listener that closes on a click outside `el`, an Escape
// `keydown` listener, and a `setTimeout(0)` so the very click/keypress that
// opened the popover does not immediately close it. Centralised here.
//
// Takes a Vue template ref to the popover root.

import { onBeforeUnmount, onMounted, type Ref } from "vue";

interface Options {
  /** Also dismiss when focus leaves the popover subtree (Tab past the last
   *  control). A null relatedTarget is ignored — left to the click/Escape
   *  paths — since focus falling to <body> is not a deliberate move out. */
  onFocusOut?: boolean;
  /** The opening control sits outside the popover. Clicks on it must not
   *  count as an outside dismiss, or the same click re-toggles it open. */
  ignore?: (e: Event) => boolean;
  /** When false, the listener stays attached but does not dismiss. Needed
   *  when the ref is a wrapper that stays mounted while the menu is closed. */
  enabled?: boolean | (() => boolean);
}

/** Dismiss `elRef`'s popover on an outside click, Escape, or (optionally) a
 *  Tab out of its subtree. */
export function useDismiss(
  elRef: Ref<HTMLElement | null | undefined>,
  onClose: () => void,
  { onFocusOut = false, ignore, enabled }: Options = {},
) {
  const isOn = () => {
    if (enabled === undefined) return true;
    return typeof enabled === "function" ? enabled() : enabled;
  };
  let tm = 0;
  const onDown = (e: MouseEvent) => {
    if (!isOn()) return;
    if (ignore?.(e)) return;
    if (!elRef.value?.contains(e.target as Node)) onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Closed popovers still have a live listener (the opener stays mounted).
    // Swallowing Esc then would steal it from a real layer (summary, reader).
    if (!isOn() || !elRef.value) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    onClose();
  };
  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && !elRef.value?.contains(next)) onClose();
  };

  onMounted(() => {
    // Defer subscription a tick so the opening click/keypress doesn't dismiss.
    tm = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      // Capture so a reader / AI Esc handler behind the popover does not
      // also fire (bubble-phase stopPropagation never reaches those).
      window.addEventListener("keydown", onKey, true);
      if (onFocusOut) document.addEventListener("focusout", onBlur);
    }, 0);
  });

  onBeforeUnmount(() => {
    window.clearTimeout(tm);
    document.removeEventListener("mousedown", onDown);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusout", onBlur);
  });
}
