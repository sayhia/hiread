import { describe, expect, it } from "vitest";
import { findFolded, foldSearch } from "./searchFold";

describe("foldSearch", () => {
  it("collapses case, whitespace and entities", () => {
    expect(foldSearch("Hello&nbsp;WORLD")).toBe("hello world");
    expect(foldSearch("  a   b\nc  ")).toBe("a b c");
  });
});

describe("findFolded", () => {
  it("finds a mixed-case needle in wrapped text", () => {
    const raw = "I went to the\nWoods because I wished";
    expect(findFolded(raw, "the woods")).toBe(raw.toLowerCase().indexOf("the"));
  });

  it("returns -1 when nothing matches", () => {
    expect(findFolded("hello", "xyz")).toBe(-1);
    expect(findFolded("ab", "a")).toBe(-1);
  });
});
