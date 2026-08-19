// A schema-driven presenter asks for `reading.<key>` and draws whatever comes
// back. If a key is missing the control still renders — with the key path
// where its name should be, or the English one under fallbackLocale, which is
// worse because it looks deliberate. The schema makes this checkable: there is
// a known list of settings, so there is a known list of labels.

import { describe, it, expect } from "vitest";
import { READING_SETTINGS, groupsFor, STEPS } from "./schema";
import en from "../../locales/en.json";
import zh from "../../locales/zh.json";
import ja from "../../locales/ja.json";

const LOCALES = { en, zh, ja } as Record<string, { reading: Record<string, unknown> }>;

describe("every reading setting can say its own name", () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    const reading = messages.reading as Record<string, string> & {
      group: Record<string, string>;
      step: Record<string, string>;
    };

    it(`${lang} names every setting`, () => {
      const missing = READING_SETTINGS.filter((s) => !reading[s.key]).map((s) => s.key);
      expect(missing).toEqual([]);
    });

    it(`${lang} names every group`, () => {
      const missing = groupsFor("text").filter((g) => !reading.group[g]);
      expect(missing).toEqual([]);
    });

    it(`${lang} names every named step`, () => {
      const names = new Set<string>();
      for (const steps of Object.values(STEPS)) for (const s of steps ?? []) names.add(s.key);
      const missing = [...names].filter((n) => !reading.step[n]);
      expect(missing).toEqual([]);
    });

    // A description is optional, but the *set* of them must match across
    // languages: one locale explaining a control and another leaving it bare
    // is how a translation quietly becomes a different product. This caught ja
    // missing the one for the measure.
    it(`${lang} explains the same settings as English`, () => {
      const described = (m: Record<string, unknown>) =>
        READING_SETTINGS.filter((s) => m[`${s.key}Desc`]).map((s) => s.key);
      expect(described(reading)).toEqual(described(en.reading as Record<string, unknown>));
    });
  }
});
