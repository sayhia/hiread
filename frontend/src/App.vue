<script setup lang="ts">
// Root shell: the two-pane window (Sidebar | Library) with the reader as a
// full-screen overlay, the modal stack, the appearance/startup effects, the
// global keyboard map, and the toast region.

import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Events } from "@wailsio/runtime";
import * as api from "./api";
import { useUi, PANEL_BOUNDS, type DarkShade } from "./stores/ui";
import { resolveAccent } from "./lib/accents";
import { resolveReaderFont, resolveUiFont, fontFaceCss } from "./lib/fonts";
import { inkFor } from "./lib/paper";
import { useToasts, toast as toastApi, reportError } from "./stores/toasts";
import { checkForUpdates } from "./lib/updater";
import { isMac } from "./lib/platform";
import Sidebar from "./components/Sidebar.vue";
import Library from "./components/Library.vue";
const HighlightsPane = defineAsyncComponent(() => import("./components/HighlightsPane.vue"));
const AIAssistant = defineAsyncComponent(() => import("./components/AIAssistant.vue"));
// Dialogs render only when opened — load their (heavy, multi-section) code on
// first open rather than at startup.
const SettingsDialog = defineAsyncComponent(() => import("./components/SettingsDialog.vue"));
const BookDetailsDialog = defineAsyncComponent(() => import("./components/BookDetailsDialog.vue"));
// The reader pulls in the whole reading stack — text + PDF (pdf.js) readers,
// translation/speech/auto-scroll, highlights, TOC. Load it on first open, not
// at startup; the reader already shows a skeleton while the book loads.
const Reader = defineAsyncComponent(() => import("./components/reader/Reader.vue"));
// The palette is a modal summoned by ⌘K; its fuzz + command list can wait.
const CommandPalette = defineAsyncComponent(() => import("./components/CommandPalette.vue"));
import ResizeHandle from "./components/ResizeHandle.vue";
import Icon from "./components/Icon.vue";

const { t } = useI18n();
const qc = useQueryClient();
const ui = useUi();
const toasts = useToasts();

// Accent palettes live in lib/accents.ts, shared with the Appearance settings
// swatches so the picker always shows exactly what gets applied. Hiread's set
// is the cool azure/cyan/indigo/slate family.
const DARK_PAPER: Record<DarkShade, string> = { default: "#0C121C", dimmer: "#080D14", black: "#000000" };

const cpOpen = ref(false);
const settings = reactive<{ open: boolean; section?: string }>({ open: false });
const detailsId = ref<number | null>(null);
const aiAssistant = reactive<{ open: boolean; mode: "ask" | "chat" }>({ open: false, mode: "chat" });
const libraryRef = ref<InstanceType<typeof Library> | null>(null);
const overlayRef = ref<HTMLElement | null>(null);
let readerRestoreFocus: HTMLElement | null = null;
const modalOverReader = computed(
  () => cpOpen.value || settings.open || aiAssistant.open || detailsId.value != null,
);

const showToast = toastApi.show;

// ── platform → document root ──
// macOS overlays the traffic-light buttons on the webview's top-left; the
// sidebar/list-header reserve a top strip via `:root[data-platform="mac"]`
// CSS rules, so this attribute MUST be set or the brand row sits under the
// traffic lights.
document.documentElement.dataset.platform = isMac ? "mac" : "other";

// ── appearance → document root ──
watch(
  // The *resolved* theme (auto → light/dark, live via prefers-color-scheme):
  // stamping the raw "auto" pref onto data-theme would match no CSS rule and
  // leave the app light on a dark OS, and it must re-run when the OS flips.
  () => [ui.resolvedTheme, ui.darkShade, ui.accent, ui.customAccent, ui.density],
  () => {
    const root = document.documentElement;
    root.dataset.theme = ui.resolvedTheme;
    root.dataset.darkShade = ui.darkShade;
    root.dataset.density = ui.density;
    const a = resolveAccent(ui.accent, ui.customAccent);
    const dark = ui.resolvedTheme === "dark";
    root.style.setProperty("--accent", dark ? a.dAccent : a.accent);
    root.style.setProperty("--accent-soft", dark ? a.dSoft : a.soft);
    root.style.setProperty("--accent-ink", dark ? a.dInk : a.ink);
    // Mirror the theme's paper colour onto the native window backing, so the
    // strip a fast macOS resize exposes beyond the webview's last frame
    // matches the theme instead of flashing light paper in dark mode.
    const hex = dark ? DARK_PAPER[ui.darkShade] : "#E8E6E1";
    const n = parseInt(hex.slice(1), 16);
    api.setWindowBackground((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff).catch(() => {});
  },
  { immediate: true },
);

watch(
  () => ui.iconMark,
  (href) => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = href;
  },
  { immediate: true },
);

