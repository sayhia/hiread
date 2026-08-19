// Reading settings shared by the in-reader Aa panel and Settings → Reading.
//
// The settings themselves are described in reading/schema — one row per
// setting, carrying its default, its bounds, its named steps, whether a book
// may hold its own copy, and which screens may offer it. This file is the set
// of views of that table the rest of the app already imports by name, plus the
// few helpers that are about presenting a setting rather than defining one.
//
// It used to hold its own copy of the defaults and the step tables, and the
// store held a third. Nothing here is a copy now; if a number looks wrong,
// the place to change it is the schema.

import {
  INK_OPTIONS,
  PAPER_OPTIONS,
  PER_BOOK_RESET_NUMBERS,
  READING_DEFAULTS,
  STEPS,
  TEXTURE_OPTIONS,
  type NamedStep,
} from "./reading/schema";

/** Named steps live with the setting they belong to; these are the views of
 *  them the panel already imports by name. */
function stepsOf(key: string): readonly NamedStep[] {
  const steps = STEPS[key];
  if (!steps) throw new Error(`reading setting ${key} has no named steps`);
  return steps;
}

/** The reading surface's own colours, independent of the app's theme. */
export type ReaderPaper = (typeof PAPER_OPTIONS)[number];

export const READER_PAPER_KEYS = PAPER_OPTIONS;

/** Paper grain: smooth, or one of the tileable texture images. */
export type ReaderTexture = (typeof TEXTURE_OPTIONS)[number];

export const TEXTURE_KEYS = TEXTURE_OPTIONS;

/** Built-in defaults. Store load, panel reset, and the "is this still default?"
 *  check all read from here — and this now reads from reading/schema, which is
 *  where a setting is described. These names stay because half the app knows
 *  them; what they no longer are is a second copy of the numbers. */
export const READER_DEFAULTS = READING_DEFAULTS;

/** Numeric fields the Reset button inside a book restores via setReader: the
 *  ones a book can hold its own copy of. The auto-scroll speed is a resettable
 *  number too, but a global one — see PER_BOOK_RESET_NUMBERS in the schema. */
export const READER_RESET_NUMBERS = PER_BOOK_RESET_NUMBERS;

/** Line height as three named settings rather than a number. */
export const READER_LEADING_STEPS = stepsOf("readerLeading");

/** Character spacing. CJK sets solid by default, so a touch of air matters. */
export const READER_TRACKING_STEPS = stepsOf("readerTracking");

/** Gap between paragraphs, in pixels. */
export const READER_PARA_STEPS = stepsOf("readerParaGap");

/** Sheet margins as one control; both edges move together in the panel. */
export const READER_MARGIN_STEPS = stepsOf("readerPadX");

/** Measure — how long a line runs. */
export const READER_WIDTH_STEPS = stepsOf("readerWidth");

/** Reading surface colours (custom is a picker, not a swatch here). */
export const READER_PAPERS: { value: ReaderPaper; key: string; swatch: string }[] = [
  { value: "theme", key: "theme", swatch: "var(--sheet)" },
  { value: "sepia", key: "sepia", swatch: "#F3E9D4" },
  { value: "green", key: "green", swatch: "#DCE9DA" },
  { value: "gray", key: "gray", swatch: "#23262B" },
  { value: "black", key: "black", swatch: "#000000" },
];

/** Ink (letter) colours. "auto" shows the paper's own ink — the swatch wears
 *  whatever that is; the named ones pin the letters to a fixed colour. */
export type ReaderInk = (typeof INK_OPTIONS)[number];

export const READER_INK_KEYS = INK_OPTIONS;

export const READER_TEXTURES: { value: ReaderTexture; key: string; swatch: string }[] = [
  { value: "none", key: "none", swatch: "var(--sheet)" },
  { value: "wood", key: "wood", swatch: "var(--sheet)" },
  { value: "fibre", key: "fibre", swatch: "var(--sheet)" },
  { value: "grain", key: "grain", swatch: "var(--sheet)" },
  { value: "grid", key: "grid", swatch: "var(--sheet)" },
];

