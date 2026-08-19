// The sidebar is where shelves and tags are managed, and management that only
// goes one way — create and delete, with no way to correct a name — makes a
// typo permanent. These tests drive the menus that fix that.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../locales/en.json";

const renameTag = vi.fn(async (_id: number, _name: string) => {});
const setTagColor = vi.fn(async (_id: number, _color: string) => {});
const renameCollection = vi.fn(async (_id: number, _name: string) => {});

// A tiny stand-in for the tables the sidebar sorts: the reorder calls rewrite
// them, so a refetch after a drag returns what the backend would return.
const SHELVES = [
  { id: 3, name: "Classics", position: 0, bookCount: 2 },
  { id: 4, name: "History", position: 1, bookCount: 1 },
  { id: 5, name: "To read", position: 2, bookCount: 0 },
];
const TAGS = [
  { id: 9, name: "strategy", color: "clay", position: 0, bookCount: 3 },
  { id: 10, name: "essays", color: "moss", position: 1, bookCount: 1 },
];
let shelves = [...SHELVES];
let tagRows = [...TAGS];
const applyOrder = <T extends { id: number }>(rows: T[], ids: number[]) =>
  ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);

const reorderCollections = vi.fn(async (ids: number[]) => {
  shelves = applyOrder(shelves, ids);
});
const reorderTags = vi.fn(async (ids: number[]) => {
  tagRows = applyOrder(tagRows, ids);
});

