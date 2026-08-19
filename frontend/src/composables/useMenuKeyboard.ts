// Keyboard support for floating `role="menu"` popovers, shared by every menu in
// the app (`ContextMenu`, export/send menus). Without it, opening a menu with
// the keyboard left focus nowhere, arrow keys did nothing, and closing dropped
// focus to `<body>`. The composable:
//   - moves focus to the first enabled `[role="menuitem"]` on open,
//   - restores focus to the trigger element on close,
//   - returns an `onKeyDown` handler for Arrow / Home / End navigation
//     (Enter / Space activation is left to the items' native <button>).
//
// Takes a Vue template ref to the menu root.

import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";

/**
 * @param elRef the menu container template ref.
 * @param ready when false the menu items have not rendered yet (e.g. an async
 *              load is pending) — focus is moved in only once it flips true.
 *              Pass a ref/getter; defaults to always-ready.
 */
export function useMenuKeyboard(
  elRef: Ref<HTMLElement | null | undefined>,
  ready: Ref<boolean> | (() => boolean) = () => true,
) {
  let trigger: HTMLElement | null = null;
  const isReady = () => (typeof ready === "function" ? ready() : ready.value);

  const focusFirst = () => {
    const items = elRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const first = Array.from(items ?? []).find(
      (el) => !(el as HTMLButtonElement).disabled,
    );
    (first ?? items?.[0])?.focus();
  };

  onMounted(() => {
    // Capture the trigger so focus can be restored to it on close.
    trigger = document.activeElement as HTMLElement | null;
    if (isReady()) focusFirst();
  });

  // Focus the first enabled item once the items render (async-loaded menus).
  if (typeof ready !== "function") {
    watch(ready, (r) => {
      if (r) focusFirst();
    });
  }

  // Restore focus to the trigger element when the menu unmounts.
  onBeforeUnmount(() => trigger?.focus?.());

  /** Arrow / Home / End / Enter navigation. A swatch row (.ctx-swatches)
   *  collapses to a single vertical stop you move within with Left / Right —
   *  otherwise Up/Down would step sideways through the whole colour palette. */
  const onKeyDown = (e: KeyboardEvent) => {
    const root = elRef.value;
    if (!root) return;
    const all = Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
    if (all.length === 0) return;

    // Group consecutive swatches sharing a .ctx-swatches parent into one row.
    type Row = { focus: HTMLElement; swatches?: HTMLElement[] };
    const rows: Row[] = [];
    for (let i = 0; i < all.length; i++) {
      const grp = all[i].closest(".ctx-swatches");
      if (grp) {
        const members: HTMLElement[] = [];
        while (i < all.length && all[i].closest(".ctx-swatches") === grp) members.push(all[i++]);
        i--;
        rows.push({ focus: members.find((s) => s.classList.contains("on")) ?? members[0], swatches: members });
      } else {
        rows.push({ focus: all[i] });
      }
    }

    const active = document.activeElement as HTMLElement | null;
    const rowIdx = rows.findIndex(
      (r) => r.focus === active || (active != null && !!r.swatches?.includes(active)),
    );
    const focusRow = (i: number) => {
      e.preventDefault();
      rows[(i + rows.length) % rows.length].focus.focus();
    };
    switch (e.key) {
      case "ArrowDown": focusRow(rowIdx + 1); break;
      case "ArrowUp": focusRow(rowIdx < 0 ? -1 : rowIdx - 1); break;
      case "Home": focusRow(0); break;
      case "End": focusRow(rows.length - 1); break;
      case "ArrowRight":
      case "ArrowLeft": {
        const sw = rows[rowIdx]?.swatches;
        if (sw && active) {
          const i = sw.indexOf(active);
          if (i >= 0) {
            e.preventDefault();
            const d = e.key === "ArrowRight" ? 1 : -1;
            sw[(i + d + sw.length) % sw.length].focus();
          }
        }
        break;
      }
      case "Enter":
      case " ": {
        // The menu items are real <button>s, which already fire `click` on
        // Enter/Space natively. Synthesising another `click()` here would run
        // the action twice. Only forward the key to a non-natively-activatable
        // element.
        const el = document.activeElement as HTMLElement | null;
        if (el && el.tagName !== "BUTTON" && el.tagName !== "A") {
          e.preventDefault();
          el.click();
        }
        break;
      }
    }
  };

  return onKeyDown;
}
