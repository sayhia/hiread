// Unit tests for the font-choice resolver. `fonts.ts` is pure and DOM-free.

import { describe, it, expect } from "vitest";
import { resolveReaderFont, resolveUiFont, fontFaceCss } from "./fonts";
import type { InstalledFont } from "../../bindings/hiread/internal/db/models";

const installed: InstalledFont[] = [
  {
    id: "lxgw-wenkai", family: "LXGW WenKai", label: "霞鹜文楷", category: "handwriting",
    cjk: true, axis: "reader", license: "OFL-1.1", source: "", file: "lxgw-wenkai.ttf",
    ext: "ttf", bytes: 19500000,
  } as InstalledFont,
];

describe("resolveReaderFont", () => {
  it("returns the bundled face with its optical adjust", () => {
    expect(resolveReaderFont("serif", [])).toEqual({ stack: "var(--serif)", adjust: "0px" });
    expect(resolveReaderFont("hyperlegible", []).stack).toContain("Atkinson Hyperlegible");
  });

  it("wraps a system font name with fallbacks", () => {
    const r = resolveReaderFont("system:Songti SC", []);
    expect(r.stack.startsWith("'Songti SC',")).toBe(true);
    expect(r.stack).toContain("PingFang SC"); // CJK fallback
    expect(r.adjust).toBe("0px");
  });

  it("resolves a downloaded font by id to its family", () => {
    expect(resolveReaderFont("downloaded:lxgw-wenkai", installed).stack.startsWith("'LXGW WenKai',")).toBe(true);
  });

  it("falls back to bundled sans for an unknown / deleted choice", () => {
    expect(resolveReaderFont("downloaded:gone", installed)).toEqual(resolveReaderFont("sans", []));
  });

  it("neutralizes quotes in a family name (no CSS break-out)", () => {
    // The injected quote is stripped, so the dangerous "Evil'" can't appear and
    // close the CSS string early — only the resolver's own wrapping quotes do.
    const stack = resolveReaderFont("system:Evil', x", []).stack;
    expect(stack).not.toContain("Evil'");
    expect(stack.startsWith("'Evil, x',")).toBe(true);
  });
});

describe("resolveUiFont", () => {
  it("returns null for the default (no --ui override)", () => {
    expect(resolveUiFont("default", [])).toBeNull();
    expect(resolveUiFont("", [])).toBeNull();
  });

  it("never references var(--ui) (would be circular when set on --ui)", () => {
    const s = resolveUiFont("system:Helvetica Neue", []);
    expect(s).not.toContain("var(--ui)");
    expect(s!.startsWith("'Helvetica Neue',")).toBe(true);
  });

  it("resolves a downloaded font, null when the id is gone", () => {
    expect(resolveUiFont("downloaded:lxgw-wenkai", installed)!).toContain("LXGW WenKai");
    expect(resolveUiFont("downloaded:gone", installed)).toBeNull();
  });
});

describe("fontFaceCss", () => {
  it("emits an @font-face pointing at /userfonts with the right format", () => {
    const css = fontFaceCss(installed);
    expect(css).toContain("@font-face");
    expect(css).toContain("font-family:'LXGW WenKai'");
    expect(css).toContain("url('/userfonts/lxgw-wenkai.ttf') format('truetype')");
  });
  it("is empty with no installed fonts", () => {
    expect(fontFaceCss([])).toBe("");
  });
});
