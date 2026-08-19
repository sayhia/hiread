// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import en from "../locales/en.json";
import { useUi } from "../stores/ui";
import ImageViewer from "./ImageViewer.vue";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

function open(index = 0) {
  return mount(ImageViewer, {
    props: {
      srcs: ["blob:one", "blob:two", "blob:three"],
      alts: ["First plate", "", ""],
      index,
    },
    global: { plugins: [pinia, i18n] },
  });
}

describe("the image viewer", () => {
  it("opens on the plate that was clicked and names it", () => {
    const wrapper = open(1);
    expect(wrapper.get(".iv-img").attributes("src")).toBe("blob:two");
    expect(wrapper.get(".iv-counter").text()).toBe("2 / 3");
    wrapper.unmount();
  });

  it("steps through the set with the arrow and wraps", async () => {
    const wrapper = open(2);
    await wrapper.get(".iv-next").trigger("click");
    expect(wrapper.get(".iv-img").attributes("src")).toBe("blob:one");
    await wrapper.get(".iv-prev").trigger("click");
    expect(wrapper.get(".iv-img").attributes("src")).toBe("blob:three");
    wrapper.unmount();
  });

  it("focuses Close when it opens so Tab stays in the viewer", async () => {
    const wrapper = mount(ImageViewer, {
      props: { srcs: ["blob:one"], index: 0 },
      global: { plugins: [pinia, i18n] },
      attachTo: document.body,
    });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.get(".iv-close").element);
    wrapper.unmount();
  });

  it("closes on Escape, not on a click of the plate", async () => {
    const wrapper = open();
    await wrapper.get(".iv-img").trigger("click");
    expect(wrapper.emitted("close")).toBeFalsy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("zooms with the wheel and resets on 0", async () => {
    const wrapper = open();
    const stage = wrapper.get(".iv-stage");
    await stage.trigger("wheel", { deltaY: -80 });
    expect(wrapper.get(".iv-img").classes()).toContain("is-zoomed");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".iv-img").classes()).not.toContain("is-zoomed");
    wrapper.unmount();
  });

  it("shows a caption when the book gave the plate a name", () => {
    const wrapper = open(0);
    expect(wrapper.get(".iv-caption").text()).toBe("First plate");
    wrapper.unmount();
  });

  it("in a vertical book the left arrow goes on to the next plate", async () => {
    useUi().setReading("readerOrientation", "vertical");
    const wrapper = open(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".iv-img").attributes("src")).toBe("blob:two");
    wrapper.unmount();
  });
});
