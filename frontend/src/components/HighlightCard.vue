<script setup lang="ts">
// Single highlight tile shown in the global Highlights browser. Stateless:
// click emits `select`; the parent decides what to do (jump to source).
//
// Visual redesign (2026-07-05, "quiet spine"): a flat hiread-native card —
// --sheet body, 1px --hair border, --shadow-raise — where the highlight
// colour appears exactly once, as a slim inset spine on the left edge
// painted with the verbatim swatch from highlightColors.ts (pixel-identical
// to the toolbar filter dots). Replaces the 2026-07-02 "aurora gradient
// border + vinyl disc" look, whose multi-hue borders destroyed per-colour
// legibility and whose quote also suffered a leaked popover style (the
// global .hl-quote rule — since scoped to .hl-popover; inner classes here
// are namespaced hlc-* so they can never collide again).
//
// v2 refinement: the spine becomes a live instrument — it casts a faint
// static bloom of its own colour into the card and stretches 2px per end
// under engagement — while the type snaps to an integer 14/22 grid with
// CJK-aware micro-typography, and every state change (grounded hover,
// seated press, dark glass-rim catch) rides one damped motion signature.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { HighlightWithContext } from "../types";
import { relTime } from "../lib/time";
import { highlightBg, highlightSwatch } from "../lib/highlightColors";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    highlight: HighlightWithContext;
    /** Suppress the article title in the meta line. Used by HighlightsPane's
     *  grouped mode where the surrounding group header already shows it. */
    hideArticle?: boolean;
    /** Render the card as the keyboard-active item (accent border + ring). */
    selected?: boolean;
    /** Offer the hover checkbox at all. The browse grid passes true; the
     *  review tab (spaced repetition) leaves it off. */
    checkable?: boolean;
    /** A multi-select is in progress somewhere in the list: keep every card's
     *  checkbox visible (not just on hover) and route plain clicks to `toggle`
     *  instead of navigation, Gmail-style. */
    selecting?: boolean;
    /** This card is part of the current multi-select. */
    checked?: boolean;
  }>(),
  { hideArticle: false, selected: false, checkable: false, selecting: false, checked: false },
);
const emit = defineEmits<{
  (e: "select", h: HighlightWithContext): void;
  (e: "openExternal", h: HighlightWithContext): void;
  (e: "menu", h: HighlightWithContext, ev: MouseEvent): void;
  /** Toggle this card's multi-select membership. The originating event rides
   *  along (mouse or keyboard) so the pane can read shiftKey for ranges. */
  (e: "toggle", h: HighlightWithContext, ev: MouseEvent | KeyboardEvent): void;
}>();

// The card's one colour channel: --hl paints the spine, --hl-wash backs the
// quote's ::selection. Resolved through the shared lib (which owns the
// fallback-to-yellow contract), not a local class map, so the spine always
// matches the toolbar filter dots exactly.
const { t } = useI18n();

const colorVars = computed(() => ({
  "--hl": highlightSwatch(props.highlight.color),
  "--hl-wash": highlightBg(props.highlight.color),
}));

const when = computed(() => relTime(props.highlight.createdAt));

// Cmd/Ctrl-click opens the source URL without entering the in-app reader,
// matching how Mac apps treat ⌘-click as "open in browser". Plain click
// falls through to `select` — UNLESS the user has just drag-selected text
// inside this card (a partial-quote copy gesture); in that case we leave
// the user's selection alone and don't navigate away. Right-click always
// raises the context menu.
function onClick(e: MouseEvent): void {
  // Drag-select check: if the active selection is non-collapsed AND the
  // anchor lives inside this card, the user is trying to copy a snippet,
  // not navigate. Bail out so the selection survives.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length > 0) {
    const anchor = sel.anchorNode;
    const cardEl = (e.currentTarget as HTMLElement | null) ?? null;
    if (cardEl && anchor && cardEl.contains(anchor as Node)) return;
  }
  // While a multi-select is in progress, a plain click grows/shrinks the
  // selection instead of navigating away mid-flow (⌘-click above still opens
  // the source, and Esc / the action bar's cancel exits the mode).
  if (props.selecting) {
    emit("toggle", props.highlight, e);
    return;
  }
  emit("select", props.highlight);
}
// The checkbox is its own click target so it works before any selection
// exists (when `selecting` is still false) without hijacking card clicks.
function onCheckClick(e: MouseEvent): void {
  e.stopPropagation();
  emit("toggle", props.highlight, e);
}
function onContextmenu(e: MouseEvent): void {
  e.preventDefault();
  emit("menu", props.highlight, e);
}
// Enter / Space activate the card when it has keyboard focus, matching the
// `<button>` semantics we give up by using a div as the interactive root.
// While a multi-select is in progress they toggle membership instead —
// keyboard parity with the click routing above.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (props.selecting) emit("toggle", props.highlight, e);
    else emit("select", props.highlight);
  }
}
</script>

