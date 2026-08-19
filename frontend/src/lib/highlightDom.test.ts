// Two readings of the same chapter, and they have to differ.
//
// Anchoring a highlight measures against the chapter as it was rendered,
// before any mark was laid over it. Reading it aloud measures against the
// chapter as it reads. Using one for the other is how the voice came to skip
// exactly the passages the reader had marked.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { plainText, readingText, rangesFor,
  anchorRect, applyHighlights, selectionAnchor,
} from "./highlightDom";

let body: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  body = document.createElement("div");
  // A chapter with one of the reader's own highlights already laid over it.
  body.innerHTML = '<p>前面<mark data-hl="1">被高亮的一句</mark>后面</p>';
  document.body.appendChild(body);
});

describe("the two readings of a chapter", () => {
  it("does not count the bilingual translation column in the anchor text", () => {
    body.innerHTML = '<p>原文</p><p class="bi-tr">translation</p>';
    expect(plainText(body)).toBe("原文");
  });

  it("does not turn a translation selection into an original highlight", () => {
    body.innerHTML = '<p>原文一句</p><p class="bi-tr">a translated line</p>';
    const tr = body.querySelector(".bi-tr")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(tr, 0);
    range.setEnd(tr, tr.data.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionAnchor(body)).toBeNull();
  });

  it("leaves marked text out of what highlights are anchored against", () => {
    // The offsets stored with a highlight were measured before it existed;
    // counting its own text would shift everything after it.
    expect(plainText(body)).toBe("前面后面");
  });

  it("keeps marked text in what is read aloud", () => {
    expect(readingText(body)).toBe("前面被高亮的一句后面");
  });

  it("makes ranges against the text that is read", () => {
    const text = readingText(body);
    const start = text.indexOf("被高亮");
    const ranges = rangesFor(body, start, start + 3);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("被高亮");
  });

  it("spans a range across the mark's boundary", () => {
    const text = readingText(body);
    const start = text.indexOf("面被");
    const ranges = rangesFor(body, start, start + 2);
    // One range per text node it crosses, and together they are the passage.
    expect(ranges.map((r) => r.toString()).join("")).toBe("面被");
  });

  it("reads an unmarked chapter the same way twice", () => {
    body.innerHTML = "<p>没有高亮的一章</p>";
    expect(plainText(body)).toBe(readingText(body));
  });

  // The bilingual view holds every sentence twice. Reading both sides would
  // speak the chapter and then its translation; the voice drops one column.
  it("can leave a subtree out of what is read aloud", () => {
    body.innerHTML =
      '<div class="bi-pair"><div class="bi-src"><p>原文一句。</p></div>' +
      '<div class="bi-tr"><p>A translated sentence.</p></div></div>';
    expect(readingText(body)).toContain("原文一句");
    expect(readingText(body)).toContain("A translated sentence");
    expect(readingText(body, ".bi-tr")).toBe("原文一句。");
    expect(readingText(body, ".bi-tr")).not.toContain("translated");

    // Ranges measured against the filtered text land on the kept side only.
    const text = readingText(body, ".bi-tr");
    const start = text.indexOf("原文");
    const ranges = rangesFor(body, start, start + 2, ".bi-tr");
    expect(ranges.map((r) => r.toString()).join("")).toBe("原文");
  });
});