watch(
  () => ui.prefs.reduceMotion,
  (v) => {
    document.documentElement.dataset.reduceMotion = String(v);
  },
  { immediate: true },
);

// Focus mode is fullscreen, but also a quieter page: the chrome steps aside
// until the reader reaches for it. Stamped on the root so the overlay's close
// button and both reading screens can hide on the same signal.
watch(
  () => ui.focusMode,
  (v) => {
    document.documentElement.dataset.focus = String(v);
  },
  { immediate: true },
);

// ── reading surface: its own paper, independent of the app's theme ──
// A reader wants a warm page at night without the whole app turning beige, so
// this is stamped separately from data-theme and only the reading sheet reads
// it. "theme" means "whatever the app is", which is what it always did.
watch(
  () => [
    ui.readerPaper,
    ui.readerPaperCustom,
    ui.readerInk,
    ui.readerInkCustom,
    ui.readerJustify,
    ui.readerTypeset,
    ui.readerDropCap,
    ui.readerIndent,
    ui.readerEndMark,
    ui.readerColSep,
    ui.readerOrientation,
    ui.readerGrayscale,
    ui.readerColumns,
    ui.readerLineNumbers,
    ui.readerTexture,
    ui.prefs.trimBlankParagraphs,
  ],
  () => {
    const root = document.documentElement;
    root.dataset.readerPaper = ui.readerPaper;
    root.dataset.readerInk = ui.readerInk;
    root.dataset.readerAlign = ui.readerJustify ? "justify" : "start";
    root.dataset.readerTypeset = String(ui.readerTypeset);
    root.dataset.readerDropCap = String(ui.readerDropCap);
    // Always stamp, including 0em: a missing variable used to fall back to
    // 2em on book / 古籍 first paragraphs, so the slider at 0 still indented.
    root.style.setProperty("--reader-indent", `${ui.readerIndent}em`);
    root.dataset.readerEndMark = String(ui.readerEndMark);
    root.dataset.readerColSep = String(ui.readerColSep);
    root.dataset.readerOrientation = String(ui.readerOrientation);
    root.dataset.readerGray = String(ui.readerGrayscale);
    root.dataset.readerBlanks = ui.prefs.trimBlankParagraphs ? "off" : "on";
    root.dataset.readerTexture = String(ui.readerTexture);
    root.style.setProperty("--reader-columns", String(ui.readerColumns));
    root.dataset.readerLineNumbers = String(ui.readerLineNumbers);
    root.dataset.readerColumns = String(ui.readerColumns);
    // A custom page colour asks only for the ground; the ink follows it.
    const paper = inkFor(ui.readerPaperCustom);
    root.style.setProperty("--reader-custom-bg", ui.readerPaperCustom);
    root.style.setProperty("--reader-custom-ink", paper.ink);
    root.style.setProperty("--reader-custom-ink-2", paper.ink2);
    root.style.setProperty("--reader-custom-muted", paper.muted);
    root.style.setProperty("--reader-custom-hair", paper.hair);
    // A custom ink colour is the reader's own choice, taken as it is: it is
    // not a page ground, so nothing is derived to "keep it readable". The
    // supporting tones are the same colour, washed toward the paper (CSS).
    root.style.setProperty("--reader-ink-custom", ui.readerInkCustom);
  },
  { immediate: true },
);

// ── draggable pane width → CSS var ──
watch(
  () => ui.sidebarWidth,
  (w) => {
    document.documentElement.style.setProperty("--col-sidebar", `${w}px`);
  },
  { immediate: true },
);

// ── reader typography → CSS vars ──
watch(
  () => [
    ui.readerFont,
    ui.readerSize,
    ui.readerLeading,
    ui.readerTracking,
    ui.readerParaGap,
    ui.readerPadX,
    ui.readerPadY,
    ui.readerWarmth,
    ui.installedFonts,
  ],
  () => {
    const root = document.documentElement.style;
    const font = resolveReaderFont(ui.readerFont, ui.installedFonts);
    root.setProperty("--reader-font", font.stack);
    root.setProperty("--reader-font-adjust", font.adjust);
    root.setProperty("--reader-size", `${ui.readerSize}px`);
    root.setProperty("--reader-leading", `${ui.readerLeading}px`);
    // Measure stays off :root — the top bar must not see it change. The
    // reading column sets --reader-width on .reader-scroll instead.
    // Stored as pixels so a tick of the slider is a gap the eye can see.
    // (It used to be thousandths of an em — 3/1000em at 17px is a fiftieth
    // of a pixel, which is why the control felt broken.)
    root.setProperty("--reader-tracking", `${ui.readerTracking}px`);
    root.setProperty("--reader-para-gap", `${ui.readerParaGap}px`);
    root.setProperty("--reader-pad-x", `${ui.readerPadX}px`);
    root.setProperty("--reader-pad-y", `${ui.readerPadY}px`);
    root.setProperty("--reader-warmth", String(ui.readerWarmth / 100));
  },
  { immediate: true },
);

