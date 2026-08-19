<script setup lang="ts">
// One reading setting, drawn.
//
// The panel over a book and the page in Settings were two hand-written forms
// over the same seventeen settings, in two different control languages: the
// panel stacked boxed segments, the page floated sliders and dropdowns against
// the right edge. Same setting, two shapes, and every new setting had to be
// drawn twice.
//
// A setting knows what kind of thing it is, so it can draw itself. What it
// does not know is how much room it has — which is the real difference between
// the two surfaces, and the only thing `mode` says: `compact` offers the named
// positions a reader picks from over a page, `full` offers the continuous
// value behind them.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useUi } from "../../../stores/ui";
import {
  BOUNDS,
  type ReadingSettingKey,
  type Setting,
} from "../../../lib/reading/schema";
import { READER_INKS, READER_PAPERS, READER_TEXTURES, linkedPadY, nearestStep } from "../../../lib/readerSettings";
import { resolveReaderFont, SYSTEM_FONTS } from "../../../lib/fonts";
import Icon from "../../Icon.vue";

const props = defineProps<{
  setting: Setting;
  /** How much room there is: a popover over a page, or a settings page. */
  mode: "compact" | "full";
}>();

const { t, te } = useI18n();
const ui = useUi();

const key = computed(() => props.setting.key as ReadingSettingKey);
const value = computed(() => ui.readingValue(key.value));
const label = computed(() => {
  if (props.mode === "compact" && key.value === "readerPadX") {
    const k = "reading.readerPadXCompact";
    return te(k) ? t(k) : t("reading.readerPadX");
  }
  return t(`reading.${key.value}`);
});
/** Not every setting needs explaining, and asking for a key that is not there
 *  gets the key path back — or, under a fallback locale, the English text in a
 *  Chinese panel. Ask whether it exists. */
const hint = computed(() => {
  const k = `reading.${key.value}Desc`;
  return te(k) ? t(k) : "";
});

const options = computed<readonly string[]>(() =>
  props.setting.kind === "enum" ? props.setting.options : [],
);
const bounds = computed(() => BOUNDS[key.value] ?? { min: 0, max: 100 });

/** The swatch row a setting draws. Paper and ink both show themselves; a row
 *  that has no swatches is rendered as plain options instead. */
const swatches = computed(() =>
  key.value === "readerPaper"
    ? READER_PAPERS
    : key.value === "readerInk"
      ? READER_INKS
      : key.value === "readerTexture"
        ? READER_TEXTURES
        : [],
);
/** The pick-a-colour swatch a swatch row ends with, when it has one. */
const customColour = computed(() => {
  if (key.value === "readerPaper") {
    return { value: ui.readerPaperCustom, set: ui.setReaderPaperCustom };
  }
  if (key.value === "readerInk") {
    return { value: ui.readerInkCustom, set: ui.setReaderInkCustom };
  }
  return null;
});

/** One control per kind of setting. Numbers are always a slider — the named
 *  step buttons a compact panel once offered made the value it actually kept
 *  invisible, and the slider shows it. */
const shape = computed(() => {
  const s = props.setting;
  if (s.kind === "boolean") return "switch";
  // Colours are shown as themselves; every other choice is named, because a
  // swatch of a word is just a word in a box.
  if (s.kind === "enum") return s.display === "swatches" ? "swatches" : "options";
  if (s.kind === "colour") return "colour";
  if (s.kind === "font") return "faces";
  // A handful of small named steps is a row of buttons, not a track:
  // columns, indent, and the reminder are choices, not a continuum.
  if (
    props.mode === "compact" &&
    s.kind === "number" &&
    s.steps &&
    (s.key === "readerIndent" || s.key === "readerColumns" || s.key === "readerRemindAfter")
  ) {
    return "steps";
  }
  return "slider";
});

function set(v: number | boolean | string) {
  ui.setReading(key.value, v);
  // "Margin" is one thing over a page: the vertical follows the horizontal at
  // the ratio the default sheet has, so one press still looks deliberate.
  if (key.value === "readerPadX" && props.mode === "compact") {
    ui.setReading("readerPadY", linkedPadY(Number(v)));
  }
  // Book typeset is an indent; modern/web are flush. The CSS 2em fallback
  // never runs now that --reader-indent is always stamped, including 0em.
  if (key.value === "readerTypeset" && v !== value.value) {
    ui.setReading("readerIndent", v === "book" ? 2 : 0);
  }
}

