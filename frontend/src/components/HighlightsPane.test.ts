// Export used to go straight back to the database for "everything" or "this
// date range", which is not what the browser is showing: a search term, a
// colour filter and a tick on three cards all live in the frontend. The file
// the user got was quietly a different set from the list they were looking at.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../locales/en.json";
import type { HighlightWithContext } from "../types";

const exportSelectionMarkdown = vi.fn(async (_ids: number[]) => "/tmp/hiread.md");

/** Three highlights in two colours, newest first — the order the pane shows. */
const ROWS: HighlightWithContext[] = [3, 2, 1].map((n) => ({
  id: n,
  bookId: n === 1 ? 7 : 5,
  chapterIndex: 0,
  quote: `quote ${n}`,
  prefix: "",
  suffix: "",
  textOffset: 0,
  color: n === 2 ? "blue" : "yellow",
  note: "",
  createdAt: `2026-08-0${n}T10:00:00Z`,
  bookTitle: n === 1 ? "Deep Work" : "山月记",
  bookAuthor: null,
  chapterTitle: "第一章",
}));

vi.mock("../api", () => ({
  listAllHighlights: vi.fn(async () => ROWS),
  searchHighlights: vi.fn(async () => ROWS),
  exportSelectionMarkdown,
  deleteHighlight: vi.fn(async () => {}),
  deleteHighlights: vi.fn(async () => {}),
  updateHighlightNote: vi.fn(async () => {}),
  setHighlightColor: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));
vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
  Browser: { OpenURL: vi.fn() },
}));

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function mountPane() {
  const HighlightsPane = (await import("./HighlightsPane.vue")).default;
  const wrapper = mount(HighlightsPane, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

type Pane = Awaited<ReturnType<typeof mountPane>>;

const exportButton = (w: Pane) =>
  w.findAll("button.list-meta-btn").find((b) => b.text().includes("Export"))!;

describe("HighlightsPane export", () => {
  it("exports the whole list when nothing is filtered or ticked", async () => {
    const wrapper = await mountPane();
    expect(wrapper.findAll(".hl-card")).toHaveLength(3);

    await exportButton(wrapper).trigger("click");
    await flushPromises();

    expect(exportSelectionMarkdown).toHaveBeenCalledWith([3, 2, 1]);
  });

  it("exports only what a colour filter leaves on screen", async () => {
    const wrapper = await mountPane();
    (wrapper.vm as unknown as { colorFilter: string | null }).colorFilter = "yellow";
    await flushPromises();
    expect(wrapper.findAll(".hl-card")).toHaveLength(2);

    await exportButton(wrapper).trigger("click");
    await flushPromises();

    // Highlight 2 is blue: on screen it is filtered out, so it is not in the file.
    expect(exportSelectionMarkdown).toHaveBeenCalledWith([3, 1]);
  });

  it("exports just the ticked cards once a selection is going", async () => {
    const wrapper = await mountPane();
    const checks = wrapper.findAll(".hlc-check");
    expect(checks.length).toBe(3);
    await checks[1].trigger("click"); // id 2
    await flushPromises();

    await exportButton(wrapper).trigger("click");
    await flushPromises();

    expect(exportSelectionMarkdown).toHaveBeenCalledWith([2]);
  });

  it("has nothing to export when the filters leave the list empty", async () => {
    const wrapper = await mountPane();
    (wrapper.vm as unknown as { colorFilter: string | null }).colorFilter = "green";
    await flushPromises();

    expect(wrapper.findAll(".hl-card")).toHaveLength(0);
    expect(exportButton(wrapper).attributes("disabled")).toBeDefined();

    await exportButton(wrapper).trigger("click");
    await flushPromises();
    expect(exportSelectionMarkdown).not.toHaveBeenCalled();
  });
});

describe("HighlightsPane keyboard", () => {
  it("deletes the keyboard-selected card", async () => {
    const api = await import("../api");
    const wrapper = await mountPane();
    await wrapper.trigger("keydown", { key: "j" });
    await wrapper.trigger("keydown", { key: "Delete" });
    await flushPromises();

    expect(wrapper.findAll(".hl-card")).toHaveLength(2);
    const { useToasts } = await import("../stores/toasts");
    expect(useToasts().current?.text).toBe(en.highlights.deleted);
    // The real delete waits for the undo window; apply only hides the row.
    expect(api.deleteHighlight).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
