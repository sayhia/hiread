// A shortcuts list is a promise. Every key the reader has must be in it, and
// nothing in it may be a key the reader does not have — this one had drifted
// into claiming neither, having never learned the keys added around it.
//
// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import en from "../../locales/en.json";
import { useUi } from "../../stores/ui";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

/** Single-character keys the text reader handles, read out of its own switch
 *  rather than listed here — a list beside a list drifts the same way. */
function keysTheReaderHandles(): string[] {
  // Input lives in the composable now; the shell only wires it. Scrape the
  // switch from there so the list stays honest when keys move.
  const src = readFileSync("src/composables/reader/useTextReaderInput.ts", "utf8");
  const start = src.indexOf("function onKey");
  const end = src.indexOf("onMounted(() => window.addEventListener");
  const body = src.slice(start, end > start ? end : undefined);
  return [...body.matchAll(/case "(.)":/g)].map((m) => m[1]);
}

describe("the shortcuts list", () => {
  it("names every key the reader listens for", async () => {
    const ShortcutsSection = (await import("./ShortcutsSection.vue")).default;
    setActivePinia(createPinia());
    const wrapper = mount(ShortcutsSection, { global: { plugins: [createPinia(), i18n] } });
    const listed = wrapper.findAll(".s-key").map((k) => k.text().toLowerCase());

    for (const key of keysTheReaderHandles()) {
      const shown = key === " " ? "space" : key.toLowerCase();
      expect(listed, `the reader handles "${key}" and the list does not mention it`).toContain(shown);
    }
  });

  it("describes J and K as a page or a column when they page", async () => {
    const ShortcutsSection = (await import("./ShortcutsSection.vue")).default;
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(ShortcutsSection, { global: { plugins: [pinia, i18n] } });
    const ui = useUi();

    expect(descFor(wrapper, "J")).toBe(en.settings.shortcuts.nextChapter);
    expect(descFor(wrapper, "K")).toBe(en.settings.shortcuts.prevChapter);

    ui.setReading("readerPageMode", "paged");
    await nextTick();
    expect(descFor(wrapper, "J")).toBe(en.settings.shortcuts.nextPage);
    expect(descFor(wrapper, "K")).toBe(en.settings.shortcuts.prevPage);
    // Only orientation remaps the arrows.
    expect(descFor(wrapper, "→")).toBe(en.settings.shortcuts.nextChapter);
    expect(descFor(wrapper, "←")).toBe(en.settings.shortcuts.prevChapter);

    ui.setReading("readerOrientation", "vertical");
    await nextTick();
    expect(descFor(wrapper, "J")).toBe(en.settings.shortcuts.nextColumn);
    expect(descFor(wrapper, "K")).toBe(en.settings.shortcuts.prevColumn);
    expect(descFor(wrapper, "→")).toBe(en.settings.shortcuts.prevColumn);
    expect(descFor(wrapper, "←")).toBe(en.settings.shortcuts.nextColumn);

    wrapper.unmount();
  });
});

function descFor(wrapper: ReturnType<typeof mount>, key: string) {
  const row = wrapper.findAll(".s-shortcut").find((r) =>
    r.findAll(".s-key").some((k) => k.text() === key),
  );
  return row?.get(".desc").text();
}
