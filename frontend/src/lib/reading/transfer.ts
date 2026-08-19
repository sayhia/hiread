// Reading settings, out of the app and back in.
//
// A settings file is the one place a reader's preferences meet a text file
// they can edit, an older version of the app, or another machine — so nothing
// in one can be trusted. Everything here is about that: what a setting *is* is
// described in the schema, and a file is only whatever parts of it survive
// being checked against that description.
//
// Nothing is rejected wholesale. A file with one bad line is still a file with
// twenty good ones, and a reader who moved machines wants their type size back
// even if a setting they had has since been renamed. What is dropped is
// reported, so it can be said out loud rather than silently ignored.

import {
  BOUNDS,
  CLOBBERED,
  READING_SETTINGS,
  migrateLeading,
  migrateParaGap,
  migrateTracking,
  type ReadingSettingKey,
  type Setting,
} from "./schema";

/** What a settings file looks like. The version is for a future reader of an
 *  older file — it is not used to refuse one. */
export interface ReadingFile {
  app: "hiread";
  kind: "reading-settings";
  version: 1 | 2;
  settings: Record<string, unknown>;
}

export interface Imported {
  /** The settings that survived, ready to be written one by one. */
  values: Array<{ key: ReadingSettingKey; value: number | boolean | string }>;
  /** Keys the file had that this app does not, or values it could not use. */
  skipped: string[];
}

/** Everything the reader has chosen, as a file. */
export function exportReading(read: (key: ReadingSettingKey) => unknown): string {
  const settings: Record<string, unknown> = {};
  for (const s of READING_SETTINGS) settings[s.key] = read(s.key as ReadingSettingKey);
  const file: ReadingFile = { app: "hiread", kind: "reading-settings", version: 2, settings };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Whether a value is one this setting could hold, and what it becomes.
 *
 *  Numbers are clamped rather than refused: a file written by a build with a
 *  wider range is still describing the size the reader wanted, and the nearest
 *  size this build can set is closer to it than the default is. */
function coerce(s: Setting, raw: unknown, v1: boolean): number | boolean | string | undefined {
  switch (s.kind) {
    case "number": {
      // A number, not something that converts to one: Number(null), Number("")
      // and Number([]) are all 0, which would clamp to the smallest size this
      // build can set and look like a decision the reader made.
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      const n = !v1
        ? raw
        : s.key === "readerTracking"
          ? migrateTracking(raw)
          : s.key === "readerLeading"
            ? migrateLeading(raw)
            : s.key === "readerParaGap"
              ? migrateParaGap(raw)
              : raw;
      const b = BOUNDS[s.key];
      return Math.min(b.max, Math.max(b.min, n));
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "enum":
      return typeof raw === "string" && (s.options as readonly string[]).includes(raw)
        ? raw
        : undefined;
    case "colour":
      return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : undefined;
    case "font":
      // A face is a name this build may not have heard of — a font installed
      // on the other machine, say. It is taken as given; resolving it is the
      // font layer's job, and it already falls back when a name is unknown.
      return typeof raw === "string" && raw.length > 0 && raw.length < 200 ? raw : undefined;
  }
}

/** Read a file back. Throws only when the text is not a settings file at all;
 *  anything else is a partial success with a list of what was dropped. */
export function importReading(text: string): Imported {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not a settings file");
  }
  const file = parsed as Partial<ReadingFile>;
  if (!file || typeof file !== "object" || file.kind !== "reading-settings") {
    throw new Error("not a settings file");
  }
  const settings = file.settings;
  if (!settings || typeof settings !== "object") throw new Error("not a settings file");

  const values: Imported["values"] = [];
  const skipped: string[] = [];
  const known = new Map(READING_SETTINGS.map((s) => [s.key as string, s]));

  for (const [key, raw] of Object.entries(settings as Record<string, unknown>)) {
    const s = known.get(key);
    if (!s) {
      skipped.push(key);
      continue;
    }
    const value = coerce(s, raw, file.version !== 2);
    if (value === undefined) {
      skipped.push(key);
      continue;
    }
    values.push({ key: s.key as ReadingSettingKey, value });
  }
  // A setting that another setting's write would overwrite goes last, so the
  // file's own value for it is the one that survives. Otherwise restoring any
  // file at all ends with the page colour set to a custom colour the reader
  // had kept but was not using — the schema order puts the colour after the
  // choice, and writing the colour selects it.
  values.sort((a, b) => Number(CLOBBERED.has(a.key)) - Number(CLOBBERED.has(b.key)));
  return { values, skipped };
}
