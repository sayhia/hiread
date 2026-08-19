// Unit tests for the Review/Digest pure-function helpers. All DOM-free and
// deterministic — no Date.now() or Math.random() calls escape these
// functions' own seeded/injected-time parameters, so every test controls
// its own clock and randomness explicitly.

import { describe, it, expect } from "vitest";
import { bucketize, sample, filterRange, weekStart } from "./highlightBuckets";
import type { HighlightWithContext } from "../types";

function makeHighlight(overrides: Partial<HighlightWithContext>): HighlightWithContext {
  return {
    id: 1,
    bookId: 1,
    chapterIndex: 0,
    quote: "quote",
    prefix: "",
    suffix: "",
    textOffset: 0,
    color: "yellow",
    note: "",
    createdAt: "2026-07-01T00:00:00Z",
    bookTitle: "Book",
    bookAuthor: "Author",
    chapterTitle: "Chapter",
    ...overrides,
  };
}

describe("bucketize", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-07-01T00:00:00Z");

  it("places a highlight from 3 days ago in the threeDays bucket", () => {
    const h = makeHighlight({ id: 1, createdAt: new Date(now - 3 * DAY).toISOString() });
    const buckets = bucketize([h], now);
    expect(buckets.threeDays.map((r) => r.id)).toEqual([1]);
    expect(buckets.twoWeeks).toEqual([]);
    expect(buckets.twoMonths).toEqual([]);
  });

  it("places a highlight from 14 days ago in the twoWeeks bucket", () => {
    const h = makeHighlight({ id: 2, createdAt: new Date(now - 14 * DAY).toISOString() });
    const buckets = bucketize([h], now);
    expect(buckets.twoWeeks.map((r) => r.id)).toEqual([2]);
    expect(buckets.threeDays).toEqual([]);
    expect(buckets.twoMonths).toEqual([]);
  });

  it("places a highlight from 60 days ago in the twoMonths bucket", () => {
    const h = makeHighlight({ id: 3, createdAt: new Date(now - 60 * DAY).toISOString() });
    const buckets = bucketize([h], now);
    expect(buckets.twoMonths.map((r) => r.id)).toEqual([3]);
    expect(buckets.threeDays).toEqual([]);
    expect(buckets.twoWeeks).toEqual([]);
  });

  it("excludes a highlight from today (outside every window)", () => {
    const h = makeHighlight({ id: 4, createdAt: new Date(now).toISOString() });
    const buckets = bucketize([h], now);
    expect(buckets.threeDays).toEqual([]);
    expect(buckets.twoWeeks).toEqual([]);
    expect(buckets.twoMonths).toEqual([]);
  });

  it("a highlight can only land in one bucket even near a window edge", () => {
    // 10 days ago sits exactly at the twoWeeks window's near edge (now-21d..now-10d)
    // and outside the threeDays window (now-5d..now-2d) — must not double-count.
    const h = makeHighlight({ id: 5, createdAt: new Date(now - 10 * DAY).toISOString() });
    const buckets = bucketize([h], now);
    const total = buckets.threeDays.length + buckets.twoWeeks.length + buckets.twoMonths.length;
    expect(total).toBe(1);
    expect(buckets.twoWeeks.map((r) => r.id)).toEqual([5]);
  });
});

describe("sample", () => {
  it("returns all items unchanged when items.length <= count", () => {
    const items = [1, 2, 3];
    expect(sample(items, "seed", 5)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(sample(items, "seed", 5)).toHaveLength(3);
  });

  it("is deterministic for the same seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = sample(items, "2026-07-01", 5);
    const b = sample(items, "2026-07-01", 5);
    expect(a).toEqual(b);
  });

  it("produces a different order/selection for a different seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = sample(items, "2026-07-01#0", 5);
    const b = sample(items, "2026-07-01#1", 5);
    expect(a).not.toEqual(b);
  });

  it("never returns more than count items", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(sample(items, "seed", 5)).toHaveLength(5);
  });
});

describe("filterRange", () => {
  it("includes a row exactly at `from`", () => {
    const h = makeHighlight({ id: 1, createdAt: "2026-07-01T00:00:00Z" });
    const result = filterRange([h], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z");
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it("excludes a row exactly at `to`", () => {
    const h = makeHighlight({ id: 2, createdAt: "2026-07-08T00:00:00Z" });
    const result = filterRange([h], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z");
    expect(result.map((r) => r.id)).toEqual([]);
  });

  it("includes a row strictly between from and to", () => {
    const h = makeHighlight({ id: 3, createdAt: "2026-07-04T00:00:00Z" });
    const result = filterRange([h], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z");
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it("excludes rows entirely outside the range", () => {
    const before = makeHighlight({ id: 4, createdAt: "2026-06-01T00:00:00Z" });
    const after = makeHighlight({ id: 5, createdAt: "2026-08-01T00:00:00Z" });
    const result = filterRange([before, after], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z");
    expect(result).toEqual([]);
  });
});

// Formats a Date using its LOCAL calendar components (not toISOString,
// which converts to UTC and can shift the displayed date by one day
// depending on the test runner's timezone offset — weekStart's contract is
// about local midnight, so comparisons must stay in local time too).
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("weekStart", () => {
  // New Date(2026, 6, 1) is July 1, 2026 (month is 0-indexed) — a Wednesday,
  // constructed from local components so every assertion below stays in the
  // same local timezone as the input, regardless of where the suite runs.
  const wednesday = new Date(2026, 6, 1, 12, 0, 0);

  it("resolves to the preceding Monday for zh-CN", () => {
    const d = weekStart("zh-CN", wednesday);
    expect(localDateString(d)).toBe("2026-06-29"); // Monday
  });

  it("resolves to the preceding Monday for zh-CN with a regional suffix", () => {
    // "zh-CN" and bare "zh" must resolve identically — weekStart matches on
    // the language subtag only.
    const d = weekStart("zh-TW", wednesday);
    expect(localDateString(d)).toBe("2026-06-29"); // Monday
  });

  it("resolves to the preceding Monday for ja-JP", () => {
    const d = weekStart("ja-JP", wednesday);
    expect(localDateString(d)).toBe("2026-06-29"); // Monday
  });

  it("resolves to the preceding Sunday for en-US", () => {
    const d = weekStart("en-US", wednesday);
    expect(localDateString(d)).toBe("2026-06-28"); // Sunday
  });

  it("falls back to Monday for an unrecognized locale", () => {
    const d = weekStart("fr-FR", wednesday);
    expect(localDateString(d)).toBe("2026-06-29"); // Monday (ISO-8601 default)
  });

  it("returns the same day at midnight when now is already the week start", () => {
    const monday = new Date(2026, 5, 29, 0, 0, 0); // June 29, 2026 is a Monday
    const d = weekStart("zh-CN", monday);
    expect(localDateString(d)).toBe("2026-06-29");
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