// ── UI font → CSS var ──
watch(
  () => [ui.uiFont, ui.installedFonts],
  () => {
    const root = document.documentElement.style;
    const stack = resolveUiFont(ui.uiFont, ui.installedFonts);
    if (stack) root.setProperty("--ui", stack);
    else root.removeProperty("--ui");
  },
  { immediate: true },
);

// ── @font-face block for downloaded fonts ──
// Downloaded fonts are files served by the Go middleware at /userfonts/<file>;
// a `@font-face { src: url(...) }` block registers the family with the browser
// so `font-family: '<family>'` in the resolved stacks actually finds a face.
watch(
  () => ui.installedFonts,
  (installed) => {
    const id = "hl-fontface";
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = fontFaceCss(installed);
  },
  { immediate: true, deep: true },
);

// ── toast dwell timer ──
// One live timer at a time: clear the previous toast's dwell timer before
// arming the next, so a stale timer can't dismiss a freshly-shown toast early.
// Hover / focus pauses the remaining dwell so the pill can be read or the
// Undo button reached; the withUndo commit timer is independent and keeps
// running even if a later toast is queued behind the action pill.
let toastTimer: number | undefined;
let toastRemain = 0;
let toastStarted = 0;
let toastPaused = false;
let toastHover = false;
let toastFocus = false;

function clearToastTimer() {
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = undefined;
}

function armToastTimer(ms: number) {
  clearToastTimer();
  toastRemain = ms;
  toastStarted = performance.now();
  toastTimer = window.setTimeout(() => {
    toastTimer = undefined;
    const cur = toasts.current;
    if (cur) toasts.dismiss(cur.id);
  }, ms);
}

function pauseToastTimer() {
  if (toastPaused || toastTimer == null) return;
  toastPaused = true;
  toastRemain = Math.max(0, toastRemain - (performance.now() - toastStarted));
  clearToastTimer();
}

function resumeToastTimer() {
  if (!toastPaused) return;
  toastPaused = false;
  if (!toasts.current) return;
  armToastTimer(toastRemain);
}

function onToastPointerEnter() {
  toastHover = true;
  pauseToastTimer();
}
function onToastPointerLeave() {
  toastHover = false;
  if (!toastFocus) resumeToastTimer();
}
function onToastFocusIn() {
  toastFocus = true;
  pauseToastTimer();
}
function onToastFocusOut(e: FocusEvent) {
  const root = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
  toastFocus = false;
  if (!toastHover) resumeToastTimer();
}

watch(
  () => toasts.current,
  (cur) => {
    toastHover = false;
    toastFocus = false;
    toastPaused = false;
    clearToastTimer();
    if (!cur) return;
    armToastTimer(cur.duration);
  },
);

// The reader is a full-screen overlay over the shelf. While it is up, the
// window behind it must not take Tab (or a screen reader) — inert + aria-hidden
// park the two-pane chrome, and focus moves into the overlay on open.
watch(
  () => ui.selectedBookId,
  (id, prev) => {
    if (id != null && prev == null) {
      const ae = document.activeElement;
      readerRestoreFocus = ae instanceof HTMLElement ? ae : null;
      nextTick(() => overlayRef.value?.focus());
    } else if (id == null && prev != null) {
      const el = readerRestoreFocus;
      readerRestoreFocus = null;
      nextTick(() => {
        if (el?.isConnected) el.focus();
      });
    }
  },
);

function openSettings(section?: string) {
  settings.open = true;
  settings.section = section;
}

/** Restore the shelf the user chose to land on. "last" replays the selection
 *  persisted by ui.select. */
