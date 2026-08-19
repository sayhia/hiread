// Deriving a readable page from one chosen colour.
//
// The custom page colour asks the reader for the ground only. Asking for the
// ink as well is asking them to get it right — and pale grey on white is one
// slip away. So the ink follows the ground: dark ink on a light page, light on
// a dark one, with the supporting tones (secondary text, hairlines) coming
// along in the same direction.

export interface PaperInk {
  ink: string;
  ink2: string;
  muted: string;
  hair: string;
}

/** Perceived luminance of a #rrggbb colour, 0–1. Weighted per channel because
 *  green reads far lighter than blue at the same value — averaging them calls
 *  a saturated blue "light" and puts black text on it. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1; // unreadable input is treated as a light page
  const v = m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The ink a page of this colour should carry. */
export function inkFor(hex: string): PaperInk {
  return luminance(hex) > 0.45
    ? { ink: "#22262C", ink2: "#3C424B", muted: "#6B7280", hair: "rgba(0,0,0,.10)" }
    : { ink: "#DEE3EA", ink2: "#C2C8D1", muted: "#8A929C", hair: "rgba(255,255,255,.10)" };
}
