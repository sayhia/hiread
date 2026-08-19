// @vitest-environment node

import { describe, it, expect } from "vitest";
import { APP_ICONS, iconPng, iconSvg, isAppIcon } from "./appIcon";

describe("app icon variants", () => {
  it("names the two official palettes", () => {
    expect(APP_ICONS).toEqual(["night", "dawn", "gold", "platinum"]);
  });

  it("accepts only those names", () => {
    expect(isAppIcon("night")).toBe(true);
    expect(isAppIcon("dawn")).toBe(true);
    expect(isAppIcon("gold")).toBe(true);
    expect(isAppIcon("platinum")).toBe(true);
    expect(isAppIcon("dusk")).toBe(false);
    expect(isAppIcon("")).toBe(false);
  });

  it("points each palette at its public assets", () => {
    expect(iconPng("night")).toBe("/icons/night.png");
    expect(iconSvg("dawn")).toBe("/icons/dawn.svg");
  });
});
