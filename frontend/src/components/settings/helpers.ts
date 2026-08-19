// Shared pure helpers for the Settings sections.

// Auto-refresh "off" is stored as a year-long interval — the only lever the
// backend scheduler exposes (it reads `refresh_interval_min`, minimum 5).
export const OFF_INTERVAL = 525600;

/**
 * A persisted numeric setting, coerced into the range its `<Slider>` accepts.
 * Settings live in the backend DB and are normally written numeric, but a stale
 * value from an older build with different slider limits — or a corrupt
 * non-numeric value — would otherwise flow straight into a `<Slider>`: an
 * out-of-range value pins the thumb at the limit while the readout shows a
 * contradicting number, and a NaN renders the value as a literal "NaN". This
 * mirrors the store's `ls.num`, which validates the localStorage-backed reader
 * sliders for exactly the same reason.
 */
export function clampSetting(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Bytes → human-readable size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