export const READER_INKS: { value: ReaderInk; key: string; swatch: string }[] = [
  { value: "auto", key: "auto", swatch: "var(--ink)" },
  { value: "black", key: "black", swatch: "#131619" },
  { value: "gray", key: "gray", swatch: "#3D444C" },
  { value: "sepia", key: "sepia", swatch: "#4A3826" },
];

/** Vertical margin follows horizontal at the ratio the default sheet has. */
export function linkedPadY(padX: number): number {
  return Math.round(padX * 0.77);
}

/** Nearest named step for a continuous value (panel highlight). */
/** Which named page preset the current theme + paper + warmth match, or
 *  null when the reader has mixed them. */
export function matchingReadingPreset(s: {
  theme: string;
  paper: string;
  warmth: number;
  orientation: string;
  colSep: boolean;
  size?: number;
  leading?: number;
  tracking?: number;
}): "day" | "comfort" | "night" | "vertical" | null {
  if (s.orientation === "vertical" && s.paper === "sepia" && s.colSep) {
    if (s.size != null && s.size !== 18) return null;
    if (s.leading != null && s.leading !== 32) return null;
    if (s.tracking != null && s.tracking !== 1) return null;
    return "vertical";
  }
  if (s.orientation === "vertical") return null;
  const typeAtDefault =
    (s.size == null || s.size === READER_DEFAULTS.readerSize) &&
    (s.leading == null || s.leading === READER_DEFAULTS.readerLeading) &&
    (s.tracking == null || s.tracking === READER_DEFAULTS.readerTracking);
  if (!typeAtDefault) return null;
  if (s.theme === "light" && s.paper === "theme" && s.warmth === 0) return "day";
  if (s.theme === "light" && s.paper === "sepia" && s.warmth === 12) return "comfort";
  if (s.theme === "dark" && s.paper === "gray" && s.warmth === 0) return "night";
  return null;
}

export function nearestStep(
  options: readonly { value: number }[],
  current: number,
): number {
  return options.reduce((a, b) =>
    Math.abs(b.value - current) < Math.abs(a.value - current) ? b : a,
  ).value;
}

/** What the type will look like, for the sample both surfaces show.
 *
 *  Both had their own copy of this and had already begun to differ. A sample
 *  is a promise about the page, so two samples that disagree means at least
 *  one of them is lying — and the one that drifts is the one nobody looks at
 *  while changing the other. */
export function previewTypeStyle(
  s: {
    fontStack: string;
    size: number;
    leading: number;
    tracking: number;
    justify: boolean;
    width?: number;
    paraGap?: number;
    indent?: number;
    orientation?: string;
    typeset?: string;
    adjust?: string;
  },
): Record<string, string> {
  const style: Record<string, string> = {
    fontFamily: s.fontStack,
    fontSize: `${s.size}px`,
    lineHeight: `${s.leading}px`,
    letterSpacing: `${s.tracking}px`,
    textAlign: s.justify ? "justify" : "start",
  };
  if (s.paraGap != null) {
    const gap = s.typeset === "web" ? s.paraGap * 1.5 : s.paraGap;
    style.marginBlockEnd = `${gap}px`;
  }
  // Stamp even 0em: the sample otherwise inherits a book-CSS indent and lies.
  if (s.adjust) style.fontSize = `calc(${s.size}px + ${s.adjust})`;
  // A book chapter's opening line is flush (dropcap-target); the sample is
  // one paragraph and must not lie by indenting that first line.
  if (s.indent != null) {
    style.textIndent =
      s.typeset === "book" && s.orientation !== "vertical" ? "0" : `${s.indent}em`;
  }
  // Show the measure as a fraction of the hero sheet, not capped at the
  // setting's own minimum (520), which made the slider appear dead.
  if (s.width != null) {
    const t = Math.min(1, Math.max(0, (s.width - 520) / (1920 - 520)));
    style.maxWidth = `${Math.round(56 + t * 44)}%`;
  }
  if (s.orientation === "vertical") {
    style.writingMode = "vertical-rl";
    style.textOrientation = "mixed";
    style.textAlign = "start";
    if (s.width != null) {
      const t = Math.min(1, Math.max(0, (s.width - 520) / (1920 - 520)));
      style.maxHeight = `${Math.round(120 + t * 100)}px`;
      delete style.maxWidth;
    }
  }
  return style;
}
