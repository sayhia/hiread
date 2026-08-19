// What a reading setting *is*, as data.
//
// There were four places that had to agree about any one setting and no way to
// make them: the store held its default and its bounds, lib/readerSettings held
// a second copy of the default and the named steps, the Aa panel decided which
// of them a PDF may change, and Settings → Reading decided which of them a
// reset restores. Every pair of those has drifted at least once — a reset that
// restored two settings the "is this still default?" check never looked at, a
// type sample computed twice and already differing, bounds for warmth and
// contrast that exist only as literals inside a ref() call.
//
// So a setting is described once, here, and everything else is a view of this:
// the defaults object, the per-book key list, what a reset puts back, what
// bounds a value is clamped to, and which surface may offer it. Adding a
// setting means adding a row; nothing else has to be told.
//
// What is deliberately *not* here: speech voice and rate. Those live in the
// database rather than localStorage because they belong to the machine, not to
// the reader's page, and giving them a row would mean giving every consumer a
// second storage path to think about.

/** How a value is chosen, which is what tells a presenter how to draw it. */
export type SettingKind = "number" | "boolean" | "enum" | "colour" | "font";

/** Which panel of the settings a row belongs under. The Aa panel shows these
 *  as tabs; Settings → Reading shows them as sections. */
export type SettingGroup = "type" | "layout" | "page" | "motion" | "display";

/** The reading screens. A PDF is a picture of a page: the type settings cannot
 *  reach it, and offering them there is offering controls that do nothing. */
export type ReadingSurface = "text" | "pdf";

export interface NamedStep {
  readonly value: number;
  /** i18n suffix under `reading.step.` — "tight", "normal", "airy". */
  readonly key: string;
}

interface Common {
  readonly key: string;
  readonly group: SettingGroup;
  readonly surfaces: readonly ReadingSurface[];
  /** May a book hold its own copy, separate from the global one. */
  readonly perBook: boolean;
  /** Does "reset to defaults" put it back. Anything false here is a value the
   *  reader chose that a reset has no business discarding — the custom page
   *  colour is theirs even when the page is not using it. */
  readonly resettable: boolean;
  /** Whether it gets a row of its own. A setting can be real and still not
   *  be a row: the custom page colour is chosen from inside the page-colour
   *  swatches, because a colour you cannot see beside the others is a colour
   *  you cannot choose between. */
  readonly presented?: boolean;
  /** Writing this setting also writes that one. Choosing a colour is also
   *  choosing to use it, which is right when a reader picks one and wrong when
   *  a file is being restored — the file says what the page colour was, and
   *  the side effect would overrule it. Anything named here has to be applied
   *  after the setting that names it. */
  readonly alsoWrites?: string;
  /** Only offered where there is room to be exact. The panel over a page
   *  treats the sheet's margin as one thing, because that is what it is to a
   *  reader — a page with wide sides and a tight head reads as a mistake, not
   *  as a choice. Settings can still take them apart. */
  readonly fullOnly?: boolean;
}

export interface NumberSetting extends Common {
  readonly kind: "number";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Named positions for the compact panel, which offers steps rather than a
   *  slider. A value between two steps is still legal — it just highlights
   *  the nearest one. */
  readonly steps?: readonly NamedStep[];
}

export interface BooleanSetting extends Common {
  readonly kind: "boolean";
  readonly default: boolean;
}

export interface EnumSetting extends Common {
  readonly kind: "enum";
  readonly default: string;
  readonly options: readonly string[];
  /** How to show the choice. Colours are shown as themselves; everything else
   *  is named, because a swatch of a word is just a word in a box. */
  readonly display?: "swatches";
}

export interface ColourSetting extends Common {
  readonly kind: "colour";
  readonly default: string;
}

export interface FontSetting extends Common {
  readonly kind: "font";
  readonly default: string;
}

export type Setting =
  | NumberSetting
  | BooleanSetting
  | EnumSetting
  | ColourSetting
  | FontSetting;

/** Named type sizes. A reader picks "large", not 19 pixels — but the pixels
 *  stay available, so a size between two steps is not thrown away. */
