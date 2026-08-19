<script setup lang="ts">
// A thin draggable separator between two panes. Native pointer events (no
// third-party resize library) to stay lightweight and match the project's
// hand-rolled interaction code.
//
// The drag tracks the pointer's start X and the pane's start width, so a slow
// first frame can't desync the handle from the cursor. Window-level
// pointermove/up listeners cover the whole gesture even when the cursor
// outruns the 7px hit area, and the body `col-resize` cursor + no-select
// guard make the gesture feel native.
//
// Deliberately NO setPointerCapture: the handle's slot tracks the live
// --col-* variable, so the element moves every frame during the drag, and
// macOS WebKit releases pointer capture when the captured element changes
// position — which dropped the drag mid-gesture. The window listeners make
// capture redundant anyway.

import { onBeforeUnmount } from "vue";

const props = defineProps<{
  /** Pixel width of the pane this handle resizes, at drag start. */
  width: number;
  /** `right`: dragging right grows the pane (sidebar, handle on its right
   *  edge). `left`: dragging left grows the pane (the AI drawer, handle on its
   *  left edge). */
  side: "left" | "right";
  /** Lower / upper clamp for the resulting width (px). */
  min: number;
  max: number;
  /** Accessible label for the separator. */
  label: string;
}>();

const emit = defineEmits<{ (e: "resize", width: number): void }>();

const clampW = (n: number) => Math.min(props.max, Math.max(props.min, n));

function onPointerDown(e: PointerEvent): void {
  // Ignore secondary buttons so a right-click context menu can't start a drag.
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = props.width;

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const move = (ev: PointerEvent): void => {
    const dx = ev.clientX - startX;
    // `right` panes grow as the cursor moves right; `left` panes grow as it
    // moves left.
    const raw = props.side === "right" ? startW + dx : startW - dx;
    emit("resize", clampW(raw));
  };
  const up = (): void => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Keyboard a11y: arrow keys nudge the boundary (16px, or 48px with Shift).
function onKeyDown(e: KeyboardEvent): void {
  const step = e.shiftKey ? 48 : 16;
  let delta = 0;
  if (e.key === "ArrowLeft") delta = props.side === "right" ? -step : step;
  else if (e.key === "ArrowRight") delta = props.side === "right" ? step : -step;
  else return;
  e.preventDefault();
  emit("resize", clampW(props.width + delta));
}

// Belt-and-braces: if this handle unmounts mid-drag (focus mode hides the
// panes), clear the global cursor / select overrides.
onBeforeUnmount(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});
</script>

<template>
  <div
    class="resize-handle"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :tabindex="0"
    @pointerdown="onPointerDown"
    @keydown="onKeyDown"
  />
</template>