function applyStartupView() {
  const view = ui.prefs.startupView;
  if (view === "last") {
    const raw = localStorage.getItem("lastView");
    if (raw) {
      try {
        const { query, label, name, pane } = JSON.parse(raw);
        if (pane === "highlights") {
          ui.showHighlights();
          return;
        }
        if (query?.kind) {
          ui.select(query, name || label || t("smart.all"));
          return;
        }
      } catch {
        // A corrupt entry just falls through to the default shelf.
      }
    }
    ui.select({ kind: "all" }, t("smart.all"));
    return;
  }
  if (view === "highlights") {
    ui.showHighlights();
    return;
  }
  const labels = {
    all: "smart.all",
    reading: "smart.reading",
    favorite: "smart.favorite",
    finished: "smart.finished",
  } as const;
  ui.select({ kind: view }, t(labels[view]));
}

function onOpenHighlight(payload: { highlightId: number; bookId: number; chapterIndex: number }) {
  ui.openHighlight(payload.highlightId, payload.bookId, payload.chapterIndex);
}

/** A ⌘K passage hit opens its book at the chapter the passage lives in. */
function onNavigateHit(payload: { bookId: number; chapterIndex: number; snippet?: string }) {
  ui.openBookAt(payload.bookId, payload.chapterIndex, payload.snippet);
}

function closeReader() {
  ui.openBook(null);
  qc.invalidateQueries({ queryKey: ["books"] });
}

function handleCommand(action: string) {
  switch (action) {
    case "add-books":
      libraryRef.value?.pickBooks();
      break;
    case "settings":
      openSettings();
      break;
    case "ai":
      aiAssistant.mode = "chat";
      aiAssistant.open = true;
      break;
    case "focus":
      ui.setFocusMode(!ui.focusMode);
      break;
    case "highlights":
      ui.showHighlights();
      break;
  }
}

// ── global keyboard shortcuts ──
function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  const inField = tag === "INPUT" || tag === "TEXTAREA";
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const isCp = !!document.querySelector(".cp-backdrop");
    if (!isCp && document.querySelector(".settings-backdrop, .modal-backdrop, .tag-picker, .hl-popover, .image-viewer")) return;
    cpOpen.value = !cpOpen.value;
    return;
  }
  if (mod && e.key === ",") {
    e.preventDefault();
    // Settings open + a nested confirm/prompt: do not toggle Settings closed
    // (that would tear the confirm down with it). Same gate Settings itself
    // uses for Escape.
    if (document.querySelector(".settings-backdrop") && document.querySelector(".modal-backdrop, .prompt-dialog")) return;
    const isSettings = !!document.querySelector(".settings-backdrop");
    if (!isSettings && document.querySelector(".cp-backdrop, .modal-backdrop, .tag-picker, .hl-popover, .image-viewer")) return;
    settings.open = !settings.open;
    return;
  }
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    if (document.querySelector(".settings-backdrop, .cp-backdrop, .modal-backdrop, .tag-picker, .hl-popover, .image-viewer")) return;
    libraryRef.value?.pickBooks();
    return;
  }
  if (mod && e.key.toLowerCase() === "f") {
    if (ui.selectedBookId == null) return;
    e.preventDefault();
    if (document.querySelector(".settings-backdrop, .cp-backdrop, .modal-backdrop, .image-viewer")) return;
    ui.requestTocSearch();
    return;
  }
  if (mod) return;
  if (inField) return;
  if (document.querySelector(".cp-backdrop, .settings-backdrop, .modal-backdrop, .ctx-menu, .tag-picker, .hl-popover, .image-viewer")) return;

  // App-wide keys that must keep working with a book open. The reader owns the
  // rest of the keyboard while it is up — but these three were listed as
  // global / view shortcuts and then quietly dead inside the reader, because
  // the early return below used to sit *before* them. Appearance, focus mode,
  // and the command palette are not chapter navigation.
  if (e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    ui.setTheme(ui.resolvedTheme === "dark" ? "light" : "dark");
    return;
  }
  if (!e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    ui.setFocusMode(!ui.focusMode);
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    if (ui.selectedBookId != null) ui.requestTocSearch();
    else cpOpen.value = true;
    return;
  }

  // Everything else belongs to the reader while a book is open.
  if (ui.selectedBookId != null) return;
}

const offs: (() => void)[] = [];

onMounted(() => {
  applyStartupView();

  // FontService.ListInstalled reads the installed_fonts table, which @font-face
  // and the family resolvers depend on; without this seed a fresh open shows
  // every "downloaded:…" choice as its fallback tail.
  api.listInstalledFonts().then(ui.setInstalledFonts).catch(() => {});

  // Keep the local fullscreen flag in step with the real window state, which
  // the user can also change natively (green traffic light, F11).
  api.isFullscreen().then((v) => (ui.focusMode = v)).catch(() => {});

  offs.push(
    Events.On("tray-open-settings", () => openSettings()),
    Events.On("tray-add-books", () => libraryRef.value?.pickBooks()),
  );

  window.setTimeout(() => void checkForUpdates(true), 4000);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  for (const off of offs) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
});
</script>

