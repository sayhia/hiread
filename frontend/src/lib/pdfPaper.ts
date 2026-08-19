// Putting a PDF's pages on the reader's paper.
//
// Every other format is rendered into hiread's own surface, so the page colour
// setting simply is the page. A PDF's pages are pictures with the paper baked
// into them: choosing a dark page changed the surround and left a white
// rectangle burning in the middle of it.
//
// So the pixels are re-toned after the page is drawn. The naive way — a CSS
// invert filter over the canvas — flips the paper and the ink correctly and
// turns every photograph into a negative. What is wanted is to flip the page,
// not its contents: near-grey pixels are paper and ink, and everything with
// real colour in it is a picture and is left alone.

import type { ReaderPaper } from "../stores/ui";
import { luminance } from "./paper";

export type PageTone = "none" | "invert" | "sepia" | "green";

/** Which toning a page wants, given the reading surface the reader chose.
 *  "theme" follows the app: a dark app means a dark page. */
export function toneFor(paper: ReaderPaper, dark: boolean, customHex?: string): PageTone {
  switch (paper) {
    case "sepia":
      return "sepia";
    case "green":
      return "green";
    case "gray":
    case "black":
      return "invert";
    case "custom":
      // Invert from the colour itself, not the app theme: cream paper in a
      // dark window is still a light page.
      return customHex
        ? luminance(customHex) < 0.45
          ? "invert"
          : "none"
        : dark
          ? "invert"
          : "none";
    default:
      return dark ? "invert" : "none";
  }
}

/** How grey a pixel has to be before it counts as paper or ink rather than
 *  part of a picture. Newsprint scans are never perfectly neutral, so this is
 *  loose enough to catch them and tight enough to leave a colour photo alone. */
const NEUTRAL_SPREAD = 28;

/** The tint applied to white for the warm and green papers, matching the
 *  sheets those settings give every other format. */
const TINTS: Record<"sepia" | "green", [number, number, number]> = {
  sepia: [0xf3, 0xe9, 0xd4],
  green: [0xdc, 0xe9, 0xda],
};

/**
 * Re-tone a rendered page in place.
 *
 * Runs over the canvas once. Pixels that carry real colour are a picture and
 * are left as they are — which is the whole difference between this and an
 * invert filter, and the difference between a photograph and its negative.
 *
 * The tone branches sit outside the per-pixel loop: a rendered page is a few
 * million pixels, and the tint tuple and branch would otherwise be resolved
 * for every one of them.
 */
export function tonePixels(data: Uint8ClampedArray, tone: PageTone): void {
  if (tone === "none") return;
  if (tone === "invert") {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min > NEUTRAL_SPREAD) continue; // a picture, not the page
      data[i] = 255 - r;
      data[i + 1] = 255 - g;
      data[i + 2] = 255 - b;
    }
    return;
  }
  // Warm and green papers: the ink stays where it is and the paper takes the
  // colour, so the page reads as printed on it rather than washed over.
  const [tr, tg, tb] = TINTS[tone];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > NEUTRAL_SPREAD) continue; // a picture, not the page
    const level = (r + g + b) / 3 / 255;
    data[i] = Math.round(r * (1 - level) + tr * level);
    data[i + 1] = Math.round(g * (1 - level) + tg * level);
    data[i + 2] = Math.round(b * (1 - level) + tb * level);
  }
}
