import { describe, it, expect } from "vitest";
import { findInPages, joinTextItems } from "./pdfSearch";

const strip = (s: string) => s.replace(/<\/?mark>/g, "");

describe("finding a passage in a PDF", () => {
  it("reports the page and the line around the match", () => {
    const pages = ["封面", "第一章　我不是教你诈，是教你看清楚人心的真相。", "第二章"];
    const [hit] = findInPages(pages, "教你诈");
    expect(hit.page).toBe(2);
    expect(hit.snippet).toContain("<mark>教你诈</mark>");
    expect(strip(hit.snippet)).toContain("我不是教你诈，是教你");
  });

  it("matches without regard to case, and without word boundaries", () => {
    expect(findInPages(["The Quick Brown"], "quick")).toHaveLength(1);
    // Chinese has no word boundaries; a substring must still match.
    expect(findInPages(["社会上的诈"], "上的")).toHaveLength(1);
  });

  it("caps what one page can contribute", () => {
    const many = Array(40).fill("诈").join("，");
    const hits = findInPages([many], "诈");
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.every((h) => h.page === 1)).toBe(true);
  });

  it("stops at the limit", () => {
    const pages = Array.from({ length: 100 }, () => "诈");
    expect(findInPages(pages, "诈", 12)).toHaveLength(12);
  });

  // The text comes out of the file, and the snippet is rendered as HTML.
  it("escapes the document's own text", () => {
    const [hit] = findInPages(['前<script>alert("x")</script>诈后'], "诈");
    expect(hit.snippet).not.toContain("<script>");
    expect(hit.snippet).toContain("&lt;script&gt;");
    // The mark this puts in is the only markup in it.
    expect(hit.snippet.match(/<[a-z/]/gi)).toEqual(["<m", "</"]);
  });

  it("marks a match that is itself markup-looking text", () => {
    const [hit] = findInPages(["a <b> c"], "<b>");
    expect(hit.snippet).toContain("<mark>&lt;b&gt;</mark>");
  });

  it("has nothing to say about an empty query", () => {
    expect(findInPages(["anything"], "")).toEqual([]);
    expect(findInPages(["anything"], "   ")).toEqual([]);
  });

  it("marks where the text was cut", () => {
    const long = "前".repeat(80) + "诈" + "后".repeat(80);
    const [hit] = findInPages([long], "诈");
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
  });
});

// The join at a line end decides whether a search finds anything. English
// breaks lines between words; Chinese breaks them inside phrases.
describe("joining the runs behind a page", () => {
  const items = (...runs: [string, boolean][]) => runs.map(([str, hasEOL]) => ({ str, hasEOL }));

  it("keeps a Chinese phrase whole across a line break", () => {
    const text = joinTextItems(items(["我特意选出自", true], ["部具有代表性的作品", false]));
    expect(text).toBe("我特意选出自部具有代表性的作品");
    // Which is the point: the phrase spanning the break is still findable.
    expect(findInPages([text], "选出自部")).toHaveLength(1);
  });

  it("keeps English words apart across a line break", () => {
    const text = joinTextItems(items(["the quick brown", true], ["fox jumps", false]));
    expect(text).toBe("the quick brown\nfox jumps");
    expect(findInPages([text], "brownfox")).toHaveLength(0);
    expect(findInPages([text], "fox")).toHaveLength(1);
  });

  it("marks the boundary when the scripts differ across it", () => {
    expect(joinTextItems(items(["第一章", true], ["Introduction", false]))).toBe("第一章\nIntroduction");
    expect(joinTextItems(items(["chapter", true], ["一", false]))).toBe("chapter\n一");
  });

  it("joins the runs within a line as they come", () => {
    // Their own trailing spaces separate what needs separating; adding more
    // would put gaps inside Chinese that were never there.
    expect(joinTextItems(items(["我不是", false], ["教你诈", false]))).toBe("我不是教你诈");
    expect(joinTextItems(items(["hello ", false], ["world", false]))).toBe("hello world");
  });

  it("does not end a page with a dangling break", () => {
    expect(joinTextItems(items(["末尾", true]))).toBe("末尾");
    expect(joinTextItems([])).toBe("");
  });
});
