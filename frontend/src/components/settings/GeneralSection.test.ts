// The app-icon picker lives under Settings → General. It has to write the
// same key the Dock reads on launch, and the sidebar / About mark follow
// the store immediately.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import en from "../../locales/en.json";
import * as api from "../../api";

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
});

async function mountGeneral() {
  const { useUi } = await import("../../stores/ui");
  const GeneralSection = (await import("./GeneralSection.vue")).default;
  const wrapper = mount(GeneralSection, {
    global: { plugins: [createPinia(), i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, ui: useUi() };
}

describe("app icon picker", () => {
  it("defaults to night and shows both palettes", async () => {
    const { wrapper, ui } = await mountGeneral();
    expect(ui.appIcon).toBe("night");
    const picks = wrapper.findAll(".s-icon-pick");
    expect(picks).toHaveLength(4);
    expect(picks[0].attributes("aria-checked")).toBe("true");
    expect(picks[1].attributes("aria-checked")).toBe("false");
    expect(picks[0].get("img").attributes("src")).toBe("/icons/night.png");
    expect(picks[1].get("img").attributes("src")).toBe("/icons/dawn.png");
    expect(picks[2].get("img").attributes("src")).toBe("/icons/gold.png");
    expect(picks[3].get("img").attributes("src")).toBe("/icons/platinum.png");
    wrapper.unmount();
  });

  it("switching to dawn persists and mirrors to the backend", async () => {
    const { wrapper, ui } = await mountGeneral();
    await wrapper.findAll(".s-icon-pick")[1].trigger("click");
    await flushPromises();
    expect(ui.appIcon).toBe("dawn");
    expect(ui.iconSrc).toBe("/icons/dawn.png");
    expect(localStorage.getItem("appIcon")).toBe("dawn");
    expect(api.setSetting).toHaveBeenCalledWith("app_icon", "dawn");
    wrapper.unmount();
  });

  it("survives a restart", async () => {
    const { wrapper, ui } = await mountGeneral();
    ui.setAppIcon("dawn");
    wrapper.unmount();

    setActivePinia(createPinia());
    const { useUi } = await import("../../stores/ui");
    expect(useUi().appIcon).toBe("dawn");
  });
});
