<script lang="ts">
// Ids whose delete is still inside its 6s undo window (backend untouched
// until commit). Module-scoped, not setup-scoped: the withUndo timers live in
// the global toast store and keep running if this pane unmounts (switching
// views), so a remounted pane must still filter these out of fresh fetches.
// Maintained by removeHighlight / removeChecked (apply adds, commit/revert
// removes); consumed by the list queryFn's post-filter.
const pendingDeleteIds = new Set<number>();
</script>

<script setup lang="ts">
// Global Highlights browser. Renders in the middle pane when ui.middlePane ===
// "highlights". Three modes (toggle/input combine):
//   - default: time-desc list
//   - "Group by article" toggle: same data, regrouped per article
//   - search: typing filters via SearchHighlights LIKE
// Click on a card emits `open-highlight`; App.vue's listener opens the
// reader and stashes the highlight id in ui.pendingHighlightId.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { Browser } from "@wailsio/runtime";
import * as api from "../api";
import { reportError, toast, withUndo } from "../stores/toasts";
import { useDismiss } from "../composables/useDismiss";
import { useFocusTrap } from "../composables/useFocusTrap";
import { clampToViewport } from "../lib/viewport";
import { HIGHLIGHT_COLORS } from "../lib/highlightColors";
import { filterRange, weekStart } from "../lib/highlightBuckets";
import type { HighlightWithContext } from "../types";
import HighlightCard from "./HighlightCard.vue";
import HighlightReviewList from "./HighlightReviewList.vue";
import ContextMenu, { type MenuEntry } from "./ContextMenu.vue";
import Icon from "./Icon.vue";

const { t, locale } = useI18n();

const emit = defineEmits<{
  (e: "open-highlight", payload: { highlightId: number; bookId: number; chapterIndex: number }): void;
}>();

// ── Tabs ─────────────────────────────────────────────────────────────────
// Browse keeps every existing ref/computed below untouched — Review has its
// own state, living inside its own component (HighlightReviewList) and
// receiving the full unfiltered row set as a prop. There used to be a third
// "This Week" tab; it was folded into Browse's own time-range dropdown (see
// "Time-range filter" below) because a tab literally named "This Week" that
// could ALSO show "Last week"/"This month"/a custom range once you opened it
// was a standing contradiction — the tab's own label lied about its content
// the moment you picked anything else inside it.
type PaneTab = "browse" | "review";
const activeTab = ref<PaneTab>("browse");

const search = ref("");
const debounced = ref("");
let searchTimer: number | undefined;
watch(search, (v) => {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  const next = v.trim();
  if (!next) {
    debounced.value = "";
    return;
  }
  searchTimer = window.setTimeout(() => {
    debounced.value = next;
  }, 200);
});

onBeforeUnmount(() => {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  window.removeEventListener("keydown", onNoteKey, true);
});

onMounted(() => window.addEventListener("keydown", onNoteKey, true));

const groupByArticle = ref(false);

// Color filter: null = "all", or one of the HIGHLIGHT_COLORS keys.
// Filtering is purely client-side — the existing list/search query already
// gives us every highlight; a backend `WHERE color = ?` would just add
// round-trips for a few-thousand-row sort.
const colorFilter = ref<string | null>(null);

// One query handles both list and search; cache key changes when the debounced
// term changes, so vue-query swaps cleanly.
const list = useQuery({
  queryKey: ["highlights", "list", debounced] as const,
  // Post-filter every fetch through the pending-delete set: rows whose delete
  // is still inside its undo window must never re-enter the rendered data,
  // no matter what triggers a refetch (window focus, another delete's commit
  // invalidating ["highlights"], a search-key change...). Without this, the
  // backend — untouched until commit — happily resurrects them.
  queryFn: () =>
    (debounced.value === "" ? api.listAllHighlights() : api.searchHighlights(debounced.value)).then(
      (rows) => rows.filter((r) => !pendingDeleteIds.has(r.id)),
    ),
  // Highlights rarely change under the pane; keep the last fetch warm so a
  // middle-pane switch does not re-download thousands of rows every time.
  staleTime: 30_000,
});

const allRows = computed<HighlightWithContext[]>(() => list.data.value ?? []);
const rows = computed<HighlightWithContext[]>(() =>
  colorFilter.value === null
    ? allRows.value
    : allRows.value.filter((h) => h.color === colorFilter.value),
);
// Per-color counts for the filter dots — drives the small numbers next to
// each swatch and the disabled state when a colour has no highlights.
const colorCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const c of HIGHLIGHT_COLORS) out[c.key] = 0;
  for (const h of allRows.value) {
    if (out[h.color] !== undefined) out[h.color] += 1;
  }
  return out;
});

// ── Time-range filter (Browse toolbar dropdown) ─────────────────────────
// Was previously a whole separate "This Week" tab with its own 4 chips;
// folded in here so it composes with the search/color filter above instead
// of living in a page whose own name ("This Week") stopped matching its
// content the moment you picked "Last week" inside it.
type RangeKey = "all" | "thisWeek" | "lastWeek" | "thisMonth" | "custom";
const activeRange = ref<RangeKey>("all");
const customFrom = ref(""); // "YYYY-MM-DD", <input type="date">'s native format
const customTo = ref("");
const customApplied = ref<{ from: string; to: string } | null>(null);

