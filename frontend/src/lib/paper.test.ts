import { describe, it, expect } from "vitest";
import { inkFor, luminance } from "./paper";

// The reader picks the page, not the text on it — so a pick can never end as
// pale grey on white, or dark grey on midnight blue.
describe("ink for a chosen page colour", () => {
  it("puts dark ink on a light page and light ink on a dark one", () => {
    expect(inkFor("#FFFFFF").ink).toBe(inkFor("#F2EFE6").ink);
    expect(luminance("#FFFFFF")).toBeGreaterThan(0.45);
    expect(luminance("#101418")).toBeLessThan(0.45);
    // Same family, opposite ends.
    const light = inkFor("#F2EFE6");
    const dark = inkFor("#101418");
    expect(luminance(light.ink)).toBeLessThan(0.45);
    expect(luminance(dark.ink)).toBeGreaterThan(0.45);
  });

  // Weighted per channel, because a saturated blue at the same numeric value
  // as a green reads far darker. Averaging the channels calls both "light" and
  // puts black text on the blue.
  it("reads a saturated blue as dark and a saturated green as light", () => {
    expect(luminance("#0000FF")).toBeLessThan(0.45);
    expect(luminance("#00FF00")).toBeGreaterThan(0.45);
    expect(luminance(inkFor("#0000FF").ink)).toBeGreaterThan(0.45); // light ink
    expect(luminance(inkFor("#00FF00").ink)).toBeLessThan(0.45); // dark ink
  });

  it("carries the supporting tones in the same direction", () => {
    for (const page of ["#FFFFFF", "#101418"]) {
      const p = inkFor(page);
      const pageIsLight = luminance(page) > 0.45;
      // Secondary text sits between the ink and the page, never past either.
      expect(luminance(p.ink2) < 0.45).toBe(pageIsLight);
      expect(luminance(p.muted) < 0.45).toBe(pageIsLight);
      expect(p.hair).toContain(pageIsLight ? "0,0,0" : "255,255,255");
    }
  });

  it("treats a value it cannot read as a light page", () => {
    // A corrupted stored value must not produce light ink on a light page.
    for (const junk of ["", "chartreuse", "#12345", "#gggggg"]) {
      expect(luminance(junk)).toBeGreaterThan(0.45);
      expect(luminance(inkFor(junk).ink)).toBeLessThan(0.45);
    }
  });
});
