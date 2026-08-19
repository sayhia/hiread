// Trimming a PDF's margins, checked from the outside.
//
// The trim is a viewport offset with the canvas sized to the box, so a page
// that is trimmed and a page that is not look identical to everything except
// their measurements — which is why the one bug this file exists for was
// invisible: a book reopened with the trim remembered as on laid its pages out
// at the full sheet, because the box is measured from the file rather than
// saved with the preference, and nothing measured it.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../../../locales/en.json";
import type { BookDetail } from "../../../types";

class Stub {}
Object.assign(globalThis, {
  DOMMatrix: globalThis.DOMMatrix ?? Stub,
  Path2D: globalThis.Path2D ?? Stub,
  ImageData: globalThis.ImageData ?? Stub,
});

const PAGE_W = 612;
const PAGE_H = 792;
/** The same margins the real book has: text from x=80 to x=530, y=80 to y=710. */
const INK = { x0: 80, x1: 530, y0: 80, y1: 710 };

/** One text run per line, in PDF user space (y counts up from the foot). */
function textItems() {
  const items: {
    str: string;
    width: number;
    height: number;
    transform: number[];
    hasEOL: boolean;
  }[] = [];
  for (let y = INK.y1; y >= INK.y0; y -= 18) {
    items.push({
      str: "行文行文行文行文",
      width: INK.x1 - INK.x0,
      height: 12,
      transform: [12, 0, 0, 12, INK.x0, y],
      hasEOL: true,
    });
  }
  return items;
}

const getTextContent = vi.fn(async () => ({ items: textItems() }));

function fakePage() {
  return {
    getViewport: ({ scale = 1, offsetX = 0, offsetY = 0 } = {}) => ({
      width: PAGE_W * scale,
      height: PAGE_H * scale,
      scale,
      offsetX,
      offsetY,
      rotation: 0,
    }),
    getTextContent,
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    cleanup: () => {},
  };
}

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 40,
      getPage: async () => fakePage(),
      getOutline: async () => null,
      getMetadata: async () => ({ info: {} }),
      destroy: () => {},
    }),
  }),
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
  },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));

vi.mock("../../../api", () => ({
  sourceBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  hasIndexedText: vi.fn(async () => true),
  indexPdfText: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  saveProgress: vi.fn(async () => {}),
  updateBookMeta: vi.fn(async () => {}),
  listBookmarks: vi.fn(async () => []),
  listBookHighlights: vi.fn(async () => []),
  createHighlight: vi.fn(async () => 1),
  deleteHighlight: vi.fn(async () => {}),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} }, Browser: { OpenURL: async () => {} } }));

const book = {
  id: 9,
  title: "我不是教你诈",
  format: "pdf",
  pageCount: 40,
  chapterCount: 0,
  isFinished: false,
  isFavorite: false,
  hasCover: true,
  chapters: [],
  tags: [],
  progress: { chapterIndex: 0, chapterRatio: 0, page: 1, percent: 0, updatedAt: "" },
} as unknown as BookDetail;

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

