import { describe, it, expect, vi } from "vitest";
import { flattenPdfOutline } from "./pdfOutline";

/** A resolver standing in for pdf.js: named destinations map to pages, and
 *  anything else is a reference it cannot follow. */
const pages: Record<string, number> = { intro: 6, ch1: 12, ch1a: 14, ch2: 40 };
const resolve = async (dest: unknown) => pages[String(dest)] ?? 0;

describe("a PDF's own contents", () => {
  it("flattens the tree, keeping the nesting as a level", async () => {
    const got = await flattenPdfOutline(
      [
        { title: "新版序", dest: "intro" },
        { title: "第一章", dest: "ch1", items: [{ title: "第一节", dest: "ch1a" }] },
        { title: "第二章", dest: "ch2" },
      ],
      resolve,
    );
    expect(got).toEqual([
      { title: "新版序", level: 0, page: 6 },
      { title: "第一章", level: 0, page: 12 },
      { title: "第一节", level: 1, page: 14 },
      { title: "第二章", level: 0, page: 40 },
    ]);
  });

  // An entry that goes to an arbitrary page is worse than one that is not
  // there: the reader loses their place finding out.
  it("drops what it cannot resolve, and keeps its children", async () => {
    const got = await flattenPdfOutline(
      [{ title: "封面", dest: "gone" }, { title: "第一章", dest: "ch1", items: [{ title: "第一节", dest: "ch1a" }] }],
      resolve,
    );
    expect(got.map((e) => e.title)).toEqual(["第一章", "第一节"]);
  });

  it("ignores entries with nothing to show", async () => {
    const got = await flattenPdfOutline(
      [{ title: "   ", dest: "ch1" }, { dest: "ch2" }, { title: "第二章", dest: "ch2" }],
      resolve,
    );
    expect(got.map((e) => e.title)).toEqual(["第二章"]);
  });

  // A few PDFs nest every paragraph. Past a few levels the outline stops being
  // a way to get around and starts being the book.
  it("stops following a tree that never ends", async () => {
    const deep = (level: number): any =>
      level > 12 ? { title: `L${level}`, dest: "ch1" } : { title: `L${level}`, dest: "ch1", items: [deep(level + 1)] };
    const got = await flattenPdfOutline([deep(0)], resolve);
    expect(got).toHaveLength(3);
    expect(Math.max(...got.map((e) => e.level))).toBe(2);
  });

  it("has nothing to show for a file with no outline", async () => {
    expect(await flattenPdfOutline(null, resolve)).toEqual([]);
    expect(await flattenPdfOutline([], resolve)).toEqual([]);
  });

  it("does not resolve a destination it will not use", async () => {
    const spy = vi.fn(resolve);
    await flattenPdfOutline([{ title: "  ", dest: "ch1" }], spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
