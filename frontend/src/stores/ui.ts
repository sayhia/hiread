// Global UI state (Pinia). Server data (books, chapters…) lives in Vue Query;
// this store holds view selection plus the appearance preferences the settings
// controls drive.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import i18n from "../i18n";
import * as api from "../api";
import type { BookSort, LibraryQuery } from "../types";
import type { InstalledFont } from "../../bindings/hiread/internal/db/models";
import { APP_ICONS, iconPng, iconSvg, type AppIcon } from "../lib/appIcon";
import { READER_DEFAULTS, READER_INK_KEYS, READER_PAPER_KEYS, TEXTURE_KEYS, type ReaderInk, type ReaderPaper, type ReaderTexture } from "../lib/readerSettings";
import {
  BOUNDS,
  PER_BOOK_KEYS,
  READING_SETTINGS,
  STEPS,
  migrateLeading,
  migrateParaGap,
  migrateTracking,
  settingOf,
  type NamedStep,
  type ReadingSettingKey,
  type Setting,
} from "../lib/reading/schema";

export type { ReaderPaper } from "../lib/readerSettings";
export type { AppIcon } from "../lib/appIcon";

export type Theme = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";
export type DarkShade = "default" | "dimmer" | "black";
export type Accent =
  | "azure" | "cyan" | "emerald" | "indigo" | "violet" | "slate"
  | "amber" | "vermilion"
  // "custom" pairs with the customAccent hex below.
  | "custom";

/** Every accent key the store accepts (persistence whitelist + picker order). */
export const ACCENT_KEYS = [
  "azure", "cyan", "emerald", "indigo", "violet", "slate",
  "amber", "vermilion", "custom",
] as const;
export type Density = "compact" | "cozy" | "spacious";
/** How the library grid draws a book: a cover wall, or a denser list row. */
export type ViewMode = "grid" | "list";
export type StartupView = "all" | "reading" | "favorite" | "finished" | "highlights" | "last";
export type ReaderFont = "serif" | "sans" | "hyperlegible";

export const READER_FONTS: Record<ReaderFont, { stack: string; adjust: string }> = {
  serif: { stack: "var(--serif)", adjust: "0px" },
  sans: { stack: "var(--ui)", adjust: "-1.5px" },
  hyperlegible: { stack: "'Atkinson Hyperlegible', var(--ui)", adjust: "-1.5px" },
};

export const READER_BOUNDS = {
  size: BOUNDS.readerSize,
  leading: BOUNDS.readerLeading,
  width: BOUNDS.readerWidth,
  /** Letter spacing in thousandths of an em. Negative tightens. */
  tracking: BOUNDS.readerTracking,
  /** Space after a paragraph, in hundredths of an em. */
  paraGap: BOUNDS.readerParaGap,
  /** The sheet's own margins: how far the text sits from its edges. */
  padX: BOUNDS.readerPadX,
  padY: BOUNDS.readerPadY,
  // These two were clamped by numbers written inline where the ref is made,
  // and nowhere else — which is how the schema found them.
  warmth: BOUNDS.readerWarmth,
  autoSpeed: BOUNDS.readerAutoSpeed,
} as const;

/** Named type sizes. A reader picks "large", not 19 pixels — but the pixels
 *  stay available, so a size between two steps is not thrown away. */
/** Named type sizes. A reader picks "large", not 19 pixels — but the pixels
 *  stay available, so a size between two steps is not thrown away. */
export const READER_SIZE_STEPS = STEPS.readerSize as readonly NamedStep[];

/** Valid ranges for the draggable pane widths — shared by the resize handles,
 *  persistence validation, and the `setPanel` write guard so they stay in
 *  lockstep. `sidebar` is the panel width (the fixed icon rail is separate); the
 *  AI drawer can grow wide but never crowd out the reading sheet. The library
 *  grid is a `1fr` column (it auto-fills), so it has no width handle. */
export const PANEL_BOUNDS = {
  sidebar: { min: 180, max: 360 },
  ai: { min: 280, max: 560 },
} as const;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface Prefs {
  showSidebarCounts: boolean;
  /** Draw cover art in the library grid; off falls back to a typographic card. */
  showCovers: boolean;
  reduceMotion: boolean;
  showReadingTime: boolean;
  // Show the in-chapter Original / Bilingual / Translation switch above a
  // translated body (the toolbar popover always offers it; this is the optional
  // always-visible shortcut).
  showTransSwitch: boolean;
  /** Drop the empty paragraphs a badly converted book uses to fake spacing. */
  trimBlankParagraphs: boolean;
  /** Reaching the end of a chapter turns to the next one automatically. */
  autoAdvanceChapter: boolean;
  /** Finishing the last chapter marks the book as read. */
  markFinishedAtEnd: boolean;
  startupView: StartupView;
}