<template>
  <div class="app-shell">
    <div
      class="window"
      :class="{ focus: ui.focusMode }"
      :inert="ui.selectedBookId != null"
      :aria-hidden="ui.selectedBookId != null ? true : undefined"
    >
      <Sidebar
        @add-books="libraryRef?.pickBooks()"
        @open-settings="openSettings"
        @search-click="cpOpen = true"
        @select-highlights="ui.showHighlights()"
        @ai-assistant="aiAssistant.mode = 'chat'; aiAssistant.open = true"
      />
      <HighlightsPane v-if="ui.middlePane === 'highlights'" @open-highlight="onOpenHighlight" />
      <Library
        v-show="ui.middlePane === 'library'"
        ref="libraryRef"
        @toast="(s: string) => showToast(s)"
        @details="(id: number) => (detailsId = id)"
      />
      <!-- Sidebar resize handle at the rail+panel | grid boundary. Hidden in
           focus mode (the sidebar and grid collapse to the reader). -->
      <div
        v-if="!ui.focusMode"
        class="resize-handle-slot"
        :style="{ left: 'calc(var(--col-rail) + var(--col-sidebar))' }"
      >
        <ResizeHandle
          :width="ui.sidebarWidth"
          side="right"
          :min="PANEL_BOUNDS.sidebar.min"
          :max="PANEL_BOUNDS.sidebar.max"
          :label="t('app.resizeSidebar')"
          @resize="(w: number) => ui.setPanel({ sidebarWidth: w })"
        />
      </div>
    </div>
  </div>

  <!-- Full-screen reading overlay. Esc / ✕ closes. -->
  <div
    v-if="ui.selectedBookId != null"
    ref="overlayRef"
    class="reader-overlay"
    tabindex="-1"
    role="dialog"
    :aria-label="t('library.read')"
    :inert="modalOverReader"
    :aria-hidden="modalOverReader || undefined"
  >
    <Reader
      @toast="(s: string) => showToast(s)"
      @open-settings="(s?: string) => openSettings(s)"
      @close="closeReader"
    />
    <button
      class="reader-overlay-close"
      @click="closeReader"
      :title="t('common.close')"
      :aria-label="t('common.close')"
    >
      <Icon name="x" :size="16" />
    </button>
  </div>

  <CommandPalette
    :open="cpOpen"
    @close="cpOpen = false"
    @action="handleCommand"
    @navigate-book="ui.openBook"
    @navigate-hit="onNavigateHit"
  />

  <SettingsDialog
    v-if="settings.open"
    :initial-section="settings.section"
    @close="settings.open = false"
  />

  <BookDetailsDialog
    v-if="detailsId != null"
    :book-id="detailsId"
    @close="detailsId = null"
  />

  <AIAssistant
    v-if="aiAssistant.open"
    :initial-mode="aiAssistant.mode"
    :book-id="ui.selectedBookId"
    @close="aiAssistant.open = false"
    @open-settings="(s?: string) => { aiAssistant.open = false; openSettings(s); }"
  />

  <div role="status" aria-live="polite">
    <div
      v-if="toasts.current"
      :key="toasts.current.id"
      class="toast"
      :class="{ 'toast-error': toasts.current.tone === 'error' }"
      @pointerenter="onToastPointerEnter"
      @pointerleave="onToastPointerLeave"
      @focusin="onToastFocusIn"
      @focusout="onToastFocusOut"
    >
      <span v-if="toasts.current.tone === 'error'" class="toast-ico" aria-hidden="true">
        <Icon name="alert" :size="14" />
      </span>
      <span class="toast-text">{{ toasts.current.text }}</span>
      <kbd v-if="toasts.current.kbd" aria-hidden="true">{{ toasts.current.kbd }}</kbd>
      <button
        v-if="toasts.current.action"
        class="toast-action"
        @click="toasts.current.action.run(); toasts.dismiss(toasts.current.id)"
      >
        {{ toasts.current.action.label }}
      </button>
      <button
        v-if="toasts.current.tone === 'error' || toasts.current.action"
        class="toast-dismiss"
        :aria-label="t('common.close')"
        @click="toasts.dismiss(toasts.current.id)"
      >
        <Icon name="x" :size="13" />
      </button>
    </div>
  </div>
</template>
