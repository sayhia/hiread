import { describe, it, expect } from "vitest";
import { tonePixels, toneFor, type PageTone } from "./pdfPaper";

/** One pixel, as the canvas holds them. */
const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);
const rgb = (d: Uint8ClampedArray) => [d[0], d[1], d[2]];

const toned = (p: number[], tone: PageTone) => {
  const d = px(p[0], p[1], p[2]);
  tonePixels(d, tone);
  return rgb(d);
};

describe("putting a page on the reader's paper", () => {
  it("turns the paper dark and the ink light", () => {
    expect(toned([255, 255, 255], "invert")).toEqual([0, 0, 0]);
    expect(toned([0, 0, 0], "invert")).toEqual([255, 255, 255]);
    // Mid greys pass through the middle, so nothing flattens.
    expect(toned([128, 128, 128], "invert")).toEqual([127, 127, 127]);
  });

  // The whole reason this is not a CSS invert filter.
  it("leaves a photograph alone", () => {
    const skin = [214, 158, 120];
    const sky = [86, 140, 214];
    expect(toned(skin, "invert")).toEqual(skin);
    expect(toned(sky, "invert")).toEqual(sky);
  });

  it("still catches paper that is not perfectly neutral", () => {
    // A scan's white is never 255,255,255.
    const scanWhite = [247, 244, 238];
    const out = toned(scanWhite, "invert");
    expect(out[0]).toBeLessThan(20);
  });

  it("colours the paper and leaves the ink where it is", () => {
    const [r, g, b] = toned([255, 255, 255], "sepia");
    expect([r, g, b]).toEqual([0xf3, 0xe9, 0xd4]);
    // Black text stays black rather than being washed towards the tint.
    expect(toned([0, 0, 0], "sepia")).toEqual([0, 0, 0]);
    // And a picture is still untouched.
    expect(toned([86, 140, 214], "sepia")).toEqual([86, 140, 214]);
  });

  it("does nothing at all when nothing was asked for", () => {
    const d = px(12, 240, 3);
    tonePixels(d, "none");
    expect(rgb(d)).toEqual([12, 240, 3]);
  });

  it("follows the reading surface the reader chose", () => {
    expect(toneFor("theme", false)).toBe("none");
    expect(toneFor("theme", true)).toBe("invert");
    expect(toneFor("sepia", false)).toBe("sepia");
    expect(toneFor("green", true)).toBe("green");
    expect(toneFor("gray", false)).toBe("invert");
    expect(toneFor("black", false)).toBe("invert");
    // A colour the reader picked: dark ones invert, light ones are left as
    // printed rather than tinted towards a hue nobody asked the page for.
    expect(toneFor("custom", true, "#F3E9D4")).toBe("none");
    expect(toneFor("custom", false, "#101418")).toBe("invert");
    expect(toneFor("custom", true)).toBe("invert");
    expect(toneFor("custom", false)).toBe("none");
  });

  it("runs over a whole page without touching the alpha channel", () => {
    const page = new Uint8ClampedArray(4 * 1000);
    for (let i = 0; i < page.length; i += 4) {
      page[i] = page[i + 1] = page[i + 2] = 255;
      page[i + 3] = 255;
    }
    tonePixels(page, "invert");
    for (let i = 0; i < page.length; i += 4) {
      expect(page[i]).toBe(0);
      expect(page[i + 3]).toBe(255);
    }
  });
});