const ls = {
  oneOf: <T extends string>(k: string, allowed: readonly T[], fallback: T): T => {
    const v = localStorage.getItem(k);
    return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  },
  num: (k: string, fallback: number, min: number, max: number) => {
    const v = localStorage.getItem(k);
    if (v == null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max);
  },
  bool: (k: string, fallback: boolean) => {
    const v = localStorage.getItem(k);
    return v == null ? fallback : v === "1";
  },
  // A #rrggbb hex — the shape <input type="color"> emits; anything else
  // (corrupt value, older format) falls back rather than reaching the CSS.
  hex: (k: string, fallback: string) => {
    const v = localStorage.getItem(k);
    return v != null && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  },
  set: (k: string, v: string | number | boolean) =>
    localStorage.setItem(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)),
};

const PREF_KEYS: (keyof Prefs)[] = [
  "showSidebarCounts",
  "showCovers",
  "reduceMotion",
  "showReadingTime",
  "showTransSwitch",
  "trimBlankParagraphs",
  "autoAdvanceChapter",
  "markFinishedAtEnd",
  "startupView",
];

function mirrorTheme(theme: ResolvedTheme): void {
  // Mirror the *resolved* theme (auto → light/dark) so the native launch
  // background tracks the effective appearance, not the abstract preference.
  api.setSetting("theme", theme).catch(() => {});
}

// Watches `prefers-color-scheme: dark` so the "auto" theme can follow the OS
// without a reload. Returns a ref that reflects the live media-query state and
// stays subscribed for the lifetime of the app — Pinia stores are singletons.
function watchSystemDark(): { prefersDark: import("vue").Ref<boolean> } {
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const prefersDark = ref<boolean>(mq?.matches ?? false);
  if (mq) {
    const onChange = (e: MediaQueryListEvent) => { prefersDark.value = e.matches; };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof (mq as any).addListener === "function") (mq as any).addListener(onChange);
  }
  return { prefersDark };
}
function mirrorDarkShade(shade: DarkShade): void {
  api.setSetting("dark_shade", shade).catch(() => {});
}

function loadReaderFont(): string {
  // Any stored value is valid: a bundled key, "system:<name>", or
  // "downloaded:<id>" — the resolver maps an unknown/deleted one back to a
  // bundled face. Empty falls back to the legacy serif flag, else sans (hiread's
  // cool-tech default).
  const v = localStorage.getItem("readerFont");
  if (v) return v;
  return localStorage.getItem("useSerif") === "1" ? "serif" : "sans";
}

