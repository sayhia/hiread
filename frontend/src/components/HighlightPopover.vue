<script setup lang="ts">
// Two-mode popover, anchored at (x, y):
//   • Editing an existing highlight — pass `hl`. Colour swatches recolour;
//     textarea saves the note; Delete + Done shown; outside click saves.
//   • Creating a highlight from a pending selection — pass `pending`. The
//     highlight isn't in the DB yet; Done / ⌘⏎ / outside-click commit it,
//     Escape aborts without a persist. Colour swatches select a colour that
//     will be applied on commit; textarea's text becomes the note.
//
// Extended so the "just-selected → colour → note" flow lives in one dialog
// rather than a separate colour toolbar followed by a re-opened popover.

import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "../api";
import { reportError } from "../stores/toasts";
import { clampAxis } from "../lib/viewport";
import { HIGHLIGHT_COLORS } from "../lib/highlightColors";
import { swallowPageClick } from "../composables/reader/useTextReaderInput";
import { useFocusTrap } from "../composables/useFocusTrap";
import { modCombo } from "../lib/platform";
import { useUi } from "../stores/ui";
import type { Highlight } from "../types";
import Icon from "./Icon.vue";

const props = defineProps<{
  /** Present when editing an existing highlight. */
  hl?: Highlight;
  /** Present when the popover is being used to *create* a highlight from
   *  a pending text selection — mutually exclusive with `hl`. */
  pending?: { quote: string };
  x: number;
  y: number;
  onClose: () => void;
  /** Fires whenever the *existing* highlight changes (recolour or note
   *  save) so the parent can reload the list. Ignored in create mode. */
  onChanged?: () => void;
  /** Existing-mode: hand the highlight to the parent for delete-with-undo. */
  onDelete?: (hl: Highlight) => void;
  /** Create-mode: parent persists the pending selection with the picked
   *  colour and note text. Called on outside-click, Done, or ⌘⏎. */
  onCreate?: (color: string, note: string) => Promise<void>;
}>();

const { t } = useI18n();
const ui = useUi();
const ref_ = ref<HTMLDivElement>();
useFocusTrap(ref_, true, { autoFocus: !props.pending });
const noteEl = ref<HTMLTextAreaElement>();
const isCreating = !!props.pending;
// Existing highlight: seed from props.hl. Create: start blank.
const note = ref(props.hl?.note ?? "");
function lastHlColor(): string {
  try {
    const v = localStorage.getItem("hlColor");
    if (v && HIGHLIGHT_COLORS.some((c) => c.key === v)) return v;
  } catch {
    /* private mode */
  }
  return "yellow";
}

// Which swatch is "current" — for existing, it's the highlight's stored
// colour; for create-mode we reuse the last pick.
const chosenColor = ref<string>(props.hl?.color ?? lastHlColor());
const place = ref({ left: props.x, top: props.y });
// Once we've committed a create-mode session (outside-click / Done / ⌘⏎),
// don't fire onCreate a second time from an outside-click during the async
// window before onClose runs.
let committed = false;

// X is a plain two-sided viewport clamp; Y keeps its custom flip-above behaviour
// (when the popover would overflow the bottom it jumps above the anchor instead
// of merely being pulled back).
const measure = () => {
  const el = ref_.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const left = clampAxis(props.x, r.width, window.innerWidth, 8);
  let top = props.y;
  if (ui.readerOrientation === "vertical") {
    top = clampAxis(props.y, r.height, window.innerHeight, 8);
  } else if (top + r.height > window.innerHeight - 8) {
    top = props.y - r.height - 28;
  }
  place.value = { left, top: Math.max(8, top) };
};
onMounted(() => {
  measure();
  // Edit mode: put the caret in the note. Create mode must not — focusing
  // the textarea collapses the page selection and makes ⌘C copy an empty
  // note instead of the quote just marked.
  if (!props.hl) return;
  const ta = noteEl.value;
  if (ta) {
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }
});
watch([() => props.x, () => props.y], measure);

// Existing-highlight save: PUT the note if it changed.
const saveExisting = async () => {
  if (!props.hl) return;
  const current = note.value;
  if (current !== props.hl.note) {
    try {
      await api.updateHighlightNote(props.hl.id, current);
      props.onChanged?.();
    } catch (e) {
      reportError(e);
    }
  }
  props.onClose();
};