<template>
  <div
    :class="['hl-card', { active: selected, checkable, selecting, checked }]"
    :style="colorVars"
    role="button"
    :tabindex="0"
    @click="onClick"
    @keydown="onKeydown"
    @contextmenu="onContextmenu"
  >
    <button
      v-if="checkable"
      class="hlc-check"
      :title="t('highlights.select')"
      :aria-label="t('highlights.select')"
      :aria-pressed="checked"
      tabindex="-1"
      @click="onCheckClick"
    >
      <Icon v-if="checked" name="check" :size="11" />
    </button>
    <blockquote class="hlc-quote">{{ highlight.quote }}</blockquote>
    <p v-if="highlight.note.trim()" class="hlc-note">{{ highlight.note }}</p>
    <div class="hlc-meta">
      <span v-if="!hideArticle" class="hlc-article">{{ highlight.bookTitle }}</span>
      <time class="hlc-time">{{ when }}</time>
    </div>
  </div>
</template>

<style scoped>
/* ── Card shell ────────────────────────────────────────────────────────────
   A flat hiread surface, indistinguishable from the app's other cards: --sheet
   body, hairline border, lifted by --shadow-raise with the --card-glass top
   edge. height:100% fills the <li> grid cell, so row-stretch (not a
   min-height) equalizes rows — a short quote yields structured whitespace
   between quote and bottom-pinned meta instead of a padded void. */
.hl-card {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--sheet);
  border: 1px solid var(--hair);
  /* A library can hold thousands of highlights; skip rendering cards the
     viewport cannot see (they paint when scrolled to). */
  content-visibility: auto;
  contain-intrinsic-size: auto 180px;
  border-radius: 10px;
  /* left = 14px gutter + 4px spine allowance, for a consistent optical gutter.
     Row density follows the global density setting, like the sidebar. */
  padding: calc(var(--row-py) - 2px) var(--list-px) calc(var(--row-py) - 3px) 18px;
  box-shadow: var(--card-glass), var(--shadow-raise);
  cursor: pointer;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden; /* contain the spine bloom inside the 10px radius */
  --glow-a: 40%;    /* spine-bloom strength; dark override at bottom of block */
  /* One damped motion signature (ease-out, no overshoot — a dense grid must
     not wobble under cursor sweeps); the shadow lags the lift by 60ms. */
  transition:
    border-color .16s ease,
    transform .16s cubic-bezier(.2, .7, .3, 1),
    box-shadow .22s cubic-bezier(.2, .7, .3, 1);
}

/* ── Spine: the single colour encoding, and the card's two vitality moments ─
   One slim inset bar in the verbatim swatch colour — the same value as the
   toolbar filter dots, so colour scanning matches the filter 1:1. The 12px
   vertical insets lock it to the content rhythm (a deliberate mark, not a
   clipped border); the faint ink ring crisps the pale yellow on white and
   flips to a harmless light halo in dark. Never darken the swatch itself.
   Moment 1 (static, chromatic): the spine casts a faint bloom of its own
   colour into the card — max reach 17px, one short of the 18px text inset,
   so the quote always sits on clean --sheet. Moment 2 is the stretch below. */
.hl-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 4px; /* width + verbatim swatch are sacred: toolbar-dot pixel parity */
  border-radius: 0 2px 2px 0;
  background: var(--hl);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 15%, transparent),
    3px 0 12px -2px color-mix(in srgb, var(--hl) var(--glow-a), transparent);
  transition:
    top .16s cubic-bezier(.2, .7, .3, 1),
    bottom .16s cubic-bezier(.2, .7, .3, 1);
}
/* Engagement: the data mark stretches 2px per end — structural motion, never
   chromatic. Includes .active so J/K stepping breathes card-to-card. */
.hl-card:hover::before,
.hl-card.active::before,
.hl-card:focus-visible::before {
  top: 10px;
  bottom: 10px;
}

