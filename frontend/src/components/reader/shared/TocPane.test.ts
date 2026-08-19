// The panel's arrow-key navigation moves real focus between rows, which needs
// a DOM with layout semantics (offsetParent, document.activeElement).
// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import TocPane from "./TocPane.vue";
import en from "../../../locales/en.json";
import * as api from "../../../api";
import type { Chapter } from "../../../types";

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listBookmarks: vi.fn(() => Promise.resolve([])),
    listBookHighlights: vi.fn(() => Promise.resolve([])),
    searchLibrary: vi.fn(() => Promise.resolve([])),
  };
});

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeEach(() => {
  localStorage.clear();
});

// jsdom has no layout, so offsetParent is always null — which would filter
// every row out of the nav's visibility check. Give rendered elements a
// non-null offsetParent so the filter sees what a real browser sees. It also
// has no scrollIntoView, which the nav calls after moving focus.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  get() {
    return this.parentElement ? {} : null;
  },
  configurable: true,
});
Element.prototype.scrollIntoView = () => {};

const chapters: Chapter[] = [
  { index: 0, title: "One", level: 1, href: null, charCount: 900 },
  { index: 1, title: "Two", level: 2, href: null, charCount: 1200 },
  { index: 2, title: "Three", level: 3, href: null, charCount: 600 },
];

function make() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(TocPane, {
    props: {
      chapters,
      current: 1,
      bookId: 7,
      sections: [],
      activeSection: -1,
    },
    // focus() only moves document.activeElement when the element is in the
    // document; attach so the nav's focus assertions can observe it.
    attachTo: document.body,
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
    },
  });
}

/** The panel's arrow-key navigation: Down/Up move focus among the visible
 *  rows (tab bar + list), Home/End jump to the ends, and the search input's
 *  arrows are left alone. */
describe("TocPane arrow-key navigation", () => {
  it("moves focus down from one chapter to the next", async () => {
    const w = make();
    const items = w.findAll(".toc-item");
    await items[0].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1].element);
  });

  it("wraps from the last chapter back to the first", async () => {
    const w = make();
    const items = w.findAll(".toc-item");
    await items[2].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0].element);
  });

  it("treats Left as down the list only in 古籍 order", async () => {
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerOrientation", "vertical");
    const w = make();
    const items = w.findAll(".toc-item");
    await items[0].trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items[1].element);
    await items[1].trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[0].element);
    w.unmount();
  });

  it("leaves Left and Right alone in a horizontal list", async () => {
    const { useUi } = await import("../../../stores/ui");
    const pinia = createPinia();
    setActivePinia(pinia);
    useUi().setReading("readerOrientation", "horizontal");
    const w = make();
    const items = w.findAll(".toc-item");
    await items[0].trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).not.toBe(items[1].element);
    w.unmount();
  });

  it("moves focus up and wraps to the last row", async () => {
    const w = make();
    const items = w.findAll(".toc-item");
    await items[0].trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1].element);
  });

  it("jumps to the first and last rows with Home and End", async () => {
    const w = make();
    const items = w.findAll(".toc-item");
    await items[1].trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(items[0].element);
    await items[0].trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1].element);
  });

  it("falls back to the first item when a non-item has focus", async () => {
    const w = make();
    const close = w.find(".toc-head .tb-btn");
    await close.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(w.findAll(".toc-item")[0].element);
  });

  it("does not steal arrows from the search input", async () => {
    const w = make();
    const input = w.find(".toc-search input");
    (input.element as HTMLInputElement).focus();
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(input.element);
  });

  it("moves Down from a search with hits into the first hit", async () => {
    vi.mocked(api.searchLibrary).mockResolvedValueOnce([
      {
        bookId: 7,
        bookTitle: "X",
        chapterIndex: 2,
        chapterTitle: "Three",
        snippet: "hello <mark>world</mark>",
      },
    ]);
    const w = make();
    const input = w.find(".toc-search input");
    await input.setValue("world");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 230));
    await flushPromises();
    expect(w.findAll(".toc-hit")).toHaveLength(1);
    (input.element as HTMLInputElement).focus();
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(w.find(".toc-hit").element);
    w.unmount();
  });

  it("hands a search hit to the reader so it can land on the passage", async () => {
    vi.mocked(api.searchLibrary).mockResolvedValueOnce([
      {
        bookId: 7,
        bookTitle: "X",
        chapterIndex: 2,
        chapterTitle: "Three",
        snippet: "hello <mark>world</mark>",
      },
    ]);
    const w = make();
    await w.find(".toc-search input").setValue("world");
    await new Promise((r) => setTimeout(r, 250));
    await flushPromises();
    await w.find(".toc-hit").trigger("click");
    expect(w.emitted("select-hit")?.[0]?.[0]).toMatchObject({
      chapterIndex: 2,
      snippet: "hello <mark>world</mark>",
    });
    w.unmount();
  });
});
