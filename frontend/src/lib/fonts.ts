// Resolves a font *choice* (what the settings pickers store) into the CSS the
// app actually applies, for both axes — the UI (`--ui`) and the reading column
// (`--reader-font`). Pure and DOM-free, so it is unit-tested in node; App.vue
// owns writing the results onto the document root.
//
// A choice is a small string:
//   "serif" | "sans" | "hyperlegible"  — bundled reader faces
//   "default"                          — UI: no override (use the stylesheet --ui)
//   "system:<Family>"                  — a font installed on the user's OS
//   "downloaded:<id>"                  — a font fetched into <dataDir>/fonts
//
// Every resolved stack ends in literal fallbacks so a face missing Latin or CJK
// glyphs still renders (the browser falls through silently otherwise).

import type { InstalledFont } from "../../bindings/hiread/internal/db/models";

/** The OS faces the font pickers offer alongside the bundled ones, by family
 *  name. Shared so the reader's font menu and the settings font picker agree
 *  about what counts as a choice. */
export const SYSTEM_FONTS = [
  "PingFang SC", "Songti SC", "Heiti SC", "STSong",
  "Microsoft YaHei", "Segoe UI", "Helvetica Neue", "system-ui",
];

export interface ResolvedFont {
  stack: string;
  adjust: string;
}

const SANS_TAIL =
  "'Inter Tight Variable', 'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif";
const CJK_TAIL = "'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

// Bundled reading faces keep their hand-tuned optical-size adjustment.
const BUNDLED_READER: Record<string, ResolvedFont> = {
  serif: { stack: "var(--serif)", adjust: "0px" },
  sans: { stack: "var(--ui)", adjust: "-1.5px" },
  hyperlegible: { stack: "'Atkinson Hyperlegible', var(--ui)", adjust: "-1.5px" },
};

/** Strip characters that would break out of the single-quoted family name. */
function safeFamily(name: string): string {
  return name.replace(/[\\'"]/g, "").trim();
}

function familyOf(id: string, installed: InstalledFont[]): string | null {
  const f = installed.find((x) => x.id === id);
  return f ? safeFamily(f.family) : null;
}

/** A `'Family', <fallbacks>` stack for a custom (system / downloaded) face. */
function customStack(family: string): string {
  return `'${family}', ${SANS_TAIL}, ${CJK_TAIL}`;
}

/** Resolve the reading-column font. Falls back to the bundled sans for an
 *  unknown choice (e.g. a downloaded font that was since deleted). */
export function resolveReaderFont(choice: string, installed: InstalledFont[]): ResolvedFont {
  if (BUNDLED_READER[choice]) return BUNDLED_READER[choice];
  if (choice.startsWith("system:")) {
    const name = safeFamily(choice.slice(7));
    if (name) return { stack: customStack(name), adjust: "0px" };
  } else if (choice.startsWith("downloaded:")) {
    const fam = familyOf(choice.slice(11), installed);
    if (fam) return { stack: customStack(fam), adjust: "0px" };
  }
  return BUNDLED_READER.sans;
}

/** Resolve the UI-font override, or `null` to leave the stylesheet `--ui` as-is.
 *  The override is set on `--ui` itself, so it must NOT reference `var(--ui)`
 *  (that would be circular) — hence the literal fallback tail. */
export function resolveUiFont(choice: string, installed: InstalledFont[]): string | null {
  if (!choice || choice === "default") return null;
  if (choice.startsWith("system:")) {
    const name = safeFamily(choice.slice(7));
    return name ? customStack(name) : null;
  }
  if (choice.startsWith("downloaded:")) {
    const fam = familyOf(choice.slice(11), installed);
    return fam ? customStack(fam) : null;
  }
  return null;
}

const FORMAT: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/** The `@font-face` block registering every downloaded font, pointing at the
 *  files the Go asset middleware serves under /userfonts/. */
export function fontFaceCss(installed: InstalledFont[]): string {
  return installed
    .map((f) => {
      const fmt = FORMAT[f.ext] ?? "truetype";
      return `@font-face{font-family:'${safeFamily(f.family)}';src:url('/userfonts/${encodeURIComponent(
        f.file,
      )}') format('${fmt}');font-display:swap;}`;
    })
    .join("\n");
}