/* ── Quote: the hero, first content element ── */
.hlc-quote {
  margin: 0;
  padding: 0;
  font-family: var(--ui); /* sans, never --serif */
  font-size: 14px;
  /* 500, not 450: CJK fallbacks snap 450→500 anyway; unifying stops embedded
     Latin from rendering lighter mid-line. Don't fork per theme (PingFang
     can't interpolate — the split would return). */
  font-weight: 500;
  line-height: 22px; /* integer line box; 1.571 leading clears dense CJK */
  letter-spacing: -0.004em;
  hanging-punctuation: first allow-end; /* 「『“ hang into the gutter — line 1 optically flush */
  text-autospace: normal; /* quarter-em 汉字↔Latin gap; ignored harmlessly elsewhere */
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  text-wrap: pretty;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 5; /* up from 4 — the 40px disc column is gone */
  -webkit-box-orient: vertical;
  overflow: hidden;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
/* Selecting quote text shows the marker wash — ties the drag-copy gesture
   (special-cased in onClick) back to the highlight colour. */
.hlc-quote::selection { background: var(--hl-wash); }

/* ── Note: annotation, hairline-anchored ───────────────────────────────────
   The top hairline structurally attaches the note to its quote (their words
   above the line, yours below) — the fix for the old floating italic debris.
   Upright 12px: italic smalltext is illegible and warm-editorial-coded. */
.hlc-note {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--hair); /* the card's ONE internal hairline */
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
  color: var(--muted);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* ── Meta: mono instrument footer, bottom-pinned ── */
.hlc-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
  font-family: var(--mono);
  font-size: 10.5px; /* matches .hl-group-count just above the grid */
  line-height: 14px; /* explicit box (was ~13.2px "normal") */
  letter-spacing: 0.02em;
  color: var(--muted-2);
  /* no uppercase: article titles are content, often CJK */
}
.hlc-article {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.hlc-time {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  margin-left: auto; /* keeps time right-aligned when grouped mode drops the title */
}

/* ── States ────────────────────────────────────────────────────────────────
   Hover is a whisper (1px lift + border step). The keyboard-active/focus
   ring is system state (accent), the spine is data (colour) — they coexist,
   unlike the old design where active repainted the colour border away. */
.hl-card:hover {
  transform: translateY(-1px);
  border-color: var(--hair-strong);
  /* Keep the contact shadow UNDER the soft bloom — lifted but still attached,
     not unmoored. Border stays neutral: colored borders are the accent
     system-state's exclusive language; hover vitality is the spine stretch. */
  box-shadow: var(--card-glass), var(--shadow-raise), var(--shadow-card);
}
/* ── Multi-select ──────────────────────────────────────────────────────────
   The checkbox lives top-right, hidden until hover — or held visible on every
   card while a selection is in progress (`selecting`) so the mode is legible.
   A checked card takes the accent border WITHOUT the ring: ring = keyboard
   cursor (one card), border = membership (many cards). Source order matters:
   these sit after :hover (checked border survives hovering) and before
   .active (the cursor's ring still wins on the card that has both). */
.hlc-check {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  background: var(--sheet);
  border: 1px solid var(--hair-strong);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity .16s ease, background .16s ease, border-color .16s ease;
}
.hl-card.checkable:hover .hlc-check,
.hl-card.selecting .hlc-check,
.hl-card.checked .hlc-check { opacity: 1; }
.hlc-check:hover { border-color: var(--accent); }
.hl-card.checked .hlc-check {
  background: var(--accent);
  border-color: var(--accent);
}
.hl-card.checked { border-color: var(--accent); }

.hl-card.active,
.hl-card:focus-visible {
  border-color: var(--accent);
  box-shadow:
    var(--card-glass),
    0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent),
    var(--shadow-raise);
}
.hl-card.active:hover { transform: none; }

/* Press: the card seats back into the panel — fast in (.07s while held),
   damped out (durations revert on release). No scale: it would jitter text
   under the cursor mid drag-select and blur the 1px hairline. */
.hl-card:active {
  transform: translateY(0);
  box-shadow: var(--card-glass), var(--shadow-raise);
  transition-duration: .07s;
}
/* Pressing the keyboard-selected card must not blink its accent ring away. */
.hl-card.active:active,
.hl-card:focus-visible:active {
  box-shadow:
    var(--card-glass),
    0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent),
    var(--shadow-raise);
}

/* ── Dark theme ────────────────────────────────────────────────────────────
   Everything else routes through tokens that flip; these four are deliberate.
   Order matters: the ring-parity rule is last so it also wins while pressed. */
/* The 0.55-alpha wash lands mid-tone over the dark sheet and muddies --ink —
   use the opaque swatch with near-black text: a literal highlighter stroke. */
[data-theme="dark"] .hlc-quote::selection {
  background: var(--hl);
  color: #10161f;
}
/* Light swatches glow ~2x harder against the dark sheet — halve the bloom. */
[data-theme="dark"] .hl-card {
  --glow-a: 26%;
}
/* Dark hover cue: shadows are black-on-black here — the card signals
   proximity by catching light: glass rim steps 0.12 → 0.20, same .22s track. */
[data-theme="dark"] .hl-card:hover {
  --card-glass: inset 0 1px 0 rgba(150, 175, 210, 0.20);
}
/* Ring parity: 22% accent over the dark floor reads fainter than in light;
   30% restores equal weight without becoming a glow. */
[data-theme="dark"] .hl-card.active,
[data-theme="dark"] .hl-card:focus-visible {
  box-shadow:
    var(--card-glass),
    0 0 0 3px color-mix(in oklch, var(--accent) 30%, transparent),
    var(--shadow-raise);
}
</style>
