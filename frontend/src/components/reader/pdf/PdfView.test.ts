// A PDF is read by page, everything else by chapter. They were one component
// with an `isPdf` beside twenty-three decisions; these are the ones that
// mattered, checked from the outside now that the screens are separate.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../../../locales/en.json";
import type { BookDetail } from "../../../types";

// pdf.js reaches for browser drawing APIs the moment it is imported, and jsdom
// has none of them. The stubs are enough to get the module loaded; nothing
// here renders a page.
class Stub {}
Object.assign(globalThis, {
  DOMMatrix: globalThis.DOMMatrix ?? Stub,
  Path2D: globalThis.Path2D ?? Stub,
  ImageData: globalThis.ImageData ?? Stub,
});

vi.mock("../../../api", () => ({
  sourceBytes: vi.fn(async () => new Uint8Array()),
  hasIndexedText: vi.fn(async () => true),
  indexPdfText: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  setBookFlag: vi.fn(async () => {}),
  saveProgress: vi.fn(async () => {}),
  listBookmarks: vi.fn(async () => []),
  listBookHighlights: vi.fn(async () => []),
  searchLibrary: vi.fn(async () => []),
  updateBookMeta: vi.fn(async () => {}),
  listInstalledFonts: vi.fn(async () => []),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} }, Browser: { OpenURL: async () => {} } }));

const pdfBook = {
  id: 9,
  title: "我不是教你诈",
  author: "刘墉",
  format: "pdf",
  pageCount: 411,
  chapterCount: 0,
  charCount: 0,
  isFinished: false,
  isFavorite: false,
  hasCover: true,
  chapters: [],
  tags: [],
  progress: { chapterIndex: 0, chapterRatio: 0, page: 137, percent: 0.3, updatedAt: "" },
} as unknown as BookDetail;

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});

async function mountPdf(pinia = createPinia()) {
  setActivePinia(pinia);
  const PdfView = (await import("./PdfView.vue")).default;
  const wrapper = mount(PdfView, {
    props: { book: pdfBook },
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
      stubs: { HighlightLayer: true },
    },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

function stubYScroll(el: HTMLElement, view: number, total: number, at = 0) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: view });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: total });
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: at });
  el.scrollTo = ((arg: unknown) => {
    if (arg && typeof arg === "object" && arg !== null && "top" in arg) {
      el.scrollTop = Number((arg as { top: number }).top);
    }
  }) as typeof el.scrollTo;
}