const SIZE_STEPS = [
  { value: 14, key: "xs" },
  { value: 17, key: "s" },
  { value: 22, key: "m" },
  { value: 32, key: "l" },
  { value: 48, key: "xl" },
] as const;

const LEADING_STEPS = [
  { value: 22, key: "tight" },
  { value: 28, key: "normal" },
  { value: 36, key: "airy" },
] as const;

/** Letter-spacing in pixels. The old unit was thousandths of an em, which
 *  at 17px was a fraction of a pixel — the slider moved and the page did not. */
const TRACKING_STEPS = [
  { value: -1, key: "tight" },
  { value: 0, key: "normal" },
  { value: 4, key: "loose" },
] as const;

const PARA_STEPS = [
  { value: 8, key: "tight" },
  { value: 18, key: "normal" },
  { value: 32, key: "airy" },
] as const;

const MARGIN_STEPS = [
  { value: 28, key: "narrow" },
  { value: 52, key: "medium" },
  { value: 88, key: "wide" },
] as const;

const WIDTH_STEPS = [
  { value: 560, key: "narrow" },
  { value: 680, key: "medium" },
  { value: 860, key: "wide" },
] as const;

export const PAPER_OPTIONS = ["theme", "sepia", "green", "gray", "black", "custom"] as const;

/** Paper grain choices. "none" is the smooth page; the rest are tileable
 *  texture images (src/assets/textures) that tint with the page colour. */
export const TEXTURE_OPTIONS = ["none", "wood", "fibre", "grain", "grid"] as const;

/** Ink choices. "auto" lets the paper's own ink stand; the rest pin the
 *  letters to a colour of the reader's choosing. */
export const INK_OPTIONS = ["auto", "black", "gray", "sepia", "custom"] as const;

const BOTH = ["text", "pdf"] as const;
const TEXT = ["text"] as const;

/** Every reading setting, once.
 *
 *  Order is the order a presenter shows them in, so the panel and the settings
 *  page cannot disagree about what comes first either. */