// Create-mode save: hand the color+note to the parent for persistence.
const saveCreate = async () => {
  if (committed) return;
  committed = true;
  rememberColor(chosenColor.value);
  try {
    await props.onCreate?.(chosenColor.value, note.value);
  } catch (e) {
    reportError(e);
  }
  props.onClose();
};

const save = () => (isCreating ? saveCreate() : saveExisting());

// Colour click: existing mode = live recolour via API; create mode = just
// remembers the choice, real persist happens on save.
function rememberColor(color: string) {
  try {
    localStorage.setItem("hlColor", color);
  } catch {
    /* private mode */
  }
}

const pickColor = async (color: string) => {
  chosenColor.value = color;
  rememberColor(color);
  if (props.hl) {
    try {
      await api.setHighlightColor(props.hl.id, color);
      props.onChanged?.();
    } catch (e) {
      reportError(e);
    }
  }
};

const remove = () => {
  if (!props.hl) return;
  props.onDelete?.(props.hl);
  props.onClose();
};

// Outside-click behaviour differs by mode:
//   • existing highlight — saves the note edit, matching how the popover
//     used to auto-commit an in-progress edit when you clicked away.
//   • pending create — does NOT persist. Creating a highlight is an
//     explicit act ("Done" / ⌘⏎), not an accidental one; a stray click
//     while glancing at another paragraph shouldn't leave marks in the
//     article. Outside-click just closes, dropping the pending selection.
let tm = 0;
const onDown = (e: MouseEvent) => {
  if (ref_.value?.contains(e.target as Node)) return;
  swallowPageClick();
  if (isCreating) props.onClose();
  else save();
};
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    // Create-mode Escape: cancel the pending create. Existing-mode Escape:
    // close without saving the note edit. Both call onClose without side
    // effects — the parent decides how to interpret it.
    e.preventDefault();
    e.stopPropagation();
    committed = true; // suppress the trailing outside-click commit
    swallowPageClick();
    props.onClose();
  }
  // ⌘/Ctrl-Enter commits — Slack/GitHub composer semantics. Plain Enter is
  // a newline, since notes are multi-line by design.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    save();
  }
};
onMounted(() => {
  tm = window.setTimeout(() => {
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
  }, 0);
});
onBeforeUnmount(() => {
  window.clearTimeout(tm);
  document.removeEventListener("mousedown", onDown);
  window.removeEventListener("keydown", onKey, true);
});

// The quote to display: existing highlight's stored quote, or the pending
// selection's captured text.
const displayQuote = props.hl?.quote ?? props.pending?.quote ?? "";
</script>

<template>
  <Teleport to="body">
    <div
      ref="ref_"
      class="hl-popover"
      role="dialog"
      aria-modal="true"
      :aria-label="t('highlights.editTitle')"
      :style="{ left: place.left + 'px', top: place.top + 'px' }"
    >
      <blockquote class="hl-quote">{{ displayQuote }}</blockquote>
      <div class="hl-caption">{{ t("highlights.toolbarLabel") }}</div>
      <div class="hl-swatch-row" role="radiogroup" :aria-label="t('highlights.toolbarLabel')">
        <button
          v-for="c in HIGHLIGHT_COLORS"
          :key="c.key"
          :class="['hl-swatch', chosenColor === c.key ? 'active' : '']"
          :style="{ background: c.swatch }"
          :title="t(`highlights.color.${c.key}`)"
          :aria-label="t(`highlights.color.${c.key}`)"
          role="radio"
          :aria-checked="chosenColor === c.key"
          @click="pickColor(c.key)"
        />
      </div>
      <textarea
        ref="noteEl"
        class="hl-note-input"
        :placeholder="t('highlights.notePlaceholder')"
        v-model="note"
      />
      <div class="hl-popover-actions">
        <button
          v-if="!isCreating"
          class="s-btn ghost danger"
          :title="t('common.delete')"
          @click="remove"
        >
          <Icon name="trash" :size="12" />
        </button>
        <button class="hl-done" @click="save">
          <span>{{ t("common.done") }}</span>
          <kbd class="hl-kbd" aria-hidden="true">{{ modCombo("⏎") }}</kbd>
        </button>
      </div>
    </div>
  </Teleport>
</template>
