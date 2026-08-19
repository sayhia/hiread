// Date formatting for the UI: a compact relative stamp for lists, and a
// long-form date for detail views. Both follow the app language rather than the
// OS locale, so a user reading hiread in Chinese sees Chinese dates.

import i18n, { currentLocale } from "../i18n";

/** Maps the active app language to a BCP-47 locale for date formatting. */
function dateLocale(): string {
  const lang = currentLocale();
  return ({ zh: "zh-CN", en: "en-US", ja: "ja-JP" } as Record<string, string>)[lang] ?? "en-US";
}

/** Compact relative timestamp ("just now", "3h", "2d", or a date). */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = (Date.now() - d.getTime()) / 60000;
  // The unit suffixes are localised — Japanese / Chinese users expect 時間 /
  // 小时, not a bare latin "h" — keeping the relative bucket in step with the
  // already-localised "just now" label and calendar-date fallback below.
  if (mins < 1) return i18n.global.t("common.justNow");
  if (mins < 60) return i18n.global.t("common.relMinutes", { count: Math.floor(mins) });
  if (mins < 1440) return i18n.global.t("common.relHours", { count: Math.floor(mins / 60) });
  if (mins < 1440 * 7) return i18n.global.t("common.relDays", { count: Math.floor(mins / 1440) });
  // Beyond a week, show the calendar date — with the year for anything not from
  // the current year, so an old highlight isn't ambiguously dated.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(dateLocale(), {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Long-form date, for detail views. */
export function fullDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(dateLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