export const READING_SETTINGS = [
  // ── the type ────────────────────────────────────────────────────────────
  {
    key: "readerFont",
    kind: "font",
    group: "type",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "sans",
  },
  {
    key: "readerSize",
    kind: "number",
    group: "type",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 17,
    min: 12,
    max: 96,
    steps: SIZE_STEPS,
  },
  {
    key: "readerLeading",
    kind: "number",
    group: "type",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 28,
    min: 16,
    max: 240,
    steps: LEADING_STEPS,
  },
  {
    key: "readerTracking",
    kind: "number",
    group: "type",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 0,
    min: -8,
    max: 32,
    steps: TRACKING_STEPS,
  },

  // ── how it is set ───────────────────────────────────────────────────────
  {
    key: "readerWidth",
    kind: "number",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 680,
    min: 520,
    max: 1920,
    steps: WIDTH_STEPS,
  },
  {
    key: "readerPadX",
    kind: "number",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 52,
    min: 16,
    max: 120,
    steps: MARGIN_STEPS,
  },
  {
    key: "readerPadY",
    kind: "number",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    // The panel moves it with the horizontal margin; see linkedPadY.
    fullOnly: true,
    default: 40,
    min: 12,
    max: 120,
  },
  {
    key: "readerParaGap",
    kind: "number",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 18,
    min: 0,
    max: 96,
    steps: PARA_STEPS,
  },
  {
    key: "readerTypeset",
    kind: "enum",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "modern",
    options: ["modern", "book", "web"] as const,
    // A named combination of the paragraph-level choices: "modern" is the
    // spaced, unindented page; "book" indents first lines and tightens the
    // paragraph gap like a printed book; "web" airs the gaps out.
  },
  {
    key: "readerDropCap",
    kind: "enum",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "double",
    options: ["off", "double", "triple"] as const,
    // The chapter's opening letter, set large like a printed book. "double"
    // spans two text lines, "triple" three; some readers prefer none.
  },
  {
    key: "readerIndent",
    kind: "number",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: 0,
    min: 0,
    max: 4,
    steps: [
      { value: 0, key: "indent0" },
      { value: 1, key: "indent1" },
      { value: 2, key: "indent2" },
      { value: 3, key: "indent3" },
      { value: 4, key: "indent4" },
    ] as const,
    // How far each paragraph's first line is indented, in em (one em is
    // roughly one character): 0 for none, 2 like a printed book, 4 for a
    // strong indent. A "book" typeset indents in both orientations; a
    // vertical (古籍) column indents with the same setting whatever preset it
    // uses, since the classical page's paragraph lead is not tied to the
    // horizontal spacing presets.
  },
  {
    key: "readerOrientation",
    kind: "enum",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "horizontal",
    options: ["horizontal", "vertical"] as const,
    // Vertical (古籍) reading: text runs top-to-bottom, columns right-to-left,
    // like a classical Chinese book. Progress/scroll switch to the x axis,
    // line numbers count columns right-to-left. Punctuation rotates to its
    // vertical forms, paged pages go tall and narrow, and a scrolled chapter
    // counts its place in columns.
  },
  {
    key: "readerColSep",
    kind: "boolean",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: false,
    // Column separator line between columns in vertical (古籍) mode — evokes
    // the ruled columns of a woodblock or block-print edition. Off by default;
    // meaningless in horizontal mode (which already shows column rules in
    // multi-column scroll via the existing column-rule rule).
  },
  {
    key: "readerEndMark",
    kind: "boolean",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: true,
    // The small rule–diamond–rule ornament at the end of a chapter.
  },
  {
    key: "readerJustify",
    kind: "boolean",
    group: "layout",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: false,
  },

  // ── what it sits on ─────────────────────────────────────────────────────
  {
    key: "readerPaper",
    kind: "enum",
    group: "page",
    surfaces: BOTH,
    perBook: true,
    resettable: true,
    default: "theme",
    options: PAPER_OPTIONS,
    display: "swatches",
  },
  {
    key: "readerPaperCustom",
    kind: "colour",
    group: "page",
    surfaces: BOTH,
    perBook: true,
    // The reader's own colour. A reset takes the page back to the default
    // paper, which is enough to stop it being used; throwing the colour away
    // as well would mean picking it again.
    resettable: false,
    // Chosen from within the page-colour swatches, not on a row of its own.
    presented: false,
    // Picking a colour selects it — see setReading.
    alsoWrites: "readerPaper",
    default: "#F2EFE6",
  },
  {
    key: "readerInk",
    kind: "enum",
    group: "page",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "auto",
    options: INK_OPTIONS,
    display: "swatches",
    // The letters' own colour, independent of the paper. A PDF page is a
    // picture with its ink already in it.
  },
  {
    key: "readerInkCustom",
    kind: "colour",
    group: "page",
    surfaces: TEXT,
    perBook: true,
    // Same deal as the paper colour: resetting the ink choice stops it being
    // used, and throwing the pick away would mean making it again.
    resettable: false,
    // Chosen from within the ink swatches, not on a row of its own.
    presented: false,
    // Picking a colour selects it — see setReading.
    alsoWrites: "readerInk",
    default: "#131619",
  },
  {
    key: "readerWarmth",
    kind: "number",
    group: "page",
    surfaces: BOTH,
    perBook: true,
    resettable: true,
    default: 0,
    min: 0,
    max: 100,
  },
  {
    key: "readerGrayscale",
    kind: "boolean",
    group: "page",
    surfaces: BOTH,
    perBook: true,
    resettable: true,
    default: false,
  },
  {
    key: "readerTexture",
    kind: "enum",
    group: "page",
    surfaces: TEXT,
    perBook: true,
    resettable: true,
    default: "none",
    options: TEXTURE_OPTIONS,
    display: "swatches",
    // Grain over the sheet the text is set on. A PDF page is a picture with
    // its own paper in it.
  },

  // ── moving through it ───────────────────────────────────────────────────
  // Global rather than per-book: how you turn a page is a habit, not a
  // property of the book you are turning.
  {
    key: "readerAutoSpeed",
    kind: "number",
    group: "motion",
    surfaces: TEXT,
    perBook: false,
    resettable: true,
    default: 45,
    min: 8,
    max: 240,
  },
  {
    key: "readerPageMode",
    kind: "enum",
    group: "motion",
    surfaces: TEXT,
    // A habit rather than a property of the book: someone who reads in pages
    // reads every book in pages.
    perBook: false,
    resettable: true,
    default: "scroll",
    options: ["scroll", "paged"] as const,
  },
  {
    key: "readerClickPaging",
    kind: "boolean",
    group: "motion",
    surfaces: BOTH,
    perBook: false,
    resettable: true,
    default: false,
  },
  {
    key: "readerColumns",
    kind: "number",
    group: "motion",
    surfaces: TEXT,
    perBook: false,
    resettable: true,
    default: 1,
    min: 1,
    max: 3,
    steps: [
      { value: 1, key: "one" },
      { value: 2, key: "two" },
      { value: 3, key: "three" },
    ] as const,
  },
  {
    key: "readerLineNumbers",
    kind: "boolean",
    group: "motion",
    surfaces: TEXT,
    perBook: false,
    resettable: true,
    default: false,
    // A proofing aid: a numbered gutter along the chapter's left edge, one
    // number per visual line, in reading order. Off by default.
  },
  // ── what is on screen besides the text ──────────────────────────────────
  // A chapter says where it is at its head, which is on the first page and
  // nowhere else — so a reader two pages in has nothing to go on. These are
  // the line at the foot, and each of them is off unless it is wanted.
  {
    key: "readerShowPage",
    kind: "boolean",
    group: "display",
    surfaces: BOTH,
    perBook: false,
    resettable: true,
    default: true,
  },
  {
    key: "readerShowLeft",
    kind: "boolean",
    group: "display",
    surfaces: BOTH,
    perBook: false,
    resettable: true,
    default: false,
  },
  {
    key: "readerShowClock",
    kind: "boolean",
    group: "display",
    surfaces: BOTH,
    perBook: false,
    resettable: true,
    default: false,
  },
  {
    key: "readerRemindAfter",
    kind: "number",
    group: "display",
    surfaces: TEXT,
    perBook: false,
    resettable: true,
    // Off by default. A reminder nobody asked for is an interruption.
    default: 0,
    min: 0,
    max: 120,
    steps: [
      { value: 0, key: "never" },
      { value: 20, key: "min20" },
      { value: 30, key: "min30" },
      { value: 45, key: "min45" },
      { value: 60, key: "min60" },
    ] as const,
  },
] as const satisfies readonly Setting[];

