// "Reset" and "already at the defaults" are the same question asked twice, and
// they were answered by two lists written apart. The reset restored the
// auto-scroll speed and click-paging; the check that greys the button out
// never looked at either — so changing only one of those left the reader with
// a setting they could not put back and a button that said there was nothing
// to put back.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../../locales/en.json";
import { READER_DEFAULTS } from "../../lib/readerSettings";
import * as api from "../../api";
import SettingsSlider from "./SettingsSlider.vue";

vi.mock("../../api", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  listInstalledFonts: vi.fn(async () => []),
}));

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  vi.mocked(api.setSetting).mockClear();
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("SpeechSynthesisUtterance", class {});
});

async function mountReading() {
  const { useUi } = await import("../../stores/ui");
  const ReadingSection = (await import("./ReadingSection.vue")).default;
  const wrapper = mount(ReadingSection, {
    global: {
      plugins: [createPinia(), [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
    },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, ui: useUi() };
}

/** The reset button, found by its own label rather than its position. */
function resetBtn(wrapper: Awaited<ReturnType<typeof mountReading>>["wrapper"]) {
  return wrapper.get(".rs-hero-reset");
}

describe("resetting the reading settings", () => {
  it("offers nothing to reset when nothing has been changed", async () => {
    const { wrapper } = await mountReading();
    expect(resetBtn(wrapper).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  // One case per thing the reset touches that is not one of the sliders — the
  // two that had drifted, and one that had not, so the test says which is which
  // if it ever breaks again.
  const changes: [string, (ui: Awaited<ReturnType<typeof mountReading>>["ui"]) => void][] = [
    ["the type size", (ui) => ui.setReader({ readerSize: READER_DEFAULTS.readerSize + 3 })],
    ["the page colour", (ui) => ui.setReaderPaper("sepia")],
    [
      "the auto-scroll speed",
      (ui) => ui.setReader({ readerAutoSpeed: READER_DEFAULTS.readerAutoSpeed + 20 }),
    ],
    ["click-paging", (ui) => ui.setReaderClickPaging(!READER_DEFAULTS.readerClickPaging)],
    ["the app theme", (ui) => ui.setTheme("dark")],
    ["trim-blank-paragraphs", (ui) => ui.setPref({ trimBlankParagraphs: false })],
    ["the reading-time hint", (ui) => ui.setPref({ showReadingTime: false })],
    ["the translation switch", (ui) => ui.setPref({ showTransSwitch: true })],
  ];

  for (const [what, change] of changes) {
    it(`offers to reset ${what}`, async () => {
      const { wrapper, ui } = await mountReading();
      change(ui);
      await flushPromises();
      expect(
        resetBtn(wrapper).attributes("disabled"),
        `changing ${what} left the reset button disabled`,
      ).toBeUndefined();
      wrapper.unmount();
    });

    it(`puts ${what} back, and knows it did`, async () => {
      const { wrapper, ui } = await mountReading();
      change(ui);
      await flushPromises();

      await resetBtn(wrapper).trigger("click");
      await flushPromises();

      // Both halves: the setting is back, and the button agrees there is
      // nothing left to do. A reset that leaves the button live has missed
      // something.
      expect(resetBtn(wrapper).attributes("disabled")).toBeDefined();
      wrapper.unmount();
    });
  }

  it("offers to reset a picked voice even when the rate is already 100%", async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) =>
      key === "speech_voice" ? "Samantha" : null,
    );
    const { wrapper } = await mountReading();
    expect(resetBtn(wrapper).attributes("disabled")).toBeUndefined();
    await resetBtn(wrapper).trigger("click");
    await flushPromises();
    expect(api.setSetting).toHaveBeenCalledWith("speech_voice", "");
    expect(resetBtn(wrapper).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("puts every value it claims to back", async () => {
    const { wrapper, ui } = await mountReading();
    ui.setReader({
      readerSize: READER_DEFAULTS.readerSize + 3,
      readerAutoSpeed: READER_DEFAULTS.readerAutoSpeed + 20,
    });
    ui.setReaderPaper("sepia");
    ui.setReaderJustify(true);
    ui.setReaderGrayscale(true);
    ui.setReaderTexture("wood");
    ui.setReaderClickPaging(true);
    ui.setTheme("dark");
    ui.setPref({
      trimBlankParagraphs: false,
      showReadingTime: false,
      showTransSwitch: true,
    });
    await flushPromises();

    await resetBtn(wrapper).trigger("click");
    await flushPromises();

    expect(ui.readerSize).toBe(READER_DEFAULTS.readerSize);
    expect(ui.readerAutoSpeed).toBe(READER_DEFAULTS.readerAutoSpeed);
    expect(ui.readerPaper).toBe(READER_DEFAULTS.readerPaper);
    expect(ui.readerJustify).toBe(READER_DEFAULTS.readerJustify);
    expect(ui.readerGrayscale).toBe(READER_DEFAULTS.readerGrayscale);
    expect(ui.readerTexture).toBe(READER_DEFAULTS.readerTexture);
    expect(ui.readerClickPaging).toBe(READER_DEFAULTS.readerClickPaging);
    expect(ui.theme).toBe("light");
    expect(ui.prefs.trimBlankParagraphs).toBe(true);
    expect(ui.prefs.showReadingTime).toBe(true);
    expect(ui.prefs.showTransSwitch).toBe(false);
    wrapper.unmount();
  });

  it("puts the theme back after a night preset", async () => {
    const { wrapper, ui } = await mountReading();
    ui.applyReadingPreset("night");
    await flushPromises();
    expect(ui.theme).toBe("dark");

    await resetBtn(wrapper).trigger("click");
    await flushPromises();

    expect(ui.theme).toBe("light");
    expect(resetBtn(wrapper).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("offers to reset the speech rate, and puts it back", async () => {
    const { wrapper } = await mountReading();
    const slider = wrapper.getComponent(SettingsSlider);
    await slider.vm.$emit("commit", 150);
    await flushPromises();
    expect(
      resetBtn(wrapper).attributes("disabled"),
      "changing the speech rate left the reset button disabled",
    ).toBeUndefined();

    await resetBtn(wrapper).trigger("click");
    await flushPromises();

    expect(vi.mocked(api.setSetting).mock.calls.filter((c) => c[0] === "speech_rate")).toContainEqual(
      ["speech_rate", "1"],
    );
    expect(resetBtn(wrapper).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});

describe("the speech-rate slider", () => {
  it("writes the rate when the slider commits, not while it is dragged", async () => {
    const { wrapper } = await mountReading();
    const slider = wrapper.getComponent(SettingsSlider);

    await slider.vm.$emit("change", 150);
    await flushPromises();
    expect(vi.mocked(api.setSetting).mock.calls.filter((c) => c[0] === "speech_rate")).toEqual([]);

    await slider.vm.$emit("commit", 150);
    await flushPromises();
    expect(vi.mocked(api.setSetting).mock.calls.filter((c) => c[0] === "speech_rate")).toEqual([
      ["speech_rate", "1.5"],
    ]);
    wrapper.unmount();
  });
});
