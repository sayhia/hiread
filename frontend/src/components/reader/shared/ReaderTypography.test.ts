// A PDF's pages are pictures of type, not type. Nothing about the face, its
// size, or how it is set reaches them — so offering those controls over a
// scanned page is offering controls that quietly do nothing.
//
// The panel is drawn from the schema now, so this also checks the thing that
// makes that safe: what a surface offers comes from the settings table, and a
// row that appears has a name, a control, and a control that works.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../../../locales/en.json";

vi.mock("../../../api", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  listInstalledFonts: vi.fn(async () => []),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});

async function mountPanel(props: Record<string, unknown>) {
  const ReaderTypography = (await import("./ReaderTypography.vue")).default;
  const wrapper = mount(ReaderTypography, {
    props: { bookId: 1, onClose: () => {}, onOpenSettings: () => {}, ...props },
    global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient: new QueryClient() }], i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

type Panel = Awaited<ReturnType<typeof mountPanel>>;

/** The names of the rows on the tab that is open. */
const rows = (w: Panel) => w.findAll(".rs-row .rs-label").map((l) => l.text());

async function openTab(w: Panel, name: string) {
  const tab = w.findAll('[role="tab"]').find((b) => b.text() === name);
  expect(tab, `no ${name} tab`).toBeTruthy();
  await tab!.trigger("click");
  await flushPromises();
}

describe("the reading panel over a PDF", () => {
  it("offers only the settings that reach the page", async () => {
    const wrapper = await mountPanel({ isPdf: true });

    const shown = rows(wrapper);
    expect(shown).toContain("Page colour");
    expect(shown).toContain("Warm light");
    for (const dead of ["Face", "Size", "Line height", "Letter spacing", "Measure", "Margins", "Justify"]) {
      expect(shown, `${dead} does nothing to a PDF`).not.toContain(dead);
    }
    // Paper grain paints the article sheet, which a PDF does not have.
    expect(shown).not.toContain("Paper grain");
    wrapper.unmount();
  });
});

describe("the reading panel over a book", () => {
  it("offers the type", async () => {
    const wrapper = await mountPanel({ isPdf: false });
    expect(wrapper.find(".rp-tabs").exists()).toBe(true);
    expect(rows(wrapper)).toContain("Face");
    wrapper.unmount();
  });

  it("hides drop cap, columns and justify on a 古籍 page", async () => {
    const { useUi } = await import("../../../stores/ui");
    const wrapper = await mountPanel({ isPdf: false });
    await openTab(wrapper, "Layout");
    expect(rows(wrapper)).toContain("Drop cap");
    expect(rows(wrapper)).toContain("Justify");
    useUi().setReading("readerOrientation", "vertical");
    await flushPromises();
    await openTab(wrapper, "Layout");
    expect(rows(wrapper)).not.toContain("Drop cap");
    expect(rows(wrapper)).not.toContain("Justify");
    await openTab(wrapper, "Turning");
    expect(rows(wrapper)).not.toContain("Columns");
    wrapper.unmount();
  });

  it("hides the column rule until the page is vertical", async () => {
    const { useUi } = await import("../../../stores/ui");
    const wrapper = await mountPanel({ isPdf: false });
    await openTab(wrapper, "Layout");
    expect(rows(wrapper)).not.toContain("Column separator");

    useUi().setReading("readerOrientation", "vertical");
    await flushPromises();
    expect(rows(wrapper)).toContain("Column separator");
    wrapper.unmount();
  });

  it("keeps the page settings within reach of the page", async () => {
    const wrapper = await mountPanel({ isPdf: false });
    await openTab(wrapper, "Page");
    const shown = rows(wrapper);
    expect(shown).toContain("Grayscale");
    expect(shown).toContain("Paper grain");
    // The app's theme is not a reading setting, but the moment a reader wants
    // it is a moment spent looking at a page.
    expect(shown).toContain("Appearance");
    wrapper.unmount();
  });

  it("draws every row with a name and a working control", async () => {
    const wrapper = await mountPanel({ isPdf: false });
    for (const tab of ["Type", "Layout", "Page", "Turning"]) {
      await openTab(wrapper, tab);
      const all = wrapper.findAll(".rs-row");
      expect(all.length, `${tab} has no rows`).toBeGreaterThan(0);
      for (const row of all) {
        expect(row.find(".rs-label").exists(), `a row on ${tab} has no name`).toBe(true);
        const control = row.find(".rs-control");
        expect(
          control.element.children.length,
          `a row on ${tab} has a name and nothing to set`,
        ).toBeGreaterThan(0);
      }
    }
    wrapper.unmount();
  });

  it("sets what it shows", async () => {
    const { useUi } = await import("../../../stores/ui");
    const wrapper = await mountPanel({ isPdf: false });
    const ui = useUi();

    // A slider writes the value behind it.
    const leading = wrapper
      .findAll(".rs-row")
      .find((r) => r.find(".rs-label").text() === "Line height")!
      .find("input[type='range']");
    await leading.setValue("36");
    expect(ui.readerLeading).toBe(36);

    // And a colour swatch chooses the page it shows — which it could not do
    // when the swatches were drawn without a click handler.
    await openTab(wrapper, "Page");
    const swatches = wrapper
      .findAll(".rs-row")
      .find((r) => r.find(".rs-label").text() === "Page colour")!
      .findAll(".rs-swatch");
    await swatches[1].trigger("click");
    expect(ui.readerPaper).toBe("sepia");
    wrapper.unmount();
  });

  it("steps the type size a pixel at a time", async () => {
    const { useUi } = await import("../../../stores/ui");
    const wrapper = await mountPanel({ isPdf: false });
    const ui = useUi();
    const start = ui.readerSize;
    const row = wrapper.findAll(".rs-row").find((r) => r.find(".rs-label").text() === "Size")!;
    await row.get('button[aria-label="Increase Size"]').trigger("click");
    expect(ui.readerSize).toBe(start + 1);
    await row.get('button[aria-label="Decrease Size"]').trigger("click");
    expect(ui.readerSize).toBe(start);

    const lead = wrapper.findAll(".rs-row").find((r) => r.find(".rs-label").text() === "Line height")!;
    const leadStart = ui.readerLeading;
    await lead.get('button[aria-label="Increase Line height"]').trigger("click");
    expect(ui.readerLeading).toBe(leadStart + 1);
    wrapper.unmount();
  });

  it("resets what a book can hold, and leaves a global habit alone", async () => {
    const { useUi } = await import("../../../stores/ui");
    const wrapper = await mountPanel({ isPdf: false });
    const ui = useUi();

    ui.setReader({ readerSize: 21, readerAutoSpeed: 200 });
    await flushPromises();
    const reset = wrapper.get(".rp-reset");
    expect(reset.attributes("disabled")).toBeUndefined();

    await reset.trigger("click");
    await flushPromises();
    expect(ui.readerSize).toBe(17);
    expect(ui.readerAutoSpeed).toBe(200);
    expect(wrapper.get(".rp-reset").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