export type ReadingSetting = (typeof READING_SETTINGS)[number];
export type ReadingSettingKey = ReadingSetting["key"];

/** The defaults, keyed and typed the way a consumer wants them: literal types
 *  survive, so `ui.readerPaper === DEFAULTS.readerPaper` still narrows. */
export type ReadingDefaults = {
  [S in ReadingSetting as S["key"]]: S["default"];
};

function build<T>(pick: (s: ReadingSetting) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const s of READING_SETTINGS) {
    const v = pick(s);
    if (v !== undefined) out[s.key] = v;
  }
  return out;
}

/** Every setting's default. */
export const READING_DEFAULTS = build((s) => s.default) as ReadingDefaults;

/** The numbers a reset restores, in the shape `setReader` takes. */
export const RESET_NUMBERS = build((s) =>
  s.kind === "number" && s.resettable ? s.default : undefined,
) as Record<string, number>;

/** The subset of those a book can hold its own copy of — which is exactly what
 *  the reset inside a book should put back. How fast auto-scroll runs is a
 *  habit rather than a property of the book being read, so a reset reached
 *  from over a page has no business changing it. */
export const PER_BOOK_RESET_NUMBERS = build((s) =>
  s.kind === "number" && s.resettable && s.perBook ? s.default : undefined,
) as Record<string, number>;

/** Everything a reset restores, whatever its kind — the list the "is this
 *  still default?" check has to read, since checking fewer keys than the reset
 *  touches is what greys out the button that would undo them. */
export const RESET_VALUES = build((s) =>
  s.resettable ? (s.default as string | number | boolean) : undefined,
);

/** The settings a book may hold its own copy of. */
export const PER_BOOK_KEYS = READING_SETTINGS.filter((s) => s.perBook).map((s) => s.key);

