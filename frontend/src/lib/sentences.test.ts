import { describe, it, expect } from "vitest";
import { splitSentences, sentenceAt } from "./sentences";

const texts = (s: string) => splitSentences(s).map((x) => x.text);

describe("splitting a chapter for reading aloud", () => {
  it("splits on the full-width marks Chinese ends sentences with", () => {
    expect(texts("我读中国历史，发现了许多罅漏。心想古来成功的人，必定有秘诀！是吗？")).toEqual([
      "我读中国历史，发现了许多罅漏。",
      "心想古来成功的人，必定有秘诀！",
      "是吗？",
    ]);
  });

  it("keeps a closing quote with the sentence it closes", () => {
    expect(texts("他说：“得之矣。”然后走了。")).toEqual(["他说：“得之矣。”", "然后走了。"]);
  });

  it("does not end a sentence inside a number or an abbreviation", () => {
    expect(texts("It cost 3.5 million. Mr. Smith paid.")).toEqual(["It cost 3.5 million.", "Mr. Smith paid."]);
  });

  it("treats a line of its own as a sentence", () => {
    expect(texts("第一章\n正文开始")).toEqual(["第一章", "正文开始"]);
  });

  // A voice handed a whole page cannot be stopped part-way through it.
  it("breaks prose that never ends, preferring a comma", () => {
    const long = "甲乙丙丁戊己庚辛壬癸，".repeat(20);
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(120);
    // Broken at commas, so each piece still reads as language.
    expect(parts.slice(0, -1).every((p) => p.text.endsWith("，"))).toBe(true);
    // And nothing is lost in the breaking.
    expect(parts.map((p) => p.text).join("")).toBe(long.trim());
  });

  it("breaks outright when there is nowhere better", () => {
    const wall = "甲".repeat(400);
    const parts = splitSentences(wall);
    expect(parts.map((p) => p.text).join("")).toBe(wall);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(120);
  });

  it("offsets point back at the text they came from", () => {
    const text = "  第一句。 第二句。";
    for (const s of splitSentences(text)) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it("has nothing to read in an empty chapter", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });

  it("finds the sentence an offset falls in, so reading starts on screen", () => {
    const text = "第一句。第二句。第三句。";
    const s = splitSentences(text);
    expect(sentenceAt(s, 0)).toBe(0);
    expect(sentenceAt(s, 5)).toBe(1);
    expect(sentenceAt(s, 999)).toBe(2);
  });
});