const rangeInstants = computed<{ from: string; to: string } | null>(() => {
  const now = new Date();
  if (activeRange.value === "all") return null;
  if (activeRange.value === "thisWeek") {
    const start = weekStart(locale.value, now);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  if (activeRange.value === "lastWeek") {
    const thisStart = weekStart(locale.value, now);
    const start = new Date(thisStart);
    start.setDate(start.getDate() - 7);
    return { from: start.toISOString(), to: thisStart.toISOString() };
  }
  if (activeRange.value === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  // custom — customApplied.to is the user's inclusive end date; the actual
  // filter boundary is midnight of the NEXT day, matching filterRange's
  // [from, to) contract (see lib/highlightBuckets.ts's filterRange doc).
  if (customApplied.value) {
    const toExclusive = new Date(`${customApplied.value.to}T00:00:00`);
    toExclusive.setDate(toExclusive.getDate() + 1);
    return {
      from: new Date(`${customApplied.value.from}T00:00:00`).toISOString(),
      to: toExclusive.toISOString(),
    };
  }
  return null; // "custom" selected but not applied yet — no filter
});

const rangeFiltered = computed<HighlightWithContext[]>(() =>
  rangeInstants.value === null
    ? rows.value
    : filterRange(rows.value, rangeInstants.value.from, rangeInstants.value.to),
);

const rangeLabel = computed(() => {
  if (activeRange.value === "all") return t("highlights.rangeFilter.all");
  if (activeRange.value === "thisWeek") return t("highlights.rangeFilter.thisWeek");
  if (activeRange.value === "lastWeek") return t("highlights.rangeFilter.lastWeek");
  if (activeRange.value === "thisMonth") return t("highlights.rangeFilter.thisMonth");
  return customApplied.value
    ? `${customApplied.value.from} → ${customApplied.value.to}`
    : t("highlights.rangeFilter.custom");
});

// Dropdown trigger + menu — reuses ContextMenu.vue (a plain x/y-anchored
// popover, not exclusively a right-click affordance; Sidebar.vue already
// opens it from a left click the same way).
const rangeBtnRef = ref<HTMLButtonElement>();
const rangeMenu = ref<{ x: number; y: number; items: MenuEntry[] } | null>(null);
function openRangeMenu(): void {
  const btn = rangeBtnRef.value;
  const r = btn?.getBoundingClientRect();
  const x = r ? r.left : 0;
  const y = r ? r.bottom + 4 : 0;
  const entry = (key: RangeKey, label: string): MenuEntry => ({
    label,
    onClick: () => { activeRange.value = key; },
  });
  rangeMenu.value = {
    x,
    y,
    items: [
      entry("all", t("highlights.rangeFilter.all")),
      entry("thisWeek", t("highlights.rangeFilter.thisWeek")),
      entry("lastWeek", t("highlights.rangeFilter.lastWeek")),
      entry("thisMonth", t("highlights.rangeFilter.thisMonth")),
      { separator: true },
      {
        label: t("highlights.rangeFilter.custom"),
        onClick: () => openCustomPopover(x, y),
      },
    ],
  };
}

// Custom-range date popover — ported from the old HighlightDigestList.vue
// tab body 1:1 (same TagPicker.vue-style floating-popover pattern: fixed
// position, clamped into the viewport, teleported to <body>, dismissed via
// useDismiss). Anchored at the same coordinates the range dropdown opened
// at, so it appears to "replace" the dropdown in place.
const customPopoverRef = ref<HTMLDivElement>();
const showCustomPopover = ref(false);
const customPopoverPos = ref({ left: 0, top: 0 });
function openCustomPopover(x: number, y: number): void {
  customPopoverPos.value = clampToViewport({ x, y, width: 236, height: 140 });
  showCustomPopover.value = true;
}
function closeCustomPopover(): void {
  showCustomPopover.value = false;
}
useDismiss(customPopoverRef, closeCustomPopover);
const customValid = computed(() => {
  if (!customFrom.value || !customTo.value) return false;
  return customFrom.value <= customTo.value;
});
function applyCustomRange(): void {
  if (!customValid.value) return;
  customApplied.value = { from: customFrom.value, to: customTo.value };
  activeRange.value = "custom";
  showCustomPopover.value = false;
}

// Warn when the list grows past the threshold from the spec; we do not
// upgrade search until/unless this fires for real users.
watch(rangeFiltered, (rs) => {
  if (rs.length >= 5000) {
    // eslint-disable-next-line no-console
    console.warn(
      `[hiread] Highlights count = ${rs.length}; consider upgrading the LIKE search to FTS5.`,
    );
  }
});

interface Group { bookId: number; bookTitle: string; items: HighlightWithContext[] }

const grouped = computed<Group[]>(() => {
  const byId = new Map<number, Group>();
  const out: Group[] = [];
  for (const r of rangeFiltered.value) {
    let g = byId.get(r.bookId);
    if (!g) {
      g = { bookId: r.bookId, bookTitle: r.bookTitle, items: [] };
      byId.set(r.bookId, g);
      out.push(g);
    }
    g.items.push(r);
  }
  return out;
});

function onSelect(h: HighlightWithContext): void {
  emit("open-highlight", { highlightId: h.id, bookId: h.bookId, chapterIndex: h.chapterIndex });
}

// ── Keyboard navigation ──────────────────────────────────────────────────
// J/K + ArrowUp/ArrowDown move the selection within the visible list (in
// rendered order — flat list when grouping is off, group-walk order when
// on); Home/End jump to the ends; Enter opens the selected card. The
// selection survives toggling group-by-article because the whole list
// stays the same set of ids.
const selectedId = ref<number | null>(null);
const flatVisible = computed<HighlightWithContext[]>(() => {
  // `rangeFiltered` is already in newest-first order; grouped mode walks the
  // same array in group order, but each highlight appears exactly once in
  // both shapes so a single index works for both renderings.
  return rangeFiltered.value;
});

function move(delta: number | "home" | "end"): void {
  const list = flatVisible.value;
  if (list.length === 0) return;
  const cur = list.findIndex((h) => h.id === selectedId.value);
  let next: number;
  if (delta === "home") next = 0;
  else if (delta === "end") next = list.length - 1;
  else if (cur < 0) next = delta > 0 ? 0 : list.length - 1;
  else next = Math.max(0, Math.min(list.length - 1, cur + delta));
  selectedId.value = list[next].id;
  // Scroll the selected row into view if it's outside the scroller.
  // queueMicrotask defers until after Vue applies the .active class.
  queueMicrotask(() => {
    document
      .querySelector<HTMLElement>(`[data-hl-row="${list[next].id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  });
}
function onKeyDown(e: KeyboardEvent): void {
  // Ignore keystrokes typed into the search input or any editable target.
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (document.querySelector(".cp-backdrop, .settings-backdrop, .modal-backdrop, .ctx-menu, .hl-digest-popover, .tag-picker")) return;
  switch (e.key) {
    case "ArrowDown":
    case "j":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
    case "k":
      e.preventDefault();
      move(-1);
      break;
    case "Home":
      e.preventDefault();
      move("home");
      break;
    case "End":
      e.preventDefault();
      move("end");
      break;
    case "Enter": {
      const h = flatVisible.value.find((x) => x.id === selectedId.value);
      if (h) {
        e.preventDefault();
        // Mirror the click routing: while a multi-select is in progress,
        // Enter toggles the cursor card's membership instead of navigating
        // away mid-flow (keyboard parity with plain click).
        if (isSelecting.value) toggleCheck(h, e);
        else onSelect(h);
      }
      break;
    }
    case "Delete":
    case "Backspace": {
      if (isSelecting.value) {
        e.preventDefault();
        removeChecked();
        break;
      }
      const h = flatVisible.value.find((x) => x.id === selectedId.value);
      if (h) {
        e.preventDefault();
        removeHighlight(h);
      }
      break;
    }
    case "Escape":
      // Clear an in-progress multi-select — but only when no floating layer
      // is open above us (their own Esc-dismiss listens at the window level,
      // which sits AFTER this bubbling handler; swallowing the key here
      // would leave the popover stuck open). App.vue's global handler runs
      // later still, so an un-swallowed Esc keeps its usual meaning.
      if (
        checked.value.size > 0 &&
        !document.querySelector(".ctx-menu, .hl-digest-popover")
      ) {
        e.preventDefault();
        e.stopPropagation();
        clearChecks();
      }
      break;
  }
}
// Reset selection when the visible set changes meaningfully (search, color
// filter, or time-range filter). We don't clear it on every refetch because
// that would fight the user's keyboard cursor.
watch(debounced, () => { selectedId.value = null; clearChecks(); });
watch(colorFilter, () => { selectedId.value = null; clearChecks(); });
watch(activeRange, () => { selectedId.value = null; clearChecks(); });

// ── Multi-select (batch delete) ──────────────────────────────────────────
// Gmail-style: the hover checkbox on any card starts a selection; while one
// is in progress every checkbox stays visible, plain card clicks toggle
// membership, shift-click extends over the visible range, Esc / the action
// bar's ✕ clears. `checked` is replaced (never mutated) so computeds react.
const checked = ref<Set<number>>(new Set());
const isSelecting = computed(() => checked.value.size > 0);
// Anchor for shift-click ranges — the last card whose checkbox was toggled.
let lastToggledId: number | null = null;

// Accepts mouse or keyboard events — only .shiftKey is read (range sweep).
function toggleCheck(h: HighlightWithContext, ev: MouseEvent | KeyboardEvent): void {
  const next = new Set(checked.value);
  if (ev.shiftKey && lastToggledId != null && lastToggledId !== h.id) {
    const list = flatVisible.value;
    const a = list.findIndex((x) => x.id === lastToggledId);
    const b = list.findIndex((x) => x.id === h.id);
    if (a >= 0 && b >= 0) {
      // Sweep: extend the anchor's current state across the range —
      // shift-clicking from a checked anchor checks the run, from an
      // unchecked anchor unchecks it.
      const on = next.has(lastToggledId);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (on) next.add(list[i].id);
        else next.delete(list[i].id);
      }
      checked.value = next;
      lastToggledId = h.id;
      return;
    }
  }
  if (next.has(h.id)) next.delete(h.id);
  else next.add(h.id);
  checked.value = next;
  // An emptied set exits selection mode — drop the anchor with it, or the
  // next shift-click would sweep "uncheck" from a stale anchor and no-op.
  lastToggledId = next.size === 0 ? null : h.id;
}
function selectAllVisible(): void {
  checked.value = new Set(rangeFiltered.value.map((h) => h.id));
}
function clearChecks(): void {
  if (checked.value.size > 0) checked.value = new Set();
  lastToggledId = null;
}

// ── Export ───────────────────────────────────────────────────────────────
// What gets exported is what is on screen: the ticked cards if any are
// ticked, otherwise every card the current search, colour and date filters
// leave visible — in the order they are shown. The backend cannot re-derive
// that set (it knows nothing of the colour filter, or of a delete still
// inside its undo window), so the ids are what we send.
const exportRows = computed<HighlightWithContext[]>(() =>
  checked.value.size === 0
    ? rangeFiltered.value
    : rangeFiltered.value.filter((h) => checked.value.has(h.id)),
);

const exporting = ref(false);
async function exportAll(): Promise<void> {
  if (exporting.value || exportRows.value.length === 0) return;
  exporting.value = true;
  try {
    // The backend opens a native save panel and writes the file (the Wails
    // WKWebView can't save a synthetic <a download>); it returns the chosen
    // path, or an empty string if the user cancelled. Mirrors OPML export.
    const savedPath = await api.exportSelectionMarkdown(exportRows.value.map((h) => h.id));
    if (!savedPath) return;
    toast.show(t("highlights.exported"));
  } catch (e) {
    reportError(e);
  } finally {
    exporting.value = false;
  }
}
// Leaving the browse tab ends the selection — otherwise it survives
// invisibly (the bar and checkboxes only render there), swallows Escape on
// the review tab, and ambushes the user on return.
watch(activeTab, () => clearChecks());

// ── Context menu (right-click) ───────────────────────────────────────────
const menu = ref<{ x: number; y: number; items: MenuEntry[] } | null>(null);
const qc = useQueryClient();

async function copyText(text: string, toastKey: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.show(t(toastKey));
  } catch (e) {
    reportError(e);
  }
}

async function recolor(h: HighlightWithContext, color: string): Promise<void> {
  if (color === h.color) return;
  try {
    await api.setHighlightColor(h.id, color);
    await qc.invalidateQueries({ queryKey: ["highlights"] });
  } catch (e) {
    reportError(e);
  }
}

// Delete with a 6s Undo window. The row vanishes from every cached list
// immediately (optimistic apply) and its id is parked in pendingDeleteIds so
// a mid-window refetch can't resurrect it; the real API call runs only after
// the undo window expires. Undo simply un-parks the id and refetches — the
// backend is untouched until commit, so the server itself is the snapshot
// (positions come back exactly, and nothing clobbers concurrent updates).
//
// Pre-compute the next selection so the keyboard cursor advances to a
// sibling row, the email-app behaviour. Computed against the current
// visible list, not the post-apply list.
function removeHighlight(h: HighlightWithContext): void {
  let nextId: number | null = null;
  if (selectedId.value === h.id) {
    const list = flatVisible.value;
    const i = list.findIndex((x) => x.id === h.id);
    if (i >= 0) {
      const sib = list[i + 1] ?? list[i - 1];
      nextId = sib?.id ?? null;
    }
  }

  withUndo({
    text: t("highlights.deleted"),
    apply: () => {
      pendingDeleteIds.add(h.id);
      qc.setQueriesData<HighlightWithContext[]>({ queryKey: ["highlights", "list"] }, (old) =>
        old?.filter((x) => x.id !== h.id),
      );
      if (selectedId.value === h.id) selectedId.value = nextId;
      // Prune the multi-select too, or the action bar keeps counting a card
      // that no longer exists (and "delete selected" would over-report).
      if (checked.value.has(h.id)) {
        const next = new Set(checked.value);
        next.delete(h.id);
        checked.value = next;
        if (next.size === 0) lastToggledId = null;
      }
    },
    commit: () => {
      api
        .deleteHighlight(h.id)
        .catch(reportError)
        // Resync from backend truth whether the delete succeeded or failed —
        // on failure the optimistic removal must not keep lying. (Note this
        // reaches only vue-query consumers; the in-article HighlightLayer
        // manages its own state and reloads per article on open.)
        .finally(() => {
          pendingDeleteIds.delete(h.id);
          qc.invalidateQueries({ queryKey: ["highlights"] });
          qc.invalidateQueries({ queryKey: ["libraryCounts"] });
        });
    },
    revert: () => {
      pendingDeleteIds.delete(h.id);
      qc.invalidateQueries({ queryKey: ["highlights"] });
      qc.invalidateQueries({ queryKey: ["libraryCounts"] });
    },
  });
}

// Batch variant of removeHighlight: same optimistic-apply / undo-window /
// commit shape, but batched. Three deliberate differences from a naive port:
// the removal is applied to EVERY cached list key (not just the active search
// term, or clearing the search mid-window would "resurrect" the rows); the
// ids sit in pendingDeleteIds so any refetch during the window re-filters
// them (see the queryFn); and revert simply drops the pending marks and
// refetches — the backend is untouched until commit, so the server is the
// snapshot, and restoring from it can't clobber concurrent cache updates
// (e.g. a recolor) the way a saved full-array snapshot would.
function removeChecked(): void {
  const ids = new Set(checked.value);
  if (ids.size === 0) return;
  withUndo({
    text: t("highlights.deletedCount", { count: ids.size }),
    apply: () => {
      for (const id of ids) pendingDeleteIds.add(id);
      qc.setQueriesData<HighlightWithContext[]>({ queryKey: ["highlights", "list"] }, (old) =>
        old?.filter((x) => !ids.has(x.id)),
      );
      if (selectedId.value != null && ids.has(selectedId.value)) selectedId.value = null;
      clearChecks();
    },
    commit: () => {
      api
        .deleteHighlights([...ids])
        .catch(reportError)
        // Resync from backend truth whether the delete succeeded or failed —
        // on failure the optimistic removal must not keep lying. (Note this
        // reaches only vue-query consumers; the in-article HighlightLayer
        // manages its own state and reloads per article on open.)
        .finally(() => {
          for (const id of ids) pendingDeleteIds.delete(id);
          qc.invalidateQueries({ queryKey: ["highlights"] });
          qc.invalidateQueries({ queryKey: ["libraryCounts"] });
        });
    },
    revert: () => {
      for (const id of ids) pendingDeleteIds.delete(id);
      qc.invalidateQueries({ queryKey: ["highlights"] });
      qc.invalidateQueries({ queryKey: ["libraryCounts"] });
    },
  });
}

const editingNote = ref<{ id: number; text: string } | null>(null);
const noteDialogRef = ref<HTMLDivElement>();
useFocusTrap(noteDialogRef, computed(() => editingNote.value != null));

function onNoteKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !editingNote.value) return;
  e.preventDefault();
  e.stopPropagation();
  editingNote.value = null;
}

watch(editingNote, (cur) => {
  if (!cur) return;
  void nextTick(() => noteDialogRef.value?.querySelector("textarea")?.focus());
});

function saveNote() {
  const cur = editingNote.value;
  if (!cur) return;
  api
    .updateHighlightNote(cur.id, cur.text)
    .then(() => {
      editingNote.value = null;
      qc.invalidateQueries({ queryKey: ["highlights"] });
    })
    .catch(reportError);
}

function onMenu(h: HighlightWithContext, ev: MouseEvent): void {
  selectedId.value = h.id;
  const items: MenuEntry[] = [
    {
      icon: "open",
      label: t("articleList.menuOpen"),
      onClick: () => onSelect(h),
    },
    { separator: true },
    {
      icon: "copy",
      label: t("highlights.copyQuote"),
      onClick: () => copyText(h.quote, "highlights.quoteCopied"),
    },
    // "Copy quote + note" only appears when there's a note to combine —
    // otherwise it would just duplicate the row above. Output is the
    // quote, a blank line, then the note in italic-style block ('> '
    // would suggest more quote; plain text reads cleanest in chat / docs).
    ...(h.note.trim()
      ? [
          {
            icon: "copy" as const,
            label: t("highlights.copyQuoteAndNote"),
            onClick: () => copyText(`${h.quote}\n\n— ${h.note}`, "highlights.quoteAndNoteCopied"),
          },
          {
            icon: "copy" as const,
            label: t("highlights.copyNote"),
            onClick: () => copyText(h.note, "highlights.noteCopied"),
          },
        ]
      : []),
    { separator: true },
    {
      icon: "text",
      label: t("highlights.editTitle"),
      onClick: () => (editingNote.value = { id: h.id, text: h.note }),
    },
    { separator: true },
    {
      swatches: HIGHLIGHT_COLORS.map((c) => ({ value: c.key, color: c.swatch })),
      current: h.color,
      onPick: (color: string) => recolor(h, color),
    },
    { separator: true },
    {
      icon: "trash",
      label: t("highlights.delete"),
      danger: true,
      onClick: () => removeHighlight(h),
    },
  ];
  menu.value = { x: ev.clientX, y: ev.clientY, items };
}
</script>

<template>
  <section
    class="list hl-pane"
    role="region"
    aria-labelledby="hl-pane-title"
    :tabindex="0"
    @keydown="onKeyDown"
  >
    <header class="list-header">
      <h1 class="list-title" id="hl-pane-title">
        {{ t("highlights.title") }}
        <span class="count">{{ activeTab === "browse" ? rangeFiltered.length : allRows.length }}</span>
      </h1>
      <div class="hl-tabs" role="tablist" :aria-label="t('highlights.title')">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'browse'"
          :class="['hl-tab', { active: activeTab === 'browse' }]"
          @click="activeTab = 'browse'"
        >
          {{ t("highlights.tabs.browse") }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'review'"
          :class="['hl-tab', { active: activeTab === 'review' }]"
          @click="activeTab = 'review'"
        >
          {{ t("highlights.tabs.review") }}
        </button>
      </div>
      <div v-if="activeTab === 'browse'" class="list-meta">
        <button
          type="button"
          :class="`list-meta-btn ${groupByArticle ? 'on' : ''}`"
          :aria-pressed="groupByArticle"
          @click="groupByArticle = !groupByArticle"
          :title="t('highlights.groupByArticle')"
        >
          <Icon name="list" :size="12" />
          {{ t("highlights.groupByArticle") }}
        </button>
        <!-- Color filter: 5 dots, click to filter to that colour, click again to clear.
             Disabled when no highlight uses that colour. -->
        <div class="hl-color-filter" role="group" :aria-label="t('highlights.filterByColor')">
          <button
            v-for="c in HIGHLIGHT_COLORS"
            :key="c.key"
            type="button"
            class="hl-color-dot"
            :class="{ on: colorFilter === c.key }"
            :style="{ '--dot': c.swatch }"
            :disabled="colorCounts[c.key] === 0"
            :aria-pressed="colorFilter === c.key"
            :title="`${t('highlights.color.' + c.key)} · ${colorCounts[c.key]}`"
            @click="colorFilter = colorFilter === c.key ? null : c.key"
          />
        </div>
        <!-- Time-range filter: single dropdown trigger (was 4 separate chips
             on their own "This Week" tab) — see openRangeMenu(). -->
        <button
          ref="rangeBtnRef"
          type="button"
          :class="`list-meta-btn ${activeRange !== 'all' ? 'on' : ''}`"
          @click="openRangeMenu"
        >
          <Icon name="clock" :size="12" />
          {{ rangeLabel }}
          <Icon name="chevron-down" :size="10" />
        </button>
        <label class="list-meta-search" :class="{ on: search.length > 0 }">
          <Icon name="search" :size="12" />
          <input
            v-model="search"
            type="search"
            :placeholder="t('highlights.searchPlaceholder')"
            :aria-label="t('highlights.searchPlaceholder')"
            @keydown.escape.prevent="search ? (search = '') : undefined"
          />
          <button
            v-if="search.length > 0"
            type="button"
            class="list-meta-search-clear"
            :aria-label="t('highlights.clearSearch')"
            :title="t('highlights.clearSearch')"
            @click="search = ''"
          >
            <Icon name="x" :size="11" />
          </button>
        </label>
        <div style="flex: 1" />
        <button
          type="button"
          class="list-meta-btn"
          :disabled="exporting || exportRows.length === 0"
          @click="exportAll"
          :title="t('highlights.exportCount', { count: exportRows.length })"
        >
          <Icon name="arrow-down" :size="12" />
          {{ t("highlights.exportAll") }}
        </button>
      </div>
    </header>

    <ContextMenu
      v-if="rangeMenu"
      :x="rangeMenu.x"
      :y="rangeMenu.y"
      :items="rangeMenu.items"
      :on-close="() => (rangeMenu = null)"
    />

    <Teleport to="body">
      <Transition name="hl-digest-custom">
        <div
          v-if="showCustomPopover"
          ref="customPopoverRef"
          class="hl-digest-popover"
          :style="{ left: customPopoverPos.left + 'px', top: customPopoverPos.top + 'px' }"
        >
          <div class="hl-digest-popover-row">
            <span class="hl-digest-popover-label">{{ t("highlights.rangeFilter.customFrom") }}</span>
            <input type="date" v-model="customFrom" />
          </div>
          <div class="hl-digest-popover-row">
            <span class="hl-digest-popover-label">{{ t("highlights.rangeFilter.customTo") }}</span>
            <input type="date" v-model="customTo" />
          </div>
          <button
            type="button"
            class="s-btn primary hl-digest-popover-apply"
            :disabled="!customValid"
            @click="applyCustomRange"
          >
            {{ t("highlights.rangeFilter.apply") }}
          </button>
        </div>
      </Transition>
    </Teleport>

    <HighlightReviewList
      v-if="activeTab === 'review'"
      :all-rows="allRows"
      @select="onSelect"
      @menu="onMenu"
    />

    <div v-else class="list-scroll">
      <!-- Loading: subtle skeleton cards (mirrors ArticleList's sk-art rows). -->
      <div v-if="list.isPending.value">
        <div v-for="i in 5" :key="i" class="hl-skeleton">
          <div class="sk-bar" style="width: 92%" />
          <div class="sk-bar" style="width: 78%; height: 11px; margin-top: 7px" />
          <div class="sk-bar" style="width: 36%; height: 9px; margin-top: 12px" />
        </div>
      </div>

      <!-- Error: ArticleList-style alert glyph + retry. -->
      <div
        v-else-if="list.isError.value"
        class="empty"
        style="height: 260px"
      >
        <div class="glyph"><Icon name="alert" :size="22" /></div>
        <div>{{ t("highlights.loadError") }}</div>
        <button
          type="button"
          class="empty-retry"
          @click="list.refetch()"
          :disabled="list.isFetching.value"
        >
          <Icon name="refresh" :size="12" />
          {{ t("common.retry") }}
        </button>
      </div>

      <!-- Empty (no highlights yet, nothing filtered): mark glyph + headline + hint. -->
      <div
        v-else-if="rangeFiltered.length === 0 && debounced === '' && activeRange === 'all' && colorFilter === null"
        class="empty"
        style="height: 260px"
      >
        <div class="glyph"><Icon name="highlighter" :size="22" /></div>
        <div class="hl-empty-title">{{ t("highlights.empty") }}</div>
        <div class="hl-empty-hint">{{ t("highlights.emptyHint") }}</div>
      </div>

      <!-- Empty (no search match): smaller, with a clear-search button. -->
      <div
        v-else-if="rangeFiltered.length === 0 && debounced !== ''"
        class="empty"
        style="height: 260px"
      >
        <div class="glyph"><Icon name="search" :size="22" /></div>
        <div>{{ t("highlights.searchEmpty", { q: debounced }) }}</div>
        <button type="button" class="empty-retry" @click="search = ''">
          <Icon name="x" :size="12" />
          {{ t("highlights.clearSearch") }}
        </button>
      </div>

      <!-- Empty (color filter excludes everything). -->
      <div
        v-else-if="rangeFiltered.length === 0 && colorFilter !== null"
        class="empty"
        style="height: 260px"
      >
        <div class="glyph"><Icon name="highlighter" :size="22" /></div>
        <div>{{ t("highlights.colorEmpty") }}</div>
        <button type="button" class="empty-retry" @click="colorFilter = null">
          <Icon name="x" :size="12" />
          {{ t("highlights.clearColor") }}
        </button>
      </div>

      <!-- Empty (time-range filter excludes everything, search is empty). -->
      <div
        v-else-if="rangeFiltered.length === 0"
        class="empty"
        style="height: 260px"
      >
        <div class="glyph"><Icon name="clock" :size="22" /></div>
        <div>{{ t("highlights.rangeFilter.empty") }}</div>
        <button type="button" class="empty-retry" @click="activeRange = 'all'">
          <Icon name="x" :size="12" />
          {{ t("common.cancel") }}
        </button>
      </div>

      <!-- Flat list -->
      <ul v-else-if="!groupByArticle" class="hl-list">
        <li v-for="h in rangeFiltered" :key="h.id" :data-hl-row="h.id">
          <HighlightCard
            :highlight="h"
            :selected="h.id === selectedId"
            :checkable="true"
            :selecting="isSelecting"
            :checked="checked.has(h.id)"
            @select="onSelect"
            @menu="onMenu"
            @toggle="toggleCheck"
          />
        </li>
      </ul>

      <!-- Grouped by article — sticky article header per group, cards drop the
           per-row article title (it'd just repeat the group header). -->
      <div v-else>
        <section v-for="g in grouped" :key="g.bookId" class="hl-group">
          <header class="hl-group-head">
            <span class="hl-group-title">{{ g.bookTitle }}</span>
            <span class="hl-group-count">{{ g.items.length }}</span>
          </header>
          <ul class="hl-list">
            <li v-for="h in g.items" :key="h.id" :data-hl-row="h.id">
              <HighlightCard
                :highlight="h"
                :hide-article="true"
                :selected="h.id === selectedId"
                :checkable="true"
                :selecting="isSelecting"
                :checked="checked.has(h.id)"
                @select="onSelect"
                @menu="onMenu"
                @toggle="toggleCheck"
              />
            </li>
          </ul>
        </section>
      </div>
    </div>

    <!-- Multi-select action bar — floats bottom-center while ≥1 card is
         checked (browse tab only; the review tab's cards aren't checkable). -->
    <Transition name="hlsel-pop">
      <div
        v-if="isSelecting && activeTab === 'browse'"
        class="hlsel-bar"
        role="toolbar"
        :aria-label="t('highlights.selectedCount', { count: checked.size })"
      >
        <span class="hlsel-count">{{ t("highlights.selectedCount", { count: checked.size }) }}</span>
        <button type="button" class="s-btn" @click="selectAllVisible">
          {{ t("highlights.selectAll") }}
        </button>
        <button type="button" class="s-btn hlsel-del" @click="removeChecked">
          <Icon name="trash" :size="12" />
          {{ t("highlights.deleteSelected") }}
        </button>
        <button
          type="button"
          class="hlsel-close"
          :title="t('common.cancel')"
          :aria-label="t('common.cancel')"
          @click="clearChecks"
        >
          <Icon name="x" :size="13" />
        </button>
      </div>
    </Transition>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      :on-close="() => (menu = null)"
    />

    <div v-if="editingNote" class="modal-backdrop" @click.self="editingNote = null">
      <div
        ref="noteDialogRef"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="t('highlights.editTitle')"
        @click.stop
      >
        <h2>{{ t("highlights.editTitle") }}</h2>
        <textarea
          class="hl-note-input"
          v-model="editingNote.text"
          :placeholder="t('highlights.notePlaceholder')"
          rows="5"
        />
        <div class="modal-actions">
          <button class="s-btn" @click="editingNote = null">{{ t("common.cancel") }}</button>
          <button class="s-btn primary" @click="saveNote">{{ t("common.save") }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hl-pane { min-width: 0; position: relative; /* anchors the multi-select bar */ }
.hl-pane:focus { outline: none; }
.hl-pane:focus-visible { outline: none; }

/* ── Multi-select action bar ── */
.hlsel-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  background: var(--panel-2);
  border: 1px solid var(--hair-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-pop);
  z-index: 10;
}
.hlsel-count {
  font-size: 12.5px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.hlsel-del {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--danger);
  border-color: var(--danger-line);
}
.hlsel-del:hover { background: var(--danger-soft); }
.hlsel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.hlsel-close:hover { color: var(--ink); background: var(--hover); }
.hlsel-pop-enter-active,
.hlsel-pop-leave-active { transition: opacity .16s ease, transform .16s cubic-bezier(.2, .7, .3, 1); }
.hlsel-pop-enter-from,
.hlsel-pop-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }

.hl-tabs {
  display: flex;
  gap: 18px;
  margin-top: 12px;
  border-bottom: 1px solid var(--hair);
}
.hl-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0 1px 9px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color .12s;
}
.hl-tab:hover { color: var(--ink-2); }
.hl-tab::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0;
  transform: scaleX(0.6);
  transition: opacity .12s, transform .12s;
}
.hl-tab.active { color: var(--ink); font-weight: 600; }
.hl-tab.active::after { opacity: 1; transform: scaleX(1); }

/* Custom-range picker — a floating popover anchored under the time-range
   dropdown button (TagPicker.vue's pattern: position:fixed, clamped into
   the viewport by the script, teleported to <body> so it isn't clipped by
   this pane's own overflow ancestors). Ported 1:1 from the old
   HighlightDigestList.vue tab body, which used the identical layout. */
.hl-digest-popover {
  position: fixed;
  z-index: 300;
  width: 236px;
  background: var(--paper);
  border: 1px solid var(--hair-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-pop);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hl-digest-popover-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* Fixed label column so both date inputs line up on the same left edge,
   instead of space-between stretching a gap between a short label and a
   right-pinned input. */
.hl-digest-popover-label {
  flex: 0 0 34px;
  font-size: 12.5px;
  color: var(--muted);
}
.hl-digest-popover-row input[type="date"] {
  flex: 1;
  font: inherit;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--panel-2);
  border: 1px solid var(--hair);
  border-radius: 6px;
  padding: 5px 8px;
  transition: border-color 0.12s;
}
.hl-digest-popover-row input[type="date"]:focus-visible {
  outline: none;
  border-color: color-mix(in oklch, var(--accent) 50%, var(--hair-strong));
}
.hl-digest-popover-apply {
  margin-top: 2px;
  justify-content: center;
  width: 100%;
}
.hl-digest-popover-apply:disabled { opacity: 0.45; cursor: not-allowed; }

.hl-digest-custom-enter-active,
.hl-digest-custom-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.hl-digest-custom-enter-from,
.hl-digest-custom-leave-to { opacity: 0; transform: translateY(-6px) scale(0.98); }

.list-meta-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.list-meta-btn[disabled]:hover { background: transparent; color: var(--muted); }

/* Color filter dots — five compact circles tinted with each highlight
   palette colour. Active dot grows a thin accent ring; disabled dots
   (no highlights of that colour) fade. */
.hl-color-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  border-left: 1px solid var(--hair);
  margin-left: 2px;
  height: 22px;
}
.hl-color-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 0;
  padding: 0;
  background: var(--dot);
  cursor: pointer;
  position: relative;
  opacity: 0.7;
  transition: opacity .12s, transform .12s, box-shadow .12s;
}
.hl-color-dot:hover { opacity: 1; transform: scale(1.08); }
.hl-color-dot.on {
  opacity: 1;
  box-shadow: 0 0 0 2px var(--panel-2), 0 0 0 3.5px var(--accent);
}
.hl-color-dot[disabled] {
  opacity: 0.2;
  cursor: not-allowed;
}
.hl-color-dot[disabled]:hover { transform: none; }

/* Skeleton (loading): matches ArticleList's sk-art bars but row-shaped. */
.hl-skeleton {
  padding: var(--row-py) var(--list-px);
  border-bottom: 1px solid var(--hair);
}
.sk-bar {
  height: 13px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--hover) 25%, var(--selected) 50%, var(--hover) 75%);
  background-size: 200% 100%;
  animation: sk 1.3s ease infinite;
}
</style>
