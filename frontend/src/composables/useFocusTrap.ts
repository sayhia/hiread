// Contain keyboard focus within a modal dialog while it is open, so Tab can't
// walk into the (visually obscured) background behind it.

import { onScopeDispose, unref, watch, type Ref } from "vue";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

/**
 * True when `el` can actually receive focus right now. The `FOCUSABLE`
 * selector matches by tag/attribute alone, so it also picks up elements that
 * are not visible — e.g. a `display:none` hidden file `<input>`. `.focus()` on
 * such an element is a silent no-op, so if it were treated as the trap's
 * first/last item the Tab/Shift+Tab wrap-around would land focus nowhere.
 * `getClientRects()` is empty for any element rendered with `display:none`
 * (and for one inside a collapsed ancestor), which reliably excludes them.
 */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/**
 * Trap Tab / Shift+Tab inside `elRef`'s subtree while active.
 *
 * `enabled` lets a component that stays mounted but toggles its modal on and
 * off re-arm the trap: the watcher re-runs when it flips, by which point
 * `elRef` points at the now-rendered node.
 */
export function useFocusTrap(
  elRef: Ref<HTMLElement | null | undefined>,
  enabled: Ref<boolean> | boolean = true,
  opts?: { autoFocus?: boolean },
): void {
  let attachedEl: HTMLElement | null = null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !attachedEl) return;
    // Only visible elements can take focus — a hidden match (a `display:none`
    // file input) as first/last would break the wrap-around.
    const items = Array.from(
      attachedEl.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter(isVisible);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const detach = () => {
    if (attachedEl) {
      attachedEl.removeEventListener("keydown", onKey);
      attachedEl = null;
    }
  };

  // Re-evaluate whenever the trapped element or the enabled flag changes.
  // `flush: "post"` ensures the template ref is populated after the DOM
  // patch, matching React's effect timing.
  watch(
    () => [elRef.value, unref(enabled)] as const,
    ([el, on]) => {
      detach();
      if (on && el) {
        attachedEl = el;
        el.addEventListener("keydown", onKey);
        // Create-mode highlight popover must not steal the page selection
        // (⌘C would copy an empty note). Tab still wraps once focus is inside.
        if (opts?.autoFocus !== false && !el.contains(document.activeElement)) {
          Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).find(isVisible)?.focus();
        }
      }
    },
    { immediate: true, flush: "post" },
  );

  onScopeDispose(detach);
}
