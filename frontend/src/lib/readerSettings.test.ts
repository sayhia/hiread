// @vitest-environment node

import { describe, it, expect } from "vitest";
import {
  READER_DEFAULTS,
  READER_LEADING_STEPS,
  linkedPadY,
  nearestStep,
} from "./readerSettings";

describe("readerSettings", () => {
  it("keeps the numbers the page has always booted with", () => {
    expect(READER_DEFAULTS.readerSize).toBe(17);
    expect(READER_DEFAULTS.readerLeading).toBe(28);
    expect(READER_DEFAULTS.readerWidth).toBe(680);
    expect(READER_DEFAULTS.readerTracking).toBe(0);
    expect(READER_DEFAULTS.readerParaGap).toBe(18);
    expect(READER_DEFAULTS.readerPadX).toBe(52);
    expect(READER_DEFAULTS.readerPadY).toBe(40);
    expect(READER_DEFAULTS.readerFont).toBe("sans");
    expect(READER_DEFAULTS.readerPaper).toBe("theme");
  });

  it("picks the nearest named step", () => {
    expect(nearestStep(READER_LEADING_STEPS, 28)).toBe(28);
    expect(nearestStep(READER_LEADING_STEPS, 30)).toBe(28);
    expect(nearestStep(READER_LEADING_STEPS, 34)).toBe(36);
  });

  it("links vertical margin to horizontal at the default sheet ratio", () => {
    expect(linkedPadY(52)).toBe(40);
    expect(linkedPadY(28)).toBe(Math.round(28 * 0.77));
  });
});