vi.mock("../api", () => ({
  libraryCounts: vi.fn(async () => ({ all: 2, reading: 1, finished: 0, favorite: 0, highlights: 4 })),
  listCollections: vi.fn(async () => shelves),
  listTags: vi.fn(async () => tagRows),
  renameTag,
  setTagColor,
  renameCollection,
  reorderCollections,
  reorderTags,
  createCollection: vi.fn(async () => 1),
  deleteCollection: vi.fn(async () => {}),
  deleteTag: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  toggleFullscreen: vi.fn(async () => false),
  setBookCollection: vi.fn(async () => {}),
  setBookTag: vi.fn(async () => {}),
  createTag: vi.fn(async () => 1),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

/** jsdom has no DataTransfer; the component only sets three fields on it. */
const dt = () => ({ setData: () => {}, effectAllowed: "", dropEffect: "", types: [] });

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  shelves = [...SHELVES];
  tagRows = [...TAGS];
  document.body.innerHTML = "";
});

async function mountSidebar() {
  const Sidebar = (await import("./Sidebar.vue")).default;
  const wrapper = mount(Sidebar, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

/** Right-click the row whose label matches, and return the menu it opened. */
async function openMenuOn(wrapper: Awaited<ReturnType<typeof mountSidebar>>, label: string) {
  const row = wrapper.findAll(".sb-item").find((r) => r.text().includes(label));
  expect(row, `no sidebar row for ${label}`).toBeTruthy();
  await row!.trigger("contextmenu");
  await flushPromises();
  return document.querySelector(".ctx-menu")!;
}

describe("Sidebar", () => {
  it("does not put count badges on the icon rail", async () => {
    const wrapper = await mountSidebar();
    expect(wrapper.findAll(".rail-badge")).toHaveLength(0);
    wrapper.unmount();
  });

  it("uses the chosen app-icon palette on the rail mark", async () => {
    const wrapper = await mountSidebar();
    const { useUi } = await import("../stores/ui");
    const mark = wrapper.get(".rail-brand-mark");
    expect(mark.attributes("src")).toBe("/icons/night.png");
    useUi().setAppIcon("dawn");
    await flushPromises();
    expect(mark.attributes("src")).toBe("/icons/dawn.png");
    wrapper.unmount();
  });

  it("renames a tag rather than making the user delete and rebuild it", async () => {
    const wrapper = await mountSidebar();
    const menu = await openMenuOn(wrapper, "strategy");

    const rename = Array.from(menu.querySelectorAll(".ctx-item")).find((b) =>
      b.textContent?.includes("Rename"),
    ) as HTMLButtonElement;
    rename.click();
    await flushPromises();

    // The dialog opens on the current name, so a typo is a correction, not a
    // retype.
    const input = document.querySelector(".modal-input") as HTMLInputElement;
    expect(input.value).toBe("strategy");
    input.value = "stratagem";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    (document.querySelector(".modal .s-btn.primary") as HTMLButtonElement).click();
    await flushPromises();

    expect(renameTag).toHaveBeenCalledWith(9, "stratagem");
    wrapper.unmount();
  });

  it("recolours a tag from the swatches in its menu", async () => {
    const wrapper = await mountSidebar();
    const menu = await openMenuOn(wrapper, "strategy");

    const swatches = menu.querySelectorAll(".ctx-swatch");
    expect(swatches.length).toBeGreaterThan(4);
    (swatches[4] as HTMLButtonElement).click();
    await flushPromises();

    expect(setTagColor).toHaveBeenCalledTimes(1);
    expect(setTagColor.mock.calls[0][0]).toBe(9);
    wrapper.unmount();
  });

  it("shows a tag in its own colour", async () => {
    const wrapper = await mountSidebar();
    const dot = wrapper.find(".tag-dot");
    expect(dot.exists()).toBe(true);
    expect(dot.attributes("style")).toContain("oklch");
    wrapper.unmount();
  });

  // Shelves and tags were stuck in creation order: the backend has always
  // sorted by a position column, but nothing could set it.
  it("reorders shelves by dragging one onto another", async () => {
    const wrapper = await mountSidebar();
    const rows = () => wrapper.findAll(".sb-item").filter((r) => r.attributes("draggable") === "true");
    const shelf = (name: string) => rows().find((r) => r.text().includes(name))!;

    await shelf("To read").trigger("dragstart", { dataTransfer: dt() });
    // Above "Classics": the pointer sits in the top half of its box. jsdom
    // gives every element a zero-height rect, so clientY 0 reads as the top.
    await shelf("Classics").trigger("dragover", { clientY: -1, dataTransfer: dt() });
    expect(shelf("Classics").classes()).toContain("drop-above");
    await shelf("Classics").trigger("drop");
    await flushPromises();

    expect(reorderCollections).toHaveBeenCalledWith([5, 3, 4]);
    // The list shows the new order without waiting for a refetch.
    expect(rows().map((r) => r.text().replace(/\d+$/, "").trim())).toEqual([
      "To read",
      "Classics",
      "History",
      "strategy",
      "essays",
    ]);
    wrapper.unmount();
  });

  it("drops a shelf below the row when the pointer is past its middle", async () => {
    const wrapper = await mountSidebar();
    const shelf = (name: string) =>
      wrapper.findAll(".sb-item").find((r) => r.text().includes(name))!;

    await shelf("Classics").trigger("dragstart", { dataTransfer: dt() });
    await shelf("History").trigger("dragover", { clientY: 1, dataTransfer: dt() });
    expect(shelf("History").classes()).toContain("drop-below");
    await shelf("History").trigger("drop");
    await flushPromises();

    expect(reorderCollections).toHaveBeenCalledWith([4, 3, 5]);
    wrapper.unmount();
  });

  it("keeps tags and shelves in their own lists", async () => {
    const wrapper = await mountSidebar();
    const row = (name: string) => wrapper.findAll(".sb-item").find((r) => r.text().includes(name))!;

    await row("strategy").trigger("dragstart", { dataTransfer: dt() });
    await row("Classics").trigger("dragover", { clientY: 0, dataTransfer: dt() });
    // No line is drawn on a shelf for a tag being dragged, and dropping there
    // does nothing at all.
    expect(row("Classics").classes().join(" ")).not.toContain("drop-");
    await row("Classics").trigger("drop");
    await flushPromises();

    expect(reorderCollections).not.toHaveBeenCalled();
    expect(reorderTags).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("tags a book dropped onto a tag row", async () => {
    const api = await import("../api");
    const wrapper = await mountSidebar();
    const tag = wrapper.findAll(".sb-item").find((r) => r.text().includes("strategy"))!;
    const transfer = {
      ...dt(),
      types: ["application/x-hiread-book"],
      getData: (k: string) => (k === "application/x-hiread-book" ? "7" : ""),
    };
    await tag.trigger("dragover", { dataTransfer: transfer });
    expect(tag.classes()).toContain("drop-book");
    await tag.trigger("drop", { dataTransfer: transfer });
    await flushPromises();
    expect(api.setBookTag).toHaveBeenCalledWith(7, 9, true);
    wrapper.unmount();
  });

  it("reorders tags too", async () => {
    const wrapper = await mountSidebar();
    const row = (name: string) => wrapper.findAll(".sb-item").find((r) => r.text().includes(name))!;

    await row("essays").trigger("dragstart", { dataTransfer: dt() });
    await row("strategy").trigger("dragover", { clientY: -1, dataTransfer: dt() });
    await row("strategy").trigger("drop");
    await flushPromises();

    expect(reorderTags).toHaveBeenCalledWith([10, 9]);
    wrapper.unmount();
  });
});