function nudge(by: number) {
  const s = props.setting;
  if (s.kind !== "number") return;
  set(Math.min(s.max, Math.max(s.min, Number(value.value) + by)));
}

function resetThis() {
  set(props.setting.default);
}

function onSliderWheel(e: WheelEvent) {
  if (document.activeElement !== e.target) return;
  e.preventDefault();
  nudge(e.deltaY > 0 ? -1 : 1);
}

/** The faces the reader can take, grouped by source exactly as the settings
 *  font picker groups them — bundled / system / downloaded — so the two menus
 *  agree about what a font is. A face is shown in itself, which is the point
 *  of choosing one. */
const faces = computed(() => {
  const bundled = ["serif", "sans", "hyperlegible"].map((v) => ({
    value: v,
    label: t(`reader.type.${v === "hyperlegible" ? "hyperlegible" : v}`),
  }));
  const system = SYSTEM_FONTS.map((f) => ({ value: `system:${f}`, label: f }));
  const downloaded = ui.installedFonts
    .filter((f) => f.axis === "reader" || f.axis === "both")
    .map((f) => ({ value: `downloaded:${f.id}`, label: f.label }));
  return { bundled, system, downloaded };
});
const stackOf = (choice: string) => resolveReaderFont(choice, ui.installedFonts).stack;

/** Named step closest to the current number — shown as the slider's title
 *  so a compact row can still say "airy" without hiding the pixels. */
const stepTitle = computed(() => {
  const s = props.setting;
  if (s.kind !== "number" || !s.steps?.length) return "";
  const v = Number(value.value);
  let best = s.steps[0];
  for (const st of s.steps) {
    if (Math.abs(st.value - v) < Math.abs(best.value - v)) best = st;
  }
  const k = `reading.step.${best.key}`;
  return te(k) ? t(k) : "";
});

/** Where the reader is on a slider, for the value shown beside it. */
const unit = computed(() => {
  switch (key.value) {
    case "readerSize":
    case "readerWidth":
    case "readerPadX":
    case "readerPadY":
    case "readerLeading":
    case "readerParaGap":
    case "readerTracking":
      return "px";
    case "readerIndent":
      return "em";
    case "readerWarmth":
      return "%";
    case "readerAutoSpeed":
      return "px/s";
    case "readerRemindAfter":
      return Number(value.value) === 0 ? "" : "m";
    default:
      return "";
  }
});

const displayValue = computed(() => {
  if (key.value === "readerRemindAfter" && Number(value.value) === 0) {
    return te("reading.step.never") ? t("reading.step.never") : "0";
  }
  return `${value.value}${unit.value}`;
});

/** Every continuous slider gets ± so a value can be walked one unit at a time. */
const stepped = computed(() => shape.value === "slider");
const atMin = computed(() => {
  const s = props.setting;
  return s.kind === "number" && Number(value.value) <= s.min;
});
const atMax = computed(() => {
  const s = props.setting;
  return s.kind === "number" && Number(value.value) >= s.max;
});
</script>