// Measured on a two-column page: a selection crossing from one column to the
// next has a bounding box the size of the whole page, so anchoring a popover
// "just below it" puts the popover below the page — at (363, 796) on a page
// whose foot is at 788, in the corner, nowhere near the text the reader picked.
describe("where a popover goes", () => {
  function ranged(rects: Array<Partial<DOMRect>>, box: Partial<DOMRect>) {
    return {
      getClientRects: () => rects as unknown as DOMRectList,
      getBoundingClientRect: () => box as DOMRect,
    } as unknown as Range;
  }

  it("uses the line the selection ended on, not the box around all of them", () => {
    const r = anchorRect(
      ranged(
        [
          { left: 363, bottom: 300 },
          { left: 735, bottom: 314 },
        ],
        { left: 363, bottom: 788, width: 680, height: 740 },
      ),
    );
    expect(r?.left).toBe(735);
    expect(r?.bottom).toBe(314);
  });

  it("gives the same answer as the box for a selection down one column", () => {
    const last = { left: 100, bottom: 240 };
    const r = anchorRect(ranged([{ left: 100, bottom: 200 }, last], { left: 100, bottom: 240 }));
    expect(r?.left).toBe(100);
    expect(r?.bottom).toBe(240);
  });

  it("falls back to the box when there are no line rects", () => {
    const r = anchorRect(ranged([], { left: 12, bottom: 34, width: 5, height: 5 }));
    expect(r?.left).toBe(12);
  });

  it("uses the box where the engine has no line rects", () => {
    const noRects = {
      getBoundingClientRect: () => ({ left: 7, bottom: 9, width: 3, height: 3 }) as DOMRect,
    } as unknown as Range;
    expect(anchorRect(noRects)?.left).toBe(7);
  });

  it("has nothing to say about something with no box at all", () => {
    expect(anchorRect(ranged([], { left: 0, bottom: 0, width: 0, height: 0 }))).toBeNull();
  });
});

describe("applyHighlights", () => {
  const mk = (id: number, quote: string, textOffset: number) => ({
    id, bookId: 1, chapterIndex: 0, quote,
    prefix: "", suffix: "", textOffset,
    color: "yellow", note: "", createdAt: "",
  });

  it("lays several highlights in one pass, including two inside one text node", () => {
    body.innerHTML = "<p>one two three four five</p>";
    const text = plainText(body);
    const orphaned = applyHighlights(body, [
      mk(1, "two", text.indexOf("two")),
      mk(2, "four", text.indexOf("four")),
      mk(3, "one", text.indexOf("one")),
    ]);
    expect(orphaned).toEqual([]);
    const marks = body.querySelectorAll("mark[data-hl]");
    expect(marks).toHaveLength(3);
    expect(Array.from(marks).map((m) => (m as HTMLElement).dataset.hl).sort()).toEqual(["1", "2", "3"]);
    // Wrapping must not have eaten or reordered any text.
    expect(body.textContent).toBe("one two three four five");
  });

  it("keeps block structure across a range crossing several nodes", () => {
    body.innerHTML = "<p>left</p><p>middle</p><p>right</p>";
    const text = plainText(body); // "leftmiddle" + "right"
    const start = text.indexOf("middle");
    const orphaned = applyHighlights(body, [mk(7, "middle", start)]);
    expect(orphaned).toEqual([]);
    expect(body.querySelectorAll("mark[data-hl]")).toHaveLength(1);
    expect(body.querySelector("mark[data-hl='7']")?.textContent).toBe("middle");
    expect(body.textContent).toBe("leftmiddleright");
  });

  it("reports highlights it could not anchor", () => {
    body.innerHTML = "<p>only this text</p>";
    const orphaned = applyHighlights(body, [mk(9, "gone entirely", 0)]);
    expect(orphaned).toEqual([9]);
  });

  it("is idempotent", () => {
    body.innerHTML = "<p>alpha beta gamma delta</p>";
    const text = plainText(body);
    const hls = [
      mk(1, "beta", text.indexOf("beta")),
      mk(2, "delta", text.indexOf("delta")),
    ];
    applyHighlights(body, hls);
    expect(body.querySelectorAll("mark[data-hl]")).toHaveLength(2);
    // Re-applying must strip and re-lay, not double-wrap.
    applyHighlights(body, hls);
    expect(body.querySelectorAll("mark[data-hl]")).toHaveLength(2);
    expect(body.textContent).toBe("alpha beta gamma delta");
  });
});