function loadPrefs(): Prefs {
  return {
    showSidebarCounts: ls.bool("pref.showSidebarCounts", true),
    showCovers: ls.bool("pref.showCovers", true),
    reduceMotion: ls.bool(
      "pref.reduceMotion",
      typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    showReadingTime: ls.bool("pref.showReadingTime", true),
    showTransSwitch: ls.bool("pref.showTransSwitch", false),
    trimBlankParagraphs: ls.bool("pref.trimBlankParagraphs", true),
    autoAdvanceChapter: ls.bool("pref.autoAdvanceChapter", true),
    markFinishedAtEnd: ls.bool("pref.markFinishedAtEnd", true),
    startupView: ls.oneOf<StartupView>(
      "pref.startupView",
      ["all", "reading", "favorite", "finished", "highlights", "last"],
      "reading",
    ),
  };
}

export const useUi = defineStore("ui", () => {
  const query = ref<LibraryQuery>({ kind: "all" });
  /** Custom name for a collection/tag/format view. Smart shelves are i18n. */
  const queryName = ref("");
  const queryLabel = computed(() => {
    void (i18n.global.locale as { value?: string }).value;
    switch (query.value.kind) {
      case "all":
        return i18n.global.t("smart.all");
      case "reading":
        return i18n.global.t("smart.reading");
      case "favorite":
        return i18n.global.t("smart.favorite");
      case "finished":
        return i18n.global.t("smart.finished");
      default:
        return queryName.value || i18n.global.t("smart.all");
    }
  });
  const selectedBookId = ref<number | null>(null);
  /** Free-text filter over title and author, applied to the grid as it is typed. */
  const filterText = ref("");
  const bookSort = ref<BookSort>(
    ls.oneOf<BookSort>("bookSort", ["recent", "added", "title", "author", "progress"], "recent"),
  );
  const middlePane = ref<"library" | "highlights">("library");
  const pendingHighlightId = ref<number | null>(null);
  /** The chapter the reader should open at, set alongside pendingHighlightId
   *  (and by a search hit) so the reader lands on the right chapter rather than
   *  wherever reading last stopped. */
  const pendingChapterIndex = ref<number | null>(null);
  /** Passage text from ⌘K / TOC search, so the reader can scroll to the hit. */
  const pendingSnippet = ref<string | null>(null);
  /** Bumped when ⌘F / in-book find should open the contents search. */
  const tocSearchTick = ref(0);
  function requestTocSearch() {
    tocSearchTick.value += 1;
  }

  const theme = ref<Theme>(ls.oneOf<Theme>("theme", ["light", "dark", "auto"], "light"));
  const { prefersDark } = watchSystemDark();
  const resolvedTheme = computed<ResolvedTheme>(() =>
    theme.value === "auto" ? (prefersDark.value ? "dark" : "light") : theme.value,
  );
  const darkShade = ref<DarkShade>(ls.oneOf<DarkShade>("darkShade", ["default", "dimmer", "black"], "default"));
  const accent = ref<Accent>(ls.oneOf<Accent>("accent", ACCENT_KEYS, "azure"));
  // Official app mark: night / dawn / gold / platinum.
  const appIcon = ref<AppIcon>(ls.oneOf<AppIcon>("appIcon", APP_ICONS, "night"));
  const iconSrc = computed(() => iconPng(appIcon.value));
  const iconMark = computed(() => iconSvg(appIcon.value));
  // The user-picked hex behind the "custom" accent. Kept even while a preset
  // is active so re-selecting custom restores the last pick.
  const customAccent = ref<string>(ls.hex("customAccent", "#3f76e4"));
  const density = ref<Density>(ls.oneOf<Density>("density", ["compact", "cozy", "spacious"], "cozy"));
  const viewMode = ref<ViewMode>(ls.oneOf<ViewMode>("viewMode", ["grid", "list"], "grid"));
  const readerFont = ref<string>(loadReaderFont());
  const uiFont = ref<string>(localStorage.getItem("uiFont") ?? "default");
  // Downloaded fonts (from the backend) — used to resolve a "downloaded:<id>"
  // choice to its family and to drive the @font-face block. App.vue seeds this
  // on mount and refreshes it after a download / delete.
  const installedFonts = ref<InstalledFont[]>([]);
  // ── reading profile ──────────────────────────────────────────────────
  // The reading settings below are the *effective* ones: what the page is
  // using right now. They normally come from, and write back to, one global
  // set. A book can opt out of that and keep its own — a dense reference book
  // wants a different measure from a novel — in which case, for as long as it
  // is open, every one of these reads and writes under its own keys.
  //
  // That is the whole rule, and it is what makes the panel unambiguous: the
  // panel always changes what you are looking at. Turning a book's own
  // settings off deletes them and the page falls back to the global set.
  const profileBookId = ref<number | null>(null);
  const perBook = computed(() => profileBookId.value != null);
  const profileKey = (name: string) =>
    profileBookId.value != null ? `book${profileBookId.value}.${name}` : name;
  /** Every setting a book may hold its own copy of. The theme is not one of
   *  them: it is the app's, not the page's. */
  // Every setting a book may hold its own copy of, from the schema — the
  // theme is not one of them: it is the app's, not the page's.
  const READING_KEYS = PER_BOOK_KEYS;

  const D = READER_DEFAULTS;
  function loadTracking(bookId: number | null): number {
    const key = bookId != null ? `book${bookId}.readerTracking` : "readerTracking";
    const raw = localStorage.getItem(key) ?? (bookId != null ? localStorage.getItem("readerTracking") : null);
    if (raw == null) return D.readerTracking;
    const n = Number(raw);
    return migrateTracking(Number.isFinite(n) ? n : D.readerTracking);
  }
  /** One-shot: leading and para-gap used to be percent / hundredths-em.
   *  After this flag is set they are pixels, so a stored 180 is 180px
   *  and must not be read as 180%. */
  if (localStorage.getItem("reading.pxUnits") !== "1") {
    const convert = (key: string, migrate: (n: number) => number) => {
      const raw = localStorage.getItem(key);
      if (raw == null) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const next = migrate(n);
      if (next !== n) localStorage.setItem(key, String(next));
    };
    for (const key of Object.keys(localStorage)) {
      if (key === "readerLeading" || key.endsWith(".readerLeading")) convert(key, migrateLeading);
      if (key === "readerParaGap" || key.endsWith(".readerParaGap")) convert(key, migrateParaGap);
    }
    localStorage.setItem("reading.pxUnits", "1");
  }
  const readerSize = ref(ls.num("readerSize", D.readerSize, READER_BOUNDS.size.min, READER_BOUNDS.size.max));
  const readerLeading = ref(ls.num("readerLeading", D.readerLeading, READER_BOUNDS.leading.min, READER_BOUNDS.leading.max));
  const readerWidth = ref(ls.num("readerWidth", D.readerWidth, READER_BOUNDS.width.min, READER_BOUNDS.width.max));
  const readerTracking = ref(loadTracking(null));
  const readerParaGap = ref(ls.num("readerParaGap", D.readerParaGap, READER_BOUNDS.paraGap.min, READER_BOUNDS.paraGap.max));
  const readerPadX = ref(ls.num("readerPadX", D.readerPadX, READER_BOUNDS.padX.min, READER_BOUNDS.padX.max));
  const readerPadY = ref(ls.num("readerPadY", D.readerPadY, READER_BOUNDS.padY.min, READER_BOUNDS.padY.max));
  /** Justified is what a book does; ragged-right is easier on a narrow column. */
  const readerJustify = ref(ls.bool("readerJustify", D.readerJustify));
  const readerTypeset = ref(ls.oneOf("readerTypeset", ["modern", "book", "web"] as const, "modern"));
  const readerDropCap = ref(ls.oneOf("readerDropCap", ["off", "double", "triple"] as const, "double"));
  const readerIndent = ref(ls.num("readerIndent", D.readerIndent, BOUNDS.readerIndent.min, BOUNDS.readerIndent.max));
  const readerEndMark = ref(ls.bool("readerEndMark", D.readerEndMark));
  const readerColSep = ref(ls.bool("readerColSep", D.readerColSep));
  const readerOrientation = ref(ls.oneOf("readerOrientation", ["horizontal", "vertical"] as const, "horizontal"));
  const readerLineNumbers = ref(ls.bool("readerLineNumbers", D.readerLineNumbers));
  const readerPaper = ref<ReaderPaper>(
    ls.oneOf<ReaderPaper>("readerPaper", READER_PAPER_KEYS, D.readerPaper),
  );
  /** The colour behind "custom". Kept even while a preset is chosen, so going
   *  back to custom restores the last pick — the accent colour does the same. */
  const readerPaperCustom = ref(ls.hex("readerPaperCustom", D.readerPaperCustom));
  /** The letters' own colour, independent of the paper. "auto" lets the
   *  paper's ink stand. */
  const readerInk = ref<ReaderInk>(ls.oneOf<ReaderInk>("readerInk", READER_INK_KEYS, D.readerInk));
  /** The colour behind "custom". Kept even while a preset is chosen, so going
   *  back to custom restores the last pick. */
  const readerInkCustom = ref(ls.hex("readerInkCustom", D.readerInkCustom));
  /** Paper grain: smooth, or one of the tileable texture images over the page. */
  // v1 kept the grain as an on/off switch stored as "1"/"0"; v2 named the
  // choices fine/coarse/linen; v3 traded watercolor for wood. Map the old
  // values to the current textures before reading, so nobody loses the
  // texture they had chosen.
  {
    const v = localStorage.getItem("readerTexture");
    if (v === "1") localStorage.setItem("readerTexture", "wood");
    else if (v === "0") localStorage.setItem("readerTexture", "none");
    else if (v === "fine" || v === "coarse" || v === "linen" || v === "watercolor")
      localStorage.setItem("readerTexture", "wood");
  }
  const readerTexture = ref<ReaderTexture>(
    ls.oneOf<ReaderTexture>("readerTexture", TEXTURE_KEYS, D.readerTexture),
  );
  /** Amber wash over the page, 0-100. Not a colour filter over the whole app:
   *  it sits on the reading surface only, so covers and images elsewhere keep
   *  their colours. */
  const readerWarmth = ref(ls.num("readerWarmth", D.readerWarmth, READER_BOUNDS.warmth.min, READER_BOUNDS.warmth.max));
  const readerGrayscale = ref(ls.bool("readerGrayscale", D.readerGrayscale));
  /** Auto-scroll speed in pixels a second — roughly a line every two seconds
   *  at the low end, a comfortable read at the default. */
  const readerAutoSpeed = ref(ls.num("readerAutoSpeed", D.readerAutoSpeed, READER_BOUNDS.autoSpeed.min, READER_BOUNDS.autoSpeed.max));
  /** Click the left or right edge of the page to turn it. Off by default: on a
   *  desktop a click in the text is how you start a selection. */
  const readerClickPaging = ref(ls.bool("readerClickPaging", D.readerClickPaging));
  /** Scrolled or paged, and how many columns a page is divided into. Global:
   *  how you turn a page is a habit, not a property of the book. */
  const readerPageMode = ref(
    ls.oneOf("readerPageMode", ["scroll", "paged"] as const, D.readerPageMode),
  );
  const readerRemindAfter = ref(
    ls.num("readerRemindAfter", D.readerRemindAfter, BOUNDS.readerRemindAfter.min, BOUNDS.readerRemindAfter.max),
  );
  const readerShowPage = ref(ls.bool("readerShowPage", D.readerShowPage));
  const readerShowLeft = ref(ls.bool("readerShowLeft", D.readerShowLeft));
  const readerShowClock = ref(ls.bool("readerShowClock", D.readerShowClock));
  const readerColumns = ref(
    ls.num("readerColumns", D.readerColumns, BOUNDS.readerColumns.min, BOUNDS.readerColumns.max),
  );

  // Draggable pane widths (px) — the sidebar panel and the AI summary drawer.
  const sidebarWidth = ref(ls.num("sidebarWidth", 232, PANEL_BOUNDS.sidebar.min, PANEL_BOUNDS.sidebar.max));
  const aiWidth = ref(ls.num("aiWidth", 360, PANEL_BOUNDS.ai.min, PANEL_BOUNDS.ai.max));

  const prefs = ref<Prefs>(loadPrefs());
  const focusMode = ref(false);
  const aiOpen = ref(false);

  function select(q: LibraryQuery, label: string) {
    const name = "value" in q || q.kind === "format" ? label : "";
    ls.set("lastView", JSON.stringify({ query: q, name }));
    query.value = q;
    queryName.value = name;
    selectedBookId.value = null;
    filterText.value = "";
    middlePane.value = "library";
  }
  function showHighlights() {
    ls.set("lastView", JSON.stringify({ pane: "highlights" }));
    middlePane.value = "highlights";
    selectedBookId.value = null;
  }
  // Open the book at the chapter the highlight lives in, stashing the highlight
  // id so HighlightLayer can scroll to it once the marks are applied. Does NOT
  // touch middlePane: closing the reader returns the user to the highlights
  // pane they came from.
  function openHighlight(highlightId: number, bookId: number, chapterIndex: number) {
    pendingHighlightId.value = highlightId;
    pendingChapterIndex.value = chapterIndex;
    selectedBookId.value = bookId;
  }
  function consumePendingHighlight(): number | null {
    const id = pendingHighlightId.value;
    pendingHighlightId.value = null;
    return id;
  }
  function consumePendingChapter(): number | null {
    const i = pendingChapterIndex.value;
    pendingChapterIndex.value = null;
    return i;
  }
  function consumePendingSnippet(): string | null {
    const s = pendingSnippet.value;
    pendingSnippet.value = null;
    return s;
  }
  const openBook = (id: number | null) => (selectedBookId.value = id);
  /** Open a book at a specific chapter — a search hit, an AI citation. */
  function openBookAt(id: number, chapterIndex: number, snippet?: string) {
    pendingChapterIndex.value = chapterIndex;
    pendingSnippet.value = snippet?.trim() ? snippet : null;
    selectedBookId.value = id;
  }
  const setFilterText = (v: string) => (filterText.value = v);
  const setBookSort = (v: BookSort) => { ls.set("bookSort", v); bookSort.value = v; };

  const setTheme = (t: Theme) => {
    ls.set("theme", t);
    theme.value = t;
    mirrorTheme(t === "auto" ? (prefersDark.value ? "dark" : "light") : t);
  };
  const setDarkShade = (s: DarkShade) => { ls.set("darkShade", s); mirrorDarkShade(s); darkShade.value = s; };
  const setAccent = (a: Accent) => { ls.set("accent", a); accent.value = a; };
  const setAppIcon = (v: AppIcon) => {
    if (!(APP_ICONS as readonly string[]).includes(v)) return;
    ls.set("appIcon", v);
    appIcon.value = v;
    api.setSetting("app_icon", v).catch(() => {});
  };
  // Picking a custom colour also selects the custom accent — one gesture.
  const setCustomAccent = (hex: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    ls.set("customAccent", hex);
    customAccent.value = hex;
    setAccent("custom");
  };
  const setDensity = (d: Density) => { ls.set("density", d); density.value = d; };
  const setViewMode = (v: ViewMode) => { ls.set("viewMode", v); viewMode.value = v; };
  /** Every reading setting's ref, by the key the schema names it with. This is
   *  the one place the two are tied together; everything else moves values
   *  around by key, which is what lets a presenter walk the schema instead of
   *  naming seventeen setters. */
  const READING_REFS: Record<string, { value: unknown }> = {
    readerFont, readerSize, readerLeading, readerWidth, readerTracking,
    readerParaGap, readerPadX, readerPadY, readerJustify, readerTypeset, readerDropCap,
    readerIndent, readerEndMark, readerColSep, readerOrientation,
    readerPaper,
    readerPaperCustom, readerInk, readerInkCustom, readerWarmth,
    readerGrayscale, readerTexture, readerAutoSpeed, readerClickPaging, readerPageMode,
    readerColumns, readerLineNumbers, readerShowPage, readerShowLeft, readerShowClock, readerRemindAfter,
  };

  /** Where a setting is persisted: under the open book's prefix when the book
   *  has its own copy and the setting is one a book may hold, under the plain
   *  key otherwise.
   *
   *  Getting this wrong is silent, and it was wrong: the auto-scroll speed is
   *  global, but it was written under the book's prefix and read back from the
   *  global key — so changing it inside a book with its own profile did
   *  nothing that survived a restart. The schema knows which settings are a
   *  book's, so this can no longer be decided one setter at a time. */
  const storageKeyOf = (s: Setting) => (s.perBook ? profileKey(s.key) : s.key);

  /** Read one reading setting by key. */
  function readingValue(key: ReadingSettingKey): unknown {
    return READING_REFS[key].value;
  }

  /** Write one, clamped to the bounds its row gives it. */
  function setReading(
    key: ReadingSettingKey,
    value: number | boolean | string,
    persist: "active" | "global" = "active",
  ) {
    const s = settingOf(key);
    const v =
      s.kind === "number" ? clamp(Number(value), BOUNDS[key].min, BOUNDS[key].max) : value;
    READING_REFS[key].value = v;
    if (persist === "global") {
      ls.set(s.key, v as string | number | boolean);
      if (s.perBook && profileBookId.value != null) {
        ls.set(profileKey(s.key), v as string | number | boolean);
      }
    } else {
      ls.set(storageKeyOf(s), v as string | number | boolean);
    }
    // Choosing a colour is also choosing to use it.
    if (key === "readerPaperCustom") setReading("readerPaper", "custom");
    if (key === "readerInkCustom") setReading("readerInk", "custom");
  }

  /** Put back everything a reset restores. Which reset: the one reached from
   *  over a page only touches what a book can hold, since how fast auto-scroll
   *  runs is a habit rather than a property of the book being read. */
  function resetReading(scope: "book" | "all" = "all") {
    for (const s of READING_SETTINGS) {
      if (!s.resettable || (scope === "book" && !s.perBook)) continue;
      setReading(s.key, s.default, scope === "all" ? "global" : "active");
    }
  }

  /** Whether that reset would do anything — the question the button asking to
   *  perform it has to answer, over exactly the same list. */
  function isReadingDefault(scope: "book" | "all" = "all") {
    return READING_SETTINGS.every(
      (s) =>
        !s.resettable ||
        (scope === "book" && !s.perBook) ||
        READING_REFS[s.key].value === s.default,
    );
  }

  /** Settings → Reading also offers the app theme and the chapter aids. Those
   *  are not a book's to hold, so the in-reader Aa reset leaves them alone.
   *  Speech rate lives in the database; the page checks it itself. */
  function isReadingPageDefault() {
    return (
      isReadingDefault("all") &&
      theme.value === "light" &&
      prefs.value.trimBlankParagraphs &&
      prefs.value.showReadingTime &&
      !prefs.value.showTransSwitch
    );
  }

  function resetReadingPage() {
    resetReading("all");
    setTheme("light");
    setPref({
      trimBlankParagraphs: true,
      showReadingTime: true,
      showTransSwitch: false,
    });
  }

  const setReaderFont = (v: string) => setReading("readerFont", v);
  const setUiFont = (v: string) => { ls.set("uiFont", v); uiFont.value = v; };
  const setInstalledFonts = (v: InstalledFont[]) => { installedFonts.value = v; };
  const setReaderPaper = (v: ReaderPaper) => setReading("readerPaper", v);
  const setReaderJustify = (v: boolean) => setReading("readerJustify", v);
  const setReaderTypeset = (v: "modern" | "book" | "web") => setReading("readerTypeset", v);
  const setReaderDropCap = (v: "off" | "double" | "triple") => setReading("readerDropCap", v);
  const setReaderIndent = (v: number) => setReading("readerIndent", v);
  const setReaderEndMark = (v: boolean) => setReading("readerEndMark", v);
  const setReaderColSep = (v: boolean) => setReading("readerColSep", v);
  const setReaderOrientation = (v: "horizontal" | "vertical") => setReading("readerOrientation", v);
  const setReaderGrayscale = (v: boolean) => setReading("readerGrayscale", v);
  const setReaderLineNumbers = (v: boolean) => setReading("readerLineNumbers", v);
  const setReaderTexture = (v: ReaderTexture) => setReading("readerTexture", v);
  const setReaderPaperCustom = (hex: string) => setReading("readerPaperCustom", hex);
  const setReaderInk = (v: ReaderInk) => setReading("readerInk", v);
  const setReaderInkCustom = (hex: string) => setReading("readerInkCustom", hex);
  const setReaderClickPaging = (v: boolean) => setReading("readerClickPaging", v);

  /** The three ways people actually read, as one press each: what the page is
   *  made of and what the app is wearing move together. */
  function applyReadingPreset(name: "day" | "comfort" | "night") {
    setReading("readerOrientation", "horizontal");
    setReading("readerColSep", false);
    if (name === "day") {
      setTheme("light");
      setReaderPaper("theme");
      setReader({ readerWarmth: 0, readerSize: D.readerSize, readerLeading: D.readerLeading, readerTracking: D.readerTracking });
      setReading("readerGrayscale", false);
      setReading("readerTexture", "none");
      setReading("readerInk", "auto");
    } else if (name === "comfort") {
      setTheme("light");
      setReaderPaper("sepia");
      setReader({ readerWarmth: 12, readerSize: D.readerSize, readerLeading: D.readerLeading, readerTracking: D.readerTracking });
      setReading("readerGrayscale", false);
      setReading("readerTexture", "none");
      setReading("readerInk", "auto");
    } else {
      setTheme("dark");
      setReaderPaper("gray");
      setReader({ readerWarmth: 0, readerSize: D.readerSize, readerLeading: D.readerLeading, readerTracking: D.readerTracking });
      setReading("readerGrayscale", false);
      setReading("readerTexture", "none");
      setReading("readerInk", "auto");
    }
  }

  /** Classic vertical (古籍) preset — switches to vertical writing mode,
   *  sepia paper, comfortable tracking, and enables the column separator.
   *  (Not the drop cap: a vertical column disables it in CSS, so forcing the
   *  setting off here would persist "off" into horizontal reading.) */
  function applyVerticalPreset() {
    setReading("readerOrientation", "vertical");
    setReaderPaper("sepia");
    setReader({ readerTracking: 1, readerSize: 18, readerLeading: 32 });
    setReading("readerColSep", true);
  }

  /** The numeric settings, in the shape callers have always passed. Seventeen
   *  near-identical branches became this when the bounds moved into the
   *  schema. */
  function setReader(p: Partial<Record<ReadingSettingKey, number>>) {
    for (const [key, value] of Object.entries(p)) {
      if (value != null) setReading(key as ReadingSettingKey, value);
    }
  }
  // Clamp on write so neither a drag past the handle's guard nor a stale
  // persisted value (from an older build with different limits) can push an
  // out-of-range width into the store or its --col-*/--ai-width CSS variable.
  function setPanel(p: { sidebarWidth?: number; aiWidth?: number }) {
    if (p.sidebarWidth != null) {
      sidebarWidth.value = clamp(p.sidebarWidth, PANEL_BOUNDS.sidebar.min, PANEL_BOUNDS.sidebar.max);
      ls.set("sidebarWidth", sidebarWidth.value);
    }
    if (p.aiWidth != null) {
      aiWidth.value = clamp(p.aiWidth, PANEL_BOUNDS.ai.min, PANEL_BOUNDS.ai.max);
      ls.set("aiWidth", aiWidth.value);
    }
  }
  /** Read every reading setting from the active profile into the refs the page
   *  is driven by. Falls back to the global value for anything the profile is
   *  missing, and to the built-in default for anything neither has. */
  /** A setting's value out of storage: the book's copy, else the global one,
   *  else the built-in default — parsed the way its kind requires. */
  function storedValue(s: Setting, bookKey: string): number | boolean | string {
    switch (s.kind) {
      case "number": {
        const b = BOUNDS[s.key];
        if (s.key === "readerTracking") {
          const id = profileBookId.value;
          return loadTracking(id);
        }
        return ls.num(bookKey, ls.num(s.key, s.default, b.min, b.max), b.min, b.max);
      }
      case "boolean":
        return ls.bool(bookKey, ls.bool(s.key, s.default));
      case "enum":
        return ls.oneOf(bookKey, s.options, ls.oneOf(s.key, s.options, s.default));
      case "colour":
        return ls.hex(bookKey, ls.hex(s.key, s.default));
      case "font":
        // The font carries a migration from an older key, which loadReaderFont
        // owns; the book's copy, when it has one, wins over all of it.
        return localStorage.getItem(bookKey) ?? loadReaderFont();
    }
  }

  function loadReading() {
    for (const s of READING_SETTINGS) {
      // A global setting has no per-book copy to load; it keeps the value it
      // booted with.
      if (!s.perBook) continue;
      READING_REFS[s.key].value = storedValue(s, profileKey(s.key));
    }
  }

  /** Called as a book opens and as it closes (with null). A book that has its
   *  own settings gets them; anything else reads the global set. */
  function useBookProfile(bookId: number | null) {
    const next = bookId != null && localStorage.getItem(`book${bookId}.on`) === "1" ? bookId : null;
    if (next === profileBookId.value) return;
    profileBookId.value = next;
    loadReading();
  }

  /** Give the open book its own copy of the current settings, or take it away
   *  again — in which case the page falls back to the global set, which has
   *  been sitting there untouched the whole time. */
  function setPerBook(bookId: number, on: boolean) {
    if (on) {
      // Seed from what is on screen, so turning it on changes nothing yet.
      localStorage.setItem(`book${bookId}.on`, "1");
      profileBookId.value = bookId;
      setReaderFont(readerFont.value);
      setReaderPaper(readerPaper.value);
      setReaderTexture(readerTexture.value);
      ls.set(profileKey("readerPaperCustom"), readerPaperCustom.value);
      setReaderInk(readerInk.value);
      ls.set(profileKey("readerInkCustom"), readerInkCustom.value);
      setReaderJustify(readerJustify.value);
      setReaderTypeset(readerTypeset.value);
      setReaderDropCap(readerDropCap.value);
      setReaderIndent(readerIndent.value);
      setReaderEndMark(readerEndMark.value);
      setReaderColSep(readerColSep.value);
      setReaderOrientation(readerOrientation.value);
      setReaderGrayscale(readerGrayscale.value);
      setReaderLineNumbers(readerLineNumbers.value);
      setReader({
        readerSize: readerSize.value,
        readerLeading: readerLeading.value,
        readerWidth: readerWidth.value,
        readerTracking: readerTracking.value,
        readerParaGap: readerParaGap.value,
        readerPadX: readerPadX.value,
        readerPadY: readerPadY.value,
        readerWarmth: readerWarmth.value,
      });
      return;
    }
    for (const name of READING_KEYS) localStorage.removeItem(`book${bookId}.${name}`);
    localStorage.removeItem(`book${bookId}.on`);
    profileBookId.value = null;
    loadReading();
  }

  function setPref(patch: Partial<Prefs>) {
    for (const k of PREF_KEYS) {
      if (patch[k] !== undefined) ls.set(`pref.${k}`, patch[k] as string | boolean);
    }
    prefs.value = { ...prefs.value, ...patch };
  }
  // System-level fullscreen. Hitting F / the reader toolbar / the ⌘K
  // command flips the actual OS window into fullscreen (macOS full-screen
  // space; Windows/Linux frameless). Local ref stays in sync via the
  // boolean the backend returns after the toggle, so `focusMode`
  // reflects the true window state even when the user triggered it
  // natively (green traffic-light click, F11 on Windows).
  async function setFocusMode(v: boolean) {
    if (v === focusMode.value) return;
    try {
      focusMode.value = await api.toggleFullscreen();
    } catch { /* swallow — worst case, ref stays as-is */ }
  }
  const setAiOpen = (v: boolean) => (aiOpen.value = v);

  // Seed the backend theme copy so the native launch background is themed.
  // Use the resolved value so "auto" mirrors the OS preference at launch.
  mirrorTheme(resolvedTheme.value);
  mirrorDarkShade(darkShade.value);
  // Same for the Dock mark — the Go side also reads this on cold start.
  api.setSetting("app_icon", appIcon.value).catch(() => {});

  // Keep the backend mirror in sync when the OS flips appearance while the
  // user has "auto" selected — setTheme already mirrors on explicit changes.
  watch(resolvedTheme, (v) => { mirrorTheme(v); });

  return {
    query, queryLabel, selectedBookId, filterText, bookSort,
    middlePane, pendingHighlightId, pendingChapterIndex, pendingSnippet, tocSearchTick,
    theme, resolvedTheme, darkShade, accent, customAccent, appIcon, iconSrc, iconMark, density, viewMode, readerFont, uiFont, installedFonts,
    readerSize, readerLeading, readerWidth,
    readerTracking, readerParaGap, readerPadX, readerPadY,
    readerJustify, readerTypeset, readerDropCap, readerIndent, readerEndMark, readerColSep, readerOrientation, readerPaper, readerWarmth, readerGrayscale,
    readerLineNumbers,
    readerAutoSpeed, readerClickPaging, readerPageMode, readerColumns,
    readerShowPage, readerShowLeft, readerShowClock, readerRemindAfter,
    perBook, readerPaperCustom, readerTexture,
    readerInk, readerInkCustom,
    setReaderTexture, setReaderPaperCustom, setReaderInk, setReaderInkCustom,
    useBookProfile, setPerBook,
    setReaderPaper, setReaderJustify, setReaderGrayscale, setReaderClickPaging,
    setReaderLineNumbers, setReaderColSep,
    // Schema-driven: a presenter walks the settings table and uses these,
    // rather than knowing seventeen setters by name.
    readingValue, setReading, resetReading, isReadingDefault,
    resetReadingPage, isReadingPageDefault,
    applyReadingPreset, applyVerticalPreset,
    sidebarWidth, aiWidth,
    prefs, focusMode, aiOpen,
    select, openBook, openBookAt, setFilterText, setBookSort,
    showHighlights, openHighlight, consumePendingHighlight, consumePendingChapter, consumePendingSnippet,
    requestTocSearch,
    setTheme, setDarkShade, setAccent, setCustomAccent, setAppIcon, setDensity, setViewMode, setReaderFont, setReader, setPanel,
    setUiFont, setInstalledFonts,
    setPref, setFocusMode, setAiOpen,
  };
});