<template>
  <div class="rs-row" :class="[`rs-${mode}`, `rs-is-${shape}`, { 'rs-stepped': stepped }]">
    <div class="rs-text">
      <span class="rs-label">{{ label }}</span>
      <span v-if="hint && mode === 'full'" class="rs-hint">{{ hint }}</span>
    </div>

    <div class="rs-control">
      <!-- The number behind the setting: always a slider now, so the value
           the reader actually set is the one on screen. -->
      <template v-if="shape === 'slider'">
        <button
          v-if="stepped"
          type="button"
          class="rs-step"
          :disabled="atMin"
          :aria-label="t('reading.stepDown', { name: label })"
          @click="nudge(-1)"
        >−</button>
        <input
          type="range"
          class="rs-slider"
          :min="bounds.min"
          :max="bounds.max"
          step="1"
          :value="value as number"
          :aria-label="label"
          :aria-valuetext="displayValue"
          :title="stepTitle || displayValue"
          @input="set(Number(($event.target as HTMLInputElement).value))"
          @dblclick="resetThis"
          @wheel="onSliderWheel"
        />
        <button
          v-if="stepped"
          type="button"
          class="rs-step"
          :disabled="atMax"
          :aria-label="t('reading.stepUp', { name: label })"
          @click="nudge(1)"
        >+</button>
        <span
          class="rs-value"
          :title="t('reading.reset')"
          @dblclick="resetThis"
        >{{ displayValue }}</span>
      </template>

      <input
        v-else-if="shape === 'switch'"
        type="checkbox"
        class="rs-switch"
        :checked="value as boolean"
        :aria-label="label"
        @change="set(($event.target as HTMLInputElement).checked)"
      />

      <!-- The surface's own colours, shown as themselves. -->
      <div v-else-if="shape === 'swatches'" class="rs-swatches" role="group" :aria-label="label">
        <button
          v-for="p in swatches"
          :key="p.value"
          type="button"
          class="rs-swatch"
          :class="{ on: value === p.value }"
          :data-tex="key === 'readerTexture' ? p.value : undefined"
          :style="{ background: p.swatch }"
          :title="t(`reading.${key}_${p.key}`)"
          :aria-label="t(`reading.${key}_${p.key}`)"
          :aria-pressed="value === p.value"
          @click="set(p.value)"
        >
          <Icon v-if="value === p.value" name="check" :size="11" />
        </button>
        <label
          v-if="customColour"
          class="rs-swatch rs-swatch-custom"
          :class="{ on: value === 'custom' }"
          :style="{ background: customColour.value }"
          :title="t(`reading.${key}_custom`)"
          @click="set('custom')"
        >
          <input
            type="color"
            :value="customColour.value"
            :aria-label="t(`reading.${key}_custom`)"
            @input="customColour.set(($event.target as HTMLInputElement).value)"
          />
          <Icon v-if="value === 'custom'" name="check" :size="11" />
        </label>
      </div>

      <div v-else-if="shape === 'steps' && setting.kind === 'number' && setting.steps" class="rs-seg" role="group" :aria-label="label">
        <button
          v-for="st in setting.steps"
          :key="st.value"
          type="button"
          :class="{ on: nearestStep(setting.steps, Number(value)) === st.value }"
          :aria-pressed="nearestStep(setting.steps, Number(value)) === st.value"
          @click="set(st.value)"
        >
          {{ te(`reading.step.${st.key}`) ? t(`reading.step.${st.key}`) : st.value }}
        </button>
      </div>

      <!-- A named choice. -->
      <div v-else-if="shape === 'options'" class="rs-seg" role="group" :aria-label="label">
        <button
          v-for="o in options"
          :key="o"
          type="button"
          :class="{ on: value === o }"
          :aria-pressed="value === o"
          @click="set(o)"
        >
          {{ t(`reading.${key}_${o}`) }}
        </button>
      </div>

      <!-- A face, chosen from a menu grouped like the settings font picker. -->
      <select
        v-else-if="shape === 'faces'"
        class="s-select"
        :value="value"
        :aria-label="label"
        @change="set(($event.target as HTMLSelectElement).value)"
      >
        <optgroup :label="t('reader.type.bundled')">
          <option
            v-for="f in faces.bundled"
            :key="f.value"
            :value="f.value"
            :style="{ fontFamily: stackOf(f.value) }"
          >
            {{ f.label }}
          </option>
        </optgroup>
        <optgroup :label="t('reader.type.system')">
          <option
            v-for="f in faces.system"
            :key="f.value"
            :value="f.value"
            :style="{ fontFamily: stackOf(f.value) }"
          >
            {{ f.label }}
          </option>
        </optgroup>
        <optgroup v-if="faces.downloaded.length" :label="t('reader.type.downloaded')">
          <option
            v-for="f in faces.downloaded"
            :key="f.value"
            :value="f.value"
            :style="{ fontFamily: stackOf(f.value) }"
          >
            {{ f.label }}
          </option>
        </optgroup>
      </select>
    </div>
  </div>
</template>
