// Pure, DOM-free helpers behind the Reading Notes panel's Review and Digest
// tabs. Every function takes its "current time" or "seed" as an explicit
// parameter rather than reading Date.now() / Math.random() internally, so
// the whole module is deterministic and unit-testable without mocking
// globals.

import type { HighlightWithContext } from "../types";

const DAY_MS = 86_400_000;

/** Buckets of highlights resurfaced from three fixed lookback windows.
 *  Each window is wide (not a single day) so a day with zero highlights
 *  doesn't leave its bucket empty — the point is "something to reread",
 *  not "exactly N days ago". A highlight can land in at most one bucket:
 *  the windows below do not overlap by construction (5d/2d, 21d/10d,
 *  90d/45d — each `to` edge is closer to `now` than the next window's
 *  `from` edge). */
export interface ReviewBuckets {
  threeDays: HighlightWithContext[];
  twoWeeks: HighlightWithContext[];
  twoMonths: HighlightWithContext[];
}

function inWindow(createdAt: string, now: number, fromDaysAgo: number, toDaysAgo: number): boolean {
  const t = Date.parse(createdAt);
  const from = now - fromDaysAgo * DAY_MS;
  const to = now - toDaysAgo * DAY_MS;
  return t >= from && t <= to;
}

export function bucketize(rows: HighlightWithContext[], now: number = Date.now()): ReviewBuckets {
  return {
    threeDays: rows.filter((h) => inWindow(h.createdAt, now, 5, 2)),
    twoWeeks: rows.filter((h) => inWindow(h.createdAt, now, 21, 10)),
    twoMonths: rows.filter((h) => inWindow(h.createdAt, now, 90, 45)),
  };
}

/** Deterministic Fisher-Yates shuffle seeded by a string, returning at most
 *  `count` items. The seed is typically "<today's date>#<reshuffle count>"
 *  so the same day shows the same sample until the user asks for a new one.
 *  Uses a small string hash to seed a mulberry32-style PRNG — no external
 *  dependency, good-enough distribution for a 5-of-N pick, not
 *  cryptographic. */
export function sample<T>(items: T[], seed: string, count: number): T[] {
  if (items.length <= count) return items.slice();
  let s = 0;
  for (let i = 0; i < seed.length; i++) {
    s = (Math.imul(s, 31) + seed.charCodeAt(i)) | 0;
  }
  const rng = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

/** Rows with createdAt in [fromISO, toISO) — inclusive of from, exclusive
 *  of to. Mirrors the backend's SearchAllHighlightsInRange boundary
 *  semantics exactly, so a caller can use either interchangeably. */
export function filterRange(
  rows: HighlightWithContext[],
  fromISO: string,
  toISO: string,
): HighlightWithContext[] {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  return rows.filter((h) => {
    const t = Date.parse(h.createdAt);
    return t >= from && t < to;
  });
}

// hiread ships exactly 3 locales (see frontend/src/locales/{en,ja,zh}.json).
// This maps each to hiread's chosen week-start day for the Digest tab: 0
// (Sunday) for en, 1 (Monday) for ja/zh. Deliberately NOT delegated to
// Intl.Locale.prototype.getWeekInfo() — that API's underlying ICU data is
// inconsistent across platforms/versions for ja (observed returning Sunday
// on some runtimes, Monday on others), which would make "this week" shift
// depending on the user's OS rather than hiread's own locale setting. A
// fixed table keeps the Digest tab's week boundary deterministic and
// testable regardless of host ICU data.
const WEEK_START_DAY: Record<string, number> = {
  en: 0, // Sunday
  ja: 1, // Monday
  zh: 1, // Monday
};

/** The most recent week-start (midnight, local time) for `locale`, per
 *  hiread's fixed WEEK_START_DAY table. Unknown locale prefixes fall back to
 *  Monday (ISO-8601 default). `locale` is matched by its language subtag
 *  (e.g. "zh-CN" -> "zh"), so any regional variant of hiread's 3 shipped
 *  locales resolves correctly. */
export function weekStart(locale: string, now: Date = new Date()): Date {
  const lang = locale.split("-")[0].toLowerCase();
  const firstDay = WEEK_START_DAY[lang] ?? 1;
  const d = new Date(now);
  const diff = (d.getDay() - firstDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

