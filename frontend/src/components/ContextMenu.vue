<script setup lang="ts">
// Floating context menu, clamped inside the viewport — design `.ctx-menu`.

import { onMounted, ref } from "vue";
import Icon, { type IconName } from "./Icon.vue";
import { clampToViewport } from "../lib/viewport";
import { useDismiss } from "../composables/useDismiss";
import { useMenuKeyboard } from "../composables/useMenuKeyboard";

export type MenuEntry =
  | {
      icon?: IconName;
      label: string;
      shortcut?: string;
      danger?: boolean;
      onClick: () => void;
    }
  | { separator: true }
  | {
      /** A row of colour swatches — for picking a tag colour. */
      swatches: { value: string; color: string }[];
      current: string;
      onPick: (value: string) => void;
    };

const props = defineProps<{
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}>();

const ref_ = ref<HTMLDivElement>();
const pos = ref({ left: props.x, top: props.y });
// Hidden until the post-mount clamp runs, so the menu never flashes one frame at
// the raw cursor position before snapping inside the viewport (right/bottom edge).
const ready = ref(false);

// The menu is anchored at the mouse cursor, so it can open anywhere. The shared
// clamp pulls it back from the right/bottom edges and floors it at the 8px
// margin, so a menu taller/wider than the window stays reachable. Measured
// after mount, once the element has a real rect.
onMounted(() => {
  const el = ref_.value;
  if (el) {
    const r = el.getBoundingClientRect();
    pos.value = clampToViewport({
      x: props.x,
      y: props.y,
      width: r.width,
      height: r.height,
      margin: 8,
    });
  }
  ready.value = true;
});

useDismiss(ref_, () => props.onClose());

// Focus management on open/close plus Arrow/Home/End/Enter navigation, shared
// with the other role="menu" popovers.
const onKeyDown = useMenuKeyboard(ref_);

// Type guards for `"separator" in it` / `"swatches" in it`.
type SeparatorEntry = Extract<MenuEntry, { separator: true }>;
type SwatchEntry = Extract<MenuEntry, { swatches: unknown }>;
type ItemEntry = Extract<MenuEntry, { label: string }>;
const isSeparator = (it: MenuEntry): it is SeparatorEntry => "separator" in it;
const isSwatches = (it: MenuEntry): it is SwatchEntry => "swatches" in it;
</script>

<template>
  <Teleport to="body">
  <div
    class="ctx-menu"
    ref="ref_"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px', visibility: ready ? undefined : 'hidden' }"
    @click.stop
    @keydown="onKeyDown"
  >
    <template v-for="(it, i) in items" :key="i">
      <div v-if="isSeparator(it)" class="ctx-sep" role="separator" />

      <div v-else-if="isSwatches(it)" class="ctx-swatches">
        <button
          v-for="sw in (it as SwatchEntry).swatches"
          :key="sw.value"
          :class="['ctx-swatch', sw.value === (it as SwatchEntry).current ? 'on' : '']"
          role="menuitem"
          :tabindex="-1"
          :style="{ background: sw.color }"
          :aria-label="sw.value"
          :aria-pressed="sw.value === (it as SwatchEntry).current"
          @click="(it as SwatchEntry).onPick(sw.value); onClose()"
        />
      </div>

      <div
        v-else
        class="ctx-item"
        role="menuitem"
        :tabindex="-1"
        :style="(it as ItemEntry).danger ? { color: 'oklch(0.55 0.17 28)' } : undefined"
        @click="(it as ItemEntry).onClick(); onClose()"
      >
        <span class="ctx-ico">
          <Icon v-if="(it as ItemEntry).icon" :name="(it as ItemEntry).icon!" :size="13" />
        </span>
        {{ (it as ItemEntry).label }}
        <span v-if="(it as ItemEntry).shortcut" class="ctx-shortcut">{{ (it as ItemEntry).shortcut }}</span>
      </div>
    </template>
  </div>
  </Teleport>
</template>