/** Bounds by key, for clamping on the way in from storage. */
export const BOUNDS = build((s) =>
  s.kind === "number" ? { min: s.min, max: s.max } : undefined,
) as Record<string, { min: number; max: number }>;

/** Named steps by key, for the panel that offers positions rather than a
 *  slider. Absent for a setting that has no sensible names. */
export const STEPS = build((s) =>
  s.kind === "number" && "steps" in s ? s.steps : undefined,
) as Record<string, readonly NamedStep[] | undefined>;

/** What a given screen may offer as rows, in order, optionally within one
 *  group. Settings marked `presented: false` are left out: they are real, and
 *  another setting's control is where they are chosen. */
export function settingsFor(
  surface: ReadingSurface,
  group?: SettingGroup,
  mode: "compact" | "full" = "full",
): readonly Setting[] {
  return READING_SETTINGS.filter(
    (s) =>
      !("presented" in s && s.presented === false) &&
      !(mode === "compact" && "fullOnly" in s && s.fullOnly) &&
      (s.surfaces as readonly ReadingSurface[]).includes(surface) &&
      (group === undefined || s.group === group),
  );
}

/** The groups a screen has anything to show in, in order — so a surface with
 *  one group's worth of settings can be drawn without a tab strip suggesting
 *  there are others. */
export function groupsFor(surface: ReadingSurface): readonly SettingGroup[] {
  const seen: SettingGroup[] = [];
  for (const s of settingsFor(surface)) if (!seen.includes(s.group)) seen.push(s.group);
  return seen;
}

/** Whether a presented setting should actually appear for this orientation.
 *  A ruled column only exists in vertical (古籍) text; drop cap, CSS columns,
 *  and justification paint nothing on a 古籍 page. The Aa panel and Settings
 *  both ask this so they cannot drift. */
export function settingVisible(s: Setting, orientation: string, pageMode?: string): boolean {
  if (s.key === "readerColSep") return orientation === "vertical";
  if (orientation === "vertical") {
    if (s.key === "readerDropCap" || s.key === "readerColumns" || s.key === "readerJustify") {
      return false;
    }
    // Scrolled 古籍 columns are viewport-tall; measure only reaches paged,
    // where it insets the 版心 and does not resize the page / turn zone.
    if (s.key === "readerWidth" && pageMode !== "paged") return false;
  }
  return true;
}

/** The settings another setting's write would overwrite. Anything here has to
 *  be applied *after* the setting that writes it, or a value being restored
 *  from a file loses to a side effect. */
export const CLOBBERED: ReadonlySet<string> = new Set<string>(
  READING_SETTINGS.flatMap((s) => ("alsoWrites" in s && s.alsoWrites ? [s.alsoWrites] : [])),
);

/** Look one up. Throws rather than returning undefined: every call site names
 *  a key that is in the table, and a typo should not become a silent no-op. */
/** Old tracking was thousandths of an em (−20…80). New is pixels (−8…32). */
export function migrateTracking(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v === 3) return 0;
  if (v === -8) return -1;
  if (v === 30) return 2;
  if (v === 20) return 1;
  if (v > 32 || v < -8) return Math.min(32, Math.max(-8, Math.round((v / 1000) * 17)));
  return Math.min(32, Math.max(-8, Math.round(v)));
}

/** Old leading was percent of the type size (130–200). New is pixels. */
export function migrateLeading(v: number): number {
  if (!Number.isFinite(v)) return 28;
  if (v >= 125 && v <= 210) return Math.min(240, Math.max(16, Math.round((v / 100) * 17)));
  return Math.min(240, Math.max(16, Math.round(v)));
}

/** Old paragraph gap was hundredths of an em (0–250). New is pixels. */
export function migrateParaGap(v: number): number {
  if (!Number.isFinite(v)) return 18;
  if (v === 60) return 8;
  if (v === 105) return 18;
  if (v === 190) return 32;
  if (v > 96) return Math.min(96, Math.max(0, Math.round((v / 100) * 17)));
  return Math.min(96, Math.max(0, Math.round(v)));
}

export function settingOf(key: ReadingSettingKey): Setting {
  const found = READING_SETTINGS.find((s) => s.key === key);
  if (!found) throw new Error(`unknown reading setting: ${key}`);
  return found;
}