function edgeRect(): DOMRect {
  return {
    left: 0,
    width: 800,
    top: 0,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("the PDF screen", () => {
  it("carries only the chrome a document is read with", async () => {
    const wrapper = await mountPdf();
    const labels = wrapper.findAll("button").map((b) => b.attributes("aria-label") ?? "");

    // What belongs to the book is here, and contents is in the bar with
    // the rest of the chrome — not a floating corner button.
    expect(wrapper.find(".reader-toc-fab").exists()).toBe(false);
    expect(wrapper.find(".tb-cluster-start").exists()).toBe(true);
    expect(labels).toContain("Contents");
    expect(labels).toContain("Typography");
    expect(labels).toContain("More");
    // Book flags and bookmark sit under More, like the text reader — not
    // spread across the bar.
    expect(labels).not.toContain("Add to favorites");
    expect(labels).not.toContain("Focus mode");
    await wrapper.get('button[aria-label="More"]').trigger("click");
    await flushPromises();
    const open = wrapper.findAll("button").map((b) => b.attributes("aria-label") ?? b.text());
    expect(open.some((s) => s.includes("favorites") || s.includes("Favorite"))).toBe(true);
    expect(open.some((s) => s.includes("finished") || s.includes("Finished"))).toBe(true);
    expect(open.some((s) => s.includes("Focus"))).toBe(true);
    expect(open.some((s) => s.includes("Bookmark"))).toBe(true);
    // ...and what belongs to chapters of text is not.
    for (const gone of ["Translate chapter (T)", "Summarize chapter (I)", "Auto-scroll (S)"]) {
      expect(open).not.toContain(gone);
    }
    wrapper.unmount();
  });

  it("shows the document's own outline as its contents, and moves by page", async () => {
    const wrapper = await mountPdf();
    // The outline arrives from the document, not from chapters in the library.
    await wrapper.findComponent({ name: "PdfReader" }).vm.$emit("outline", [
      { title: "新版序", level: 0, page: 6 },
      { title: "第一章", level: 0, page: 12 },
    ]);
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();

    // An outline entry says which page it goes to, not how long it takes to
    // read — a PDF has no text behind it to estimate from.
    const rows = wrapper.findAll(".toc-item");
    expect(rows.map((r) => r.text())).toEqual(["新版序Page 6", "第一章Page 12"]);
    wrapper.unmount();
  });

  // Two views of one book, and they have to agree about where the reader is.
  it("switches between the page and the prose, and remembers which", async () => {
    const wrapper = await mountPdf();
    const seg = () => wrapper.findAll(".tb-seg button");
    expect(seg().map((b) => b.text())).toEqual(["Page", "Text"]);
    expect(seg()[0].classes()).toContain("on");

    // The page view stays mounted behind the prose: it owns the document, and
    // tearing it down would mean loading the file again to go back.
    await seg()[1].trigger("click");
    await flushPromises();
    expect(seg()[1].classes()).toContain("on");
    expect(wrapper.findComponent({ name: "PdfReader" }).exists()).toBe(true);
    expect(localStorage.getItem("pdfView.9")).toBe("text");

    await seg()[0].trigger("click");
    await flushPromises();
    expect(localStorage.getItem("pdfView.9")).toBe("page");
    wrapper.unmount();
  });

  // A book is a novel or it is a manual; which view suits it does not change
  // between sittings.
  it("opens a book in the view it was left in", async () => {
    localStorage.setItem("pdfView.9", "text");
    const wrapper = await mountPdf();
    await flushPromises();
    expect(wrapper.findAll(".tb-seg button")[1].classes()).toContain("on");
    wrapper.unmount();
  });

  // The typography panel is the whole panel over prose, and only what reaches
  // a picture over the page view.
  it("offers the full typography panel over the prose", async () => {
    const wrapper = await mountPdf();
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();
    // Page view still has the surface settings; prose adds type/layout tabs.
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".rp-tabs").exists()).toBe(true);
    wrapper.unmount();
  });

  it("has no contents to show for a file that carries none", async () => {
    const wrapper = await mountPdf();
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".toc-empty").exists()).toBe(true);
    expect(wrapper.findAll(".toc-item")).toHaveLength(0);
    wrapper.unmount();
  });

  // Space is the key people read with. The text reader had it; the PDF branch
  // did not — so switching formats found the main key dead.
  it("turns the page with Space, and jumps with Home and End", async () => {
    const wrapper = await mountPdf();
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;

    // Opens at the saved page (137 of 411). The keyboard drives the real
    // goToPage; we read the page that stuck, not a spy the expose may hide.
    expect(page()).toBe(137);

    const press = (init: KeyboardEventInit) => {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
    };

    press({ key: " " });
    expect(page()).toBe(138);
    press({ key: " ", shiftKey: true });
    expect(page()).toBe(137);
    press({ key: "PageDown" });
    expect(page()).toBe(138);
    press({ key: "PageUp" });
    expect(page()).toBe(137);
    press({ key: "Home" });
    expect(page()).toBe(1);
    press({ key: "End" });
    expect(page()).toBe(411);
    press({ key: "ArrowDown" });
    expect(page()).toBe(411); // already at the end
    press({ key: "Home" });
    press({ key: "ArrowDown" });
    expect(page()).toBe(2);
    wrapper.unmount();
  });

  it("does not fly through the book on a held Space", async () => {
    const wrapper = await mountPdf();
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    expect(page()).toBe(137);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", repeat: true }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("does not turn the page while Contents is open", async () => {
    const wrapper = await mountPdf();
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("pages the prose, not the hidden canvas, in Text view", async () => {
    const wrapper = await mountPdf();
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    expect(page()).toBe(137);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("pages the prose by a screenful, not a file page", async () => {
    const wrapper = await mountPdf();
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    const scroll = wrapper.get(".pdf-text .reader-scroll").element as HTMLElement;
    stubYScroll(scroll, 400, 4000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    // One view minus two lines of leading (28): the unit the text reader uses.
    expect(scroll.scrollTop).toBe(344);
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("marks the outline entry the reader is in", async () => {
    const wrapper = await mountPdf();
    await wrapper.findComponent({ name: "PdfReader" }).vm.$emit("outline", [
      { title: "新版序", level: 0, page: 6 },
      { title: "第一章", level: 0, page: 12 },
    ]);
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    const current = wrapper.findAll(".toc-item").filter((r) => r.classes().includes("current"));
    expect(current).toHaveLength(1);
    expect(current[0].text()).toContain("第一章");
    wrapper.unmount();
  });

  it("keeps the page on close even if the debounce has not fired", async () => {
    const api = await import("../../../api");
    const wrapper = await mountPdf();
    wrapper.unmount();
    expect(api.saveProgress).toHaveBeenCalledWith(9, 0, 0, 137);
  });

  it("does not turn the page when click-paging is off", async () => {
    const wrapper = await mountPdf();
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    const root = wrapper.get(".reader").element as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(edgeRect());
    root.dispatchEvent(new MouseEvent("click", { clientX: 20, clientY: 300, bubbles: true }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("pages the prose from a click on the edge", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerClickPaging", true);
    const wrapper = await mountPdf(pinia);
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    const scroll = wrapper.get(".pdf-text .reader-scroll").element as HTMLElement;
    stubYScroll(scroll, 400, 4000);
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(edgeRect());
    const root = wrapper.get(".reader").element as HTMLElement;
    root.dispatchEvent(new MouseEvent("click", { clientX: 780, clientY: 300, bubbles: true }));
    expect(scroll.scrollTop).toBe(344);
    wrapper.unmount();
  });

  it("turns the page from a click on the edge, when that is asked for", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerClickPaging", true);
    const wrapper = await mountPdf(pinia);
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    const root = wrapper.get(".reader").element as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(edgeRect());
    root.dispatchEvent(new MouseEvent("click", { clientX: 20, clientY: 300, bubbles: true }));
    expect(page()).toBe(136);
    root.dispatchEvent(new MouseEvent("click", { clientX: 780, clientY: 300, bubbles: true }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("does not turn the page on a drag that started as a selection", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerClickPaging", true);
    const wrapper = await mountPdf(pinia);
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    const root = wrapper.get(".reader").element as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(edgeRect());
    root.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 300, bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { clientX: 50, clientY: 300, bubbles: true }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("does not turn the page on the click that put More away", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerClickPaging", true);
    const wrapper = await mountPdf(pinia);
    const page = () =>
      (wrapper.findComponent({ name: "PdfReader" }).vm as { currentPage: number }).currentPage;
    await wrapper.get('button[aria-label="More"]').trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    const root = wrapper.get(".reader").element as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(edgeRect());
    root.dispatchEvent(new MouseEvent("mousedown", { clientX: 20, clientY: 300, bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { clientX: 20, clientY: 300, bubbles: true }));
    expect(page()).toBe(137);
    wrapper.unmount();
  });

  it("marks the scroller's page-edge the way the text reader does", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerClickPaging", true);
    const wrapper = await mountPdf(pinia);
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    const scroll = wrapper.get(".pdf-text .reader-scroll").element as HTMLElement;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(edgeRect());
    const root = wrapper.get(".reader").element as HTMLElement;
    root.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 300, bubbles: true }));
    expect(scroll.dataset.pageEdge).toBe("left");
    root.dispatchEvent(new MouseEvent("mousemove", { clientX: 780, clientY: 300, bubbles: true }));
    expect(scroll.dataset.pageEdge).toBe("right");
    root.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 300, bubbles: true }));
    expect(scroll.dataset.pageEdge).toBeUndefined();
    wrapper.unmount();
  });

  it("shows the status line over the prose", async () => {
    const { useUi } = await import("../../../stores/ui");
    const pinia = createPinia();
    setActivePinia(pinia);
    useUi().setReading("readerShowPage", true);
    const PdfView = (await import("./PdfView.vue")).default;
    const wrapper = mount(PdfView, {
      props: { book: pdfBook },
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
        stubs: { HighlightLayer: true },
      },
      attachTo: document.body,
    });
    await wrapper.findAll(".tb-seg button")[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".reader-status").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("PdfView PDF byte cache", () => {
  it("fetches the file once across close/reopen of the same book", async () => {
    const api = await import("../../../api");
    // A non-empty payload, so load() reaches the caching branch (the file's
    // default mock returns empty bytes, which is the error path).
    (api.sourceBytes as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const first = await mountPdf();
    first.unmount();
    const callsAfterFirst = (api.sourceBytes as ReturnType<typeof vi.fn>).mock.calls.length;
    // Reopen the same book: the cached bytes must skip a second sourceBytes.
    const second = await mountPdf();
    second.unmount();
    expect((api.sourceBytes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });
});
