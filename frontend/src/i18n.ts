// App internationalisation (vue-i18n). Three bundled languages (zh / en / ja);
// the active one is detected from the system locale on first launch and can be
// overridden from Settings — the choice persists in localStorage and is mirrored
// to the backend so Go-side text (notifications, tray) localises too.

import type { WritableComputedRef } from "vue";
import { createI18n } from "vue-i18n";
import * as api from "./api";
import zh from "./locales/zh.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

export type Language = "zh" | "en" | "ja";

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: "zh", label: "简体中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
];

const STORAGE_KEY = "language";
const SUPPORTED: Language[] = LANGUAGES.map((l) => l.code);

/** Resolve the startup language: saved choice → system locale → English. */
export function detectLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED.includes(saved as Language)) return saved as Language;
  const sys = (navigator.language || "en").toLowerCase();
  if (sys.startsWith("zh")) return "zh";
  if (sys.startsWith("ja")) return "ja";
  return "en";
}

function persistToBackend(lang: Language): void {
  api
    .setSetting("language", lang)
    .then(() => api.refreshTray())
    .catch(() => {});
}

const startupLang = detectLanguage();

const i18n = createI18n({
  legacy: false,
  locale: startupLang,
  fallbackLocale: "en",
  messages: { zh, en, ja },
  missingWarn: false,
  fallbackWarn: false,
});

// Under legacy:false the global locale is a writable computed ref, but the
// createI18n return type is the Composer|VueI18n union, so TS widens it to
// `string`. Cast once here so callers get a typed ref.
const localeRef = i18n.global.locale as unknown as WritableComputedRef<Language>;

/** The active UI language code. */
export const currentLocale = (): Language => localeRef.value;

/** Switch the active language and remember it across launches. */
export function setLanguage(lang: Language): void {
  localStorage.setItem(STORAGE_KEY, lang);
  localeRef.value = lang;
  document.documentElement.lang = lang;
  persistToBackend(lang);
}

document.documentElement.lang = startupLang;
persistToBackend(startupLang);

// Hot-apply locale edits in dev. vue-i18n compiles each message once and caches
// it, so without this a JSON change only takes effect on a full page reload
// (Vite's HMR swaps the module but never re-registers the messages). Re-set the
// updated locale(s) so `t()` re-compiles them in place.
if (import.meta.hot) {
  import.meta.hot.accept(
    ["./locales/zh.json", "./locales/en.json", "./locales/ja.json"],
    ([nzh, nen, nja]) => {
      if (nzh) i18n.global.setLocaleMessage("zh", nzh.default);
      if (nen) i18n.global.setLocaleMessage("en", nen.default);
      if (nja) i18n.global.setLocaleMessage("ja", nja.default);
    },
  );
}

export default i18n;