async function mountReader(pinia = createPinia()) {
  setActivePinia(pinia);
  const PdfReader = (await import("./PdfReader.vue")).default;
  const wrapper = mount(PdfReader, {
    props: { book },
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

/** The methods PdfReader exposes via defineExpose, which test-utils' `vm` typing
 *  does not carry on a dynamically imported script-setup component. */
type ReaderExposed = {
  setCropped(on: boolean): Promise<void>;
  setZoom(n: number): void;
  fitWidth(): Promise<void>;
  pageBy(dir: number): void;
  zoom: number;
  currentPage: number;
};
const exposed = (wrapper: Awaited<ReturnType<typeof mountReader>>) =>
  wrapper.vm as unknown as ReaderExposed;

function stubWidth(el: HTMLElement, w: number) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: w });
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

function box(top: number, bottom: number, left = 0, right = 800): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The laid-out size of the first page box, which is the whole sheet or the
 *  trimmed box and nothing in between. */
function firstPageSize() {
  const box = document.querySelector<HTMLElement>(".pdf-page");
  return box ? { w: parseInt(box.style.width, 10), h: parseInt(box.style.height, 10) } : null;
}

describe("trimming a PDF's margins", () => {
  it("lays the pages out at the full sheet until it is asked not to", async () => {
    await mountReader();
    expect(firstPageSize()).toEqual({ w: PAGE_W, h: PAGE_H });
  });

  it("trims to the text's own box, with air around it", async () => {
    const wrapper = await mountReader();
    await exposed(wrapper).setCropped(true);
    await flushPromises();

    const size = firstPageSize()!;
    // Narrower and shorter than the sheet, but never inside the ink: the box is
    // padded, so the trimmed page is a little larger than the text it holds.
    expect(size.w).toBeLessThan(PAGE_W);
    expect(size.w).toBeGreaterThanOrEqual(INK.x1 - INK.x0);
    expect(size.h).toBeLessThan(PAGE_H);
    expect(size.h).toBeGreaterThanOrEqual(INK.y1 - INK.y0);
  });

  it("opens a book trimmed when that is how it was left", async () => {
    // The preference is saved; the box is not. This is the bug: on a reopen
    // `cropped` was true and the box was still null, so every page was laid out
    // at the full sheet while the button said it was trimmed.
    localStorage.setItem("pdfCrop.9", "1");
    await mountReader();

    const size = firstPageSize()!;
    expect(size.w).toBeLessThan(PAGE_W);
    expect(size.h).toBeLessThan(PAGE_H);
  });

  it("measures the box from a spread of pages rather than every one", async () => {
    localStorage.setItem("pdfCrop.9", "1");
    await mountReader();
    // 40 pages, two dozen sampled: a long book pays for the trim once, and in
    // text geometry rather than in rendering.
    expect(getTextContent.mock.calls.length).toBeLessThanOrEqual(24);
  });

  it("hides the page number when the display setting is off", async () => {
    const wrapper = await mountReader();
    expect(wrapper.find(".pdf-pageno").exists()).toBe(true);
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerShowPage", false);
    await flushPromises();
    expect(wrapper.find(".pdf-pageno").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the page number and a clock when those are asked for", async () => {
    const wrapper = await mountReader();
    const { useUi } = await import("../../../stores/ui");
    useUi().setReading("readerShowClock", true);
    await flushPromises();
    expect(wrapper.find(".pdf-pageno").exists()).toBe(true);
    expect(wrapper.find(".pdf-pageno").text()).toMatch(/1/);
    expect(wrapper.find(".pdf-meta").text()).toMatch(/\d{1,2}:\d{2}/);
    expect(wrapper.find(".pdf-bar-hotzone").exists()).toBe(true);
    wrapper.unmount();
  });

  it("goes back to the whole sheet when the trim is turned off", async () => {
    localStorage.setItem("pdfCrop.9", "1");
    const wrapper = await mountReader();
    await exposed(wrapper).setCropped(false);
    await flushPromises();

    expect(firstPageSize()).toEqual({ w: PAGE_W, h: PAGE_H });
    expect(localStorage.getItem("pdfCrop.9")).toBe("0");
  });
});

describe("fitting a PDF to the window", () => {
  it("refits on resize until the reader picks a zoom", async () => {
    const wrapper = await mountReader();
    const scroll = document.querySelector<HTMLElement>(".pdf-scroll")!;
    stubWidth(scroll, 1100);
    await exposed(wrapper).fitWidth();
    await flushPromises();
    expect(exposed(wrapper).zoom).toBe(1.72);

    stubWidth(scroll, 800);
    window.dispatchEvent(new Event("resize"));
    await wait(180);
    await flushPromises();
    expect(exposed(wrapper).zoom).toBe(1.23);
    wrapper.unmount();
  });

  it("does not fight a zoom the reader chose", async () => {
    const wrapper = await mountReader();
    const scroll = document.querySelector<HTMLElement>(".pdf-scroll")!;
    stubWidth(scroll, 1100);
    await exposed(wrapper).fitWidth();
    await flushPromises();
    exposed(wrapper).setZoom(1.5);
    await flushPromises();

    stubWidth(scroll, 800);
    window.dispatchEvent(new Event("resize"));
    await wait(180);
    await flushPromises();
    expect(exposed(wrapper).zoom).toBe(1.5);
    wrapper.unmount();
  });

  it("refits after a trim while still fitted", async () => {
    const wrapper = await mountReader();
    const scroll = document.querySelector<HTMLElement>(".pdf-scroll")!;
    stubWidth(scroll, 1100);
    await exposed(wrapper).fitWidth();
    await flushPromises();
    const before = exposed(wrapper).zoom;

    await exposed(wrapper).setCropped(true);
    await flushPromises();
    expect(exposed(wrapper).zoom).toBeGreaterThan(before);
    wrapper.unmount();
  });

  it("keeps a chosen zoom when the trim changes", async () => {
    const wrapper = await mountReader();
    const scroll = document.querySelector<HTMLElement>(".pdf-scroll")!;
    stubWidth(scroll, 1100);
    exposed(wrapper).setZoom(2);
    await flushPromises();

    await exposed(wrapper).setCropped(true);
    await flushPromises();
    expect(exposed(wrapper).zoom).toBe(2);
    wrapper.unmount();
  });
});

describe("turning a tall PDF page", () => {
  it("scrolls the rest of the sheet before incrementing the page", async () => {
    const wrapper = await mountReader();
    const scroll = document.querySelector<HTMLElement>(".pdf-scroll")!;
    const pageAt = (n: number) =>
      document.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`)!;
    stubYScroll(scroll, 500, 2000);
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(box(0, 500));
    vi.spyOn(pageAt(1), "getBoundingClientRect").mockReturnValue(box(0, 1600));

    exposed(wrapper).pageBy(1);
    expect(exposed(wrapper).currentPage).toBe(1);
    expect(scroll.scrollTop).toBe(452);

    vi.spyOn(pageAt(1), "getBoundingClientRect").mockReturnValue(box(0, 500));
    exposed(wrapper).pageBy(1);
    expect(exposed(wrapper).currentPage).toBe(2);

    stubYScroll(scroll, 500, 2000, 600);
    vi.spyOn(pageAt(2), "getBoundingClientRect").mockReturnValue(box(-200, 1400));
    exposed(wrapper).pageBy(-1);
    expect(exposed(wrapper).currentPage).toBe(2);
    expect(scroll.scrollTop).toBe(148);
    wrapper.unmount();
  });
});
