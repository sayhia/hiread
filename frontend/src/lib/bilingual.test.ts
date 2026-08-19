// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { topLevelBlocks, interleaveBlocks } from "./bilingual";

describe("topLevelBlocks", () => {
  it("splits a chapter into the blocks the backend translates", () => {
    const html = "<h2>Economy</h2><p>One.</p><p>Two.</p>";
    expect(topLevelBlocks(html)).toEqual(["<h2>Economy</h2>", "<p>One.</p>", "<p>Two.</p>"]);
  });

  // A converted EPUB routinely wraps the whole chapter in one container. Left
  // wrapped, the chapter would be a single block and pair with nothing.
  it("unwraps a lone generic container, however deep", () => {
    const html = '<div class="chapter"><section><p>One.</p><p>Two.</p></section></div>';
    expect(topLevelBlocks(html)).toEqual(["<p>One.</p>", "<p>Two.</p>"]);
  });

  it("keeps a container that holds real siblings", () => {
    const html = "<div><p>One.</p></div><p>Two.</p>";
    expect(topLevelBlocks(html)).toEqual(["<div><p>One.</p></div>", "<p>Two.</p>"]);
  });

  it("has nothing to split in an empty chapter", () => {
    expect(topLevelBlocks("")).toEqual([]);
  });
});

describe("interleaveBlocks", () => {
  it("puts each translation under its own paragraph", () => {
    const out = interleaveBlocks(["<p>甲</p>", "<p>乙</p>"], ["<p>A</p>", "<p>B</p>"]);
    expect(out).toBe(
      '<div class="bi-pair"><div class="bi-src"><p>甲</p></div><div class="bi-tr"><p>A</p></div></div>' +
        '<div class="bi-pair"><div class="bi-src"><p>乙</p></div><div class="bi-tr"><p>B</p></div></div>',
    );
  });

  // Most of a chapter is unpaired while the translation streams in; those
  // paragraphs show the original alone, so the page fills from the top rather
  // than appearing all at once at the end.
  it("shows an unpaired original on its own", () => {
    const out = interleaveBlocks(["<p>甲</p>", "<p>乙</p>"], ["<p>A</p>"]);
    expect(out).toContain('<div class="bi-src"><p>乙</p></div></div>');
    expect(out.match(/bi-pair/g)).toHaveLength(2);
    expect(out.match(/bi-tr/g)).toHaveLength(1);
  });

  it("pairs nothing when nothing has arrived", () => {
    const out = interleaveBlocks(["<p>甲</p>"], []);
    expect(out).toBe('<div class="bi-pair"><div class="bi-src"><p>甲</p></div></div>');
  });
});
