// The text reading screen, checked from the outside the way PdfView is: chrome
// a chapter book is read with, and the settings panel that reaches the type.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../../../locales/en.json";
import type { BookDetail } from "../../../types";

/** Scroll handlers now coalesce to one pass per frame; let that frame land. */
const flushRaf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

vi.mock("../../../api", () => ({
  getChapter: vi.fn(async () => ({
    bookId: 1,
    index: 0,
    title: "Chapter One",
    html: "<p>Hello world.</p><p>Second paragraph.</p>",
    charCount: 40,
    aiSummary: null,
  })),
  getBook: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  setBookFlag: vi.fn(async () => {}),
  saveProgress: vi.fn(async () => {}),
  addBookmark: vi.fn(async () => ({})),
  listBookmarks: vi.fn(async () => []),
  listBookHighlights: vi.fn(async () => []),
  getTranslation: vi.fn(async () => null),
  resourceBytes: vi.fn(async () => new Uint8Array()),
  listInstalledFonts: vi.fn(async () => []),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

const textBook = {
  id: 1,
  title: "A Chapter Book",
  author: "Author",
  format: "epub",
  pageCount: 0,
  chapterCount: 2,
  charCount: 100,
  isFinished: false,
  isFavorite: false,
  hasCover: false,
  percent: 0.1,
  chapters: [
    { index: 0, title: "Chapter One", level: 1, href: "ch1.xhtml", charCount: 40 },
    { index: 1, title: "Chapter Two", level: 1, href: "ch2.xhtml", charCount: 60 },
  ],
  tags: [],
  progress: { chapterIndex: 0, chapterRatio: 0.2, page: 0, percent: 0.1, updatedAt: "" },
  description: null,
  identifier: null,
  publishedAt: null,
} as unknown as BookDetail;

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  // jsdom never fires rAF callbacks on its own; run them synchronously so
  // scroll/reflow handlers that coalesce through rAF stay deterministic.
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    cb(performance.now());
    return 1;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

async function mountText() {
  const TextReader = (await import("./TextReader.vue")).default;
  const wrapper = mount(TextReader, {
    props: { book: textBook },
    global: {
      plugins: [createPinia(), [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
      // HighlightLayer reaches for MutationObserver + more APIs the suite does
      // not need for chrome-level checks.
      stubs: { HighlightLayer: true },
    },
    attachTo: document.body,
  });
  await flushPromises();
  // Let chapter HTML watchers settle without leaving unhandled rejections.
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
  return wrapper;
}

describe("the text reading screen", () => {
  it("carries the chrome a chapter book is read with", async () => {
    const wrapper = await mountText();
    const labels = wrapper.findAll("button").map((b) => b.attributes("aria-label") ?? "");

    // Primary bar: contents, type, translate, auto-scroll, overflow menu.
    // Contents lives in the bar itself — a floating corner button used to
    // sit there after the bar stopped hiding, and looked stranded.
    expect(wrapper.find(".reader-toc-fab").exists()).toBe(false);
    expect(wrapper.find(".tb-cluster-start").exists()).toBe(true);
    expect(labels).toContain("Contents");
    expect(labels).toContain("Typography");
    expect(labels).toContain("Translate chapter (T)");
    expect(labels).toContain("Auto-scroll (S)");
    expect(labels).toContain("More");
    // Secondary actions live under More — open it and they appear.
    await wrapper.get('button[aria-label="More"]').trigger("click");
    await flushPromises();
    const openLabels = wrapper.findAll("button").map((b) => b.attributes("aria-label") ?? b.text());
    expect(openLabels.some((s) => s.includes("Bookmark"))).toBe(true);
    expect(openLabels.some((s) => s.includes("Summarize"))).toBe(true);
    wrapper.unmount();
  });

  it("opens the full typography panel, not the PDF subset", async () => {
    const wrapper = await mountText();
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();

    expect(wrapper.find(".rp-tabs").exists()).toBe(true);
    // The type settings are there, which a PDF's panel does not offer.
    expect(wrapper.findAll(".rs-row .rs-label").map((l) => l.text())).toContain("Size");
    wrapper.unmount();
  });

  it("does not write progress before the chapter has painted a position", async () => {
    const api = await import("../../../api");
    const save = vi.mocked(api.saveProgress);
    save.mockClear();

    const wrapper = await mountText();
    // Opening must not have flushed a debounced save of ratio 0 over the
    // restored position. goTo saves immediately; initial paint restores first.
    // Allow a tick for any accidental scheduleSave.
    await new Promise((r) => setTimeout(r, 50));
    const early = save.mock.calls.filter((c) => c[0] === 1 && c[2] === 0 && c[1] === 0);
    // A restore-from-0.2 book should not have written ratio 0 yet from scroll.
    // (goTo is not called on open.)
    expect(early.length).toBe(0);
    wrapper.unmount();
  });

});

// Reading in pages is the same chapter laid out across instead of down. What
// makes that safe is that nothing in the reader knows which: every question
// about where the reader is goes through one position layer, on an axis.
describe("reading in pages", () => {
  async function paged() {
    const { useUi } = await import("../../../stores/ui");
    // The component gets its own pinia, so reach for the store *it* uses —
    // setting a mode on a different instance of the same store is a test that
    // proves nothing.
    const pinia = createPinia();
    useUi(pinia).setReading("readerPageMode", "paged");
    const TextReader = (await import("./TextReader.vue")).default;
    const wrapper = mount(TextReader, {
      props: { book: textBook },
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
        stubs: { HighlightLayer: true },
      },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    await flushPromises();
    const ui = useUi(pinia);
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    // jsdom lays nothing out, so the page geometry is given: a chapter of ten
    // pages, each the width of the viewport.
    Object.defineProperty(el, "clientWidth", { value: 744, configurable: true });
    Object.defineProperty(el, "scrollWidth", { value: 7440, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 0, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 0, configurable: true });
    return { wrapper, el, ui };
  }

  it("lays the chapter out across", async () => {
    const { wrapper } = await paged();
    expect(wrapper.get(".reader-scroll").classes()).toContain("paged");
    wrapper.unmount();
  });

  it("turns a page with the arrow, not the chapter", async () => {
    const { wrapper, el } = await paged();
    el.scrollLeft = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("turns from the right edge in pages mode without the click-paging pref", async () => {
    const { wrapper, el, ui } = await paged();
    expect(ui.readerClickPaging).toBe(false);
    el.scrollLeft = 0;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 744,
      top: 0,
      height: 600,
      right: 744,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    el.dispatchEvent(new MouseEvent("click", { clientX: 720, clientY: 300, bubbles: true }));
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    wrapper.unmount();
  });

  it("turns exactly one page, and does not scroll down", async () => {
    const { wrapper, el } = await paged();
    el.scrollLeft = 0;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await flushPromises();

    // One viewport across — a page that overlapped the last one would not be a
    // page — and nothing on the other axis.
    expect(el.scrollLeft).toBe(744);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("reports progress on the same scale a scrolled chapter does", async () => {
    const { wrapper, el } = await paged();
    const api = await import("../../../api");
    const save = vi.mocked(api.saveProgress);

    el.scrollLeft = (7440 - 744) / 2;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await new Promise((r) => setTimeout(r, 700));

    const ratios = save.mock.calls.map((c) => c[2]).filter((r) => typeof r === "number");
    expect(ratios.at(-1)).toBeCloseTo(0.5, 5);
    wrapper.unmount();
  });

  // The place is the only thing that survives a reflow: a page number means
  // nothing once the count has changed, and an offset means nothing once the
  // text has moved. None of it arrives as a resize — a larger type size is
  // just a setting.
  it("keeps the reader's place when the type gets bigger", async () => {
    const { wrapper, el, ui } = await paged();
    el.scrollLeft = (7440 - 744) / 2;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();

    // The chapter reflows to half as many pages.
    Object.defineProperty(el, "scrollWidth", { value: 3720, configurable: true });
    ui.setReading("readerSize", 21);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    await flushPromises();

    // Halfway through, still — not page 4 of 5, which is where the old offset
    // would have left them.
    expect(el.scrollLeft).toBeCloseTo((3720 - 744) / 2, 3);
    wrapper.unmount();
  });

  it("counts pages, not percent, once the chapter is read in pages", async () => {
    const { wrapper, el, ui } = await paged();
    // jsdom lays nothing out at mount, so the geometry above arrives after the
    // chapter has "painted"; a setting that reflows the page is what makes the
    // reader measure it, exactly as it would in a window.
    ui.setReading("readerSize", 18);
    await flushPromises();
    await nextTick();

    el.scrollLeft = 744 * 4;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushPromises();

    // Ten pages of 744 across a 7440 layout; page five of ten.
    expect(wrapper.get(".reader-status").text()).toContain("5");
    expect(wrapper.get(".reader-status").text()).toContain("10");
    wrapper.unmount();
  });

  // A trackpad delivers one flick as a burst of events with inertia trailing
  // behind it. A page per event would turn thirty.
  it("turns one page per flick, however many events a flick is", async () => {
    const { wrapper, el } = await paged();
    el.scrollLeft = 0;
    const flick = (at: number, deltaY = 40) => {
      const ev = new WheelEvent("wheel", { deltaY, cancelable: true });
      Object.defineProperty(ev, "timeStamp", { value: at });
      el.dispatchEvent(ev);
    };

    // One flick: thirty events over 300ms, none of them a gap.
    for (let i = 0; i < 30; i++) flick(1000 + i * 10);
    await flushPromises();
    expect(el.scrollLeft).toBe(744);

    // The next flick, after the events stop for a moment.
    for (let i = 0; i < 30; i++) flick(2000 + i * 10);
    await flushPromises();
    expect(el.scrollLeft).toBe(744 * 2);

    // And back.
    for (let i = 0; i < 5; i++) flick(3000 + i * 10, -40);
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    wrapper.unmount();
  });

  it("leaves the wheel alone when the chapter runs down", async () => {
    const wrapper = await mountText();
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });
    el.scrollTop = 500;

    const ev = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    el.dispatchEvent(ev);
    await flushPromises();

    // Scrolling is the engine's job here, and refusing the event would take it
    // away.
    expect(ev.defaultPrevented).toBe(false);
    expect(el.scrollTop).toBe(500);
    wrapper.unmount();
  });

  // Everything the reader does not do by hand has to land on a page too.
  it("lands a reflow on a page, not between two", async () => {
    const { wrapper, el, ui } = await paged();
    el.scrollLeft = 744 * 4;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();

    // A reflow to a chapter whose pages do not divide the old ratio evenly.
    Object.defineProperty(el, "scrollWidth", { value: 744 * 7, configurable: true });
    ui.setReading("readerSize", 18);
    await flushPromises();
    await nextTick();

    expect(el.scrollLeft % 744).toBe(0);
    wrapper.unmount();
  });

  it("goes back to scrolling when asked", async () => {
    const { wrapper, ui } = await paged();
    ui.setReading("readerPageMode", "scroll");
    await flushPromises();
    expect(wrapper.get(".reader-scroll").classes()).not.toContain("paged");
    wrapper.unmount();
  });
});

// A chapter says where it is at its head, and the head is on the first page
// and nowhere else — which scrolling makes a mild loss and paging makes total.
describe("the line at the foot of the page", () => {
  it("says nothing until something is asked for", async () => {
    const wrapper = await mountText();
    // The clock and the time left are off by default; the page number is on,
    // so the line is there — but it holds only what was asked for.
    const status = wrapper.find(".reader-status");
    expect(status.exists()).toBe(true);
    expect(status.text()).not.toMatch(/\d\d:\d\d/);
    wrapper.unmount();
  });

  it("goes quiet entirely when nothing is wanted", async () => {
    const { useUi } = await import("../../../stores/ui");
    const pinia = createPinia();
    const ui = useUi(pinia);
    ui.setReading("readerShowPage", false);
    ui.setReading("readerShowLeft", false);
    ui.setReading("readerShowClock", false);
    const TextReader = (await import("./TextReader.vue")).default;
    const wrapper = mount(TextReader, {
      props: { book: textBook },
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
        stubs: { HighlightLayer: true },
      },
      attachTo: document.body,
    });
    await flushPromises();
    expect(wrapper.find(".reader-status").exists()).toBe(false);
    wrapper.unmount();
  });
});

// Vertical (古籍) reading is the same chapter laid out down columns that run
// across — the x axis for the same position layer — plus the rules that only
// make sense in a column: the wheel turns pages even though the chapter is
// scrolled, the place is counted in columns, and a paged page goes tall and
// narrow.
describe("vertical (古籍) reading", () => {
  async function vertical(html?: string) {
    if (html !== undefined) {
      const api = await import("../../../api");
      vi.mocked(api.getChapter).mockResolvedValueOnce({
        bookId: 1,
        index: 0,
        title: "Chapter One",
        html,
        charCount: 100,
        aiSummary: null,
      });
    }
    const { useUi } = await import("../../../stores/ui");
    // The component gets its own pinia, so reach for the store *it* uses.
    const pinia = createPinia();
    useUi(pinia).setReading("readerOrientation", "vertical");
    const TextReader = (await import("./TextReader.vue")).default;
    const wrapper = mount(TextReader, {
      props: { book: textBook },
      global: {
        plugins: [pinia, [VueQueryPlugin, { queryClient: new QueryClient() }], i18n],
        stubs: { HighlightLayer: true },
      },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    await flushPromises();
    const ui = useUi(pinia);
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    // jsdom lays nothing out, so the geometry is given: a chapter of ten
    // screenfuls across.
    Object.defineProperty(el, "clientWidth", { value: 744, configurable: true });
    Object.defineProperty(el, "scrollWidth", { value: 7440, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 0, configurable: true });
    return { wrapper, el, ui };
  }

  it("turns forward from the left, the way a classical book does", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await flushPromises();
    expect(el.scrollLeft).toBe(744);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await flushPromises();
    expect(el.scrollLeft).toBe(0);
    wrapper.unmount();
  });

  it("turns forward from a click on the left edge", async () => {
    const { wrapper, el, ui } = await vertical();
    ui.setReading("readerClickPaging", true);
    el.scrollLeft = 0;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 744,
      top: 0,
      height: 600,
      right: 744,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    el.dispatchEvent(new MouseEvent("click", { clientX: 40, clientY: 300, bubbles: true }));
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    wrapper.unmount();
  });

  it("turns forward on a leftward flick", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;
    el.dispatchEvent(new WheelEvent("wheel", { deltaX: -80, deltaY: 0, bubbles: true, cancelable: true }));
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    wrapper.unmount();
  });

  it("turns a page with the wheel in scroll mode", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;

    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    await flushPromises();

    // One viewport across, as a flick means in any across-running chapter —
    // and nothing on the other axis, which the browser could not have done.
    expect(el.scrollLeft).toBe(744);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("wraps digit runs for vertical reading (纵中横)", async () => {
    const { wrapper } = await vertical("<p>成书于1176年，凡12卷。</p>");
    const body = wrapper.get(".article-body");

    // A year and a count read as one horizontal cell each in the column.
    expect(body.element.innerHTML).toContain('<span class="tcy">1176</span>');
    expect(body.element.innerHTML).toContain('<span class="tcy">12</span>');
    wrapper.unmount();
  });

  it("skims freely with shift+wheel", async () => {    const { wrapper, el } = await vertical();
    el.scrollLeft = 500;

    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 60, shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flushPromises();

    // A free horizontal nudge along the column, not a page turn.
    expect(el.scrollLeft).toBe(560);
    wrapper.unmount();
  });

  it("ends the chapter on the axis it runs across", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    await flushPromises();

    // The end of a vertical chapter is the far end of the x scroller — End
    // used to scroll down, where a vertical chapter has nothing.
    expect(el.scrollLeft).toBe(7440 - 744);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("counts the place in columns, not percent", async () => {
    const { wrapper, el } = await vertical();
    // Three screenfuls in of ten.
    el.scrollLeft = 3 * 744;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();

    const status = wrapper.get(".reader-status");
    expect(status.text()).toMatch(/Col(?:umn)? 4 of 10/);
    expect(status.text()).not.toContain("%");
    wrapper.unmount();
  });

  it("keeps the reader's place when the writing direction flips", async () => {
    const { wrapper, el, ui } = await vertical();
    el.scrollLeft = 3 * 744;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();

    // After the flip the chapter runs down, so the restore writes scrollTop.
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });

    ui.setReading("readerOrientation", "horizontal");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 120));
    await flushPromises();

    // A third of the way through (three of nine steps) on a 3400-span
    // scroller — not the chapter head the remount used to open on.
    expect(el.scrollTop).toBeCloseTo(((4000 - 600) * 3) / 9, 0);
    wrapper.unmount();
  });

  it("sizes a paged page to the window, not the measure", async () => {
    const { wrapper, el, ui } = await vertical();
    ui.setReading("readerPageMode", "paged");
    ui.setReading("readerWidth", 520);
    await flushPromises();

    // The page is the reading surface so left/right turn zones stay on
    // the window. 单行宽度 only shrinks the 版心 inside it.
    expect(el.style.width).toBe("100%");
    expect(el.style.maxWidth).toBe("100%");
    expect(el.style.getPropertyValue("--reader-width")).toBe("520px");
    expect(wrapper.get(".reader-scroll").classes()).toContain("paged");
    wrapper.unmount();
  });

  it("turns forward on a leftward finger-flick", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;
    const start = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(start, "changedTouches", { value: [{ clientX: 400, clientY: 200 }] });
    Object.defineProperty(start, "timeStamp", { value: 1000 });
    const end = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(end, "changedTouches", { value: [{ clientX: 280, clientY: 208 }] });
    Object.defineProperty(end, "timeStamp", { value: 1120 });
    el.dispatchEvent(start);
    el.dispatchEvent(end);
    await flushPromises();
    expect(el.scrollLeft).toBe(744);
    wrapper.unmount();
  });

  it("does not turn the page on a drag that started as a selection", async () => {
    const { wrapper, el, ui } = await vertical();
    ui.setReading("readerClickPaging", true);
    el.scrollLeft = 0;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 744, top: 0, height: 600,
      right: 744, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 300, bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { clientX: 50, clientY: 300, bubbles: true }));
    await flushPromises();
    expect(el.scrollLeft).toBe(0);
    wrapper.unmount();
  });

  it("leaves a pinch-zoom wheel alone", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 0;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, ctrlKey: true, cancelable: true, bubbles: true }));
    await flushPromises();
    expect(el.scrollLeft).toBe(0);
    wrapper.unmount();
  });

  it("Home is the start of the column stream, not the top", async () => {
    const { wrapper, el } = await vertical();
    el.scrollLeft = 3 * 744;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    await flushPromises();
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("hides the 书耳 while the contents sheet is open", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const { wrapper } = await vertical();
    expect(wrapper.get(".reader-status").classes()).not.toContain("hidden");
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    expect(wrapper.get(".reader-status").classes()).toContain("hidden");
    wrapper.unmount();
  });
});

// The drop cap lands on the chapter's first *visible* paragraph — the one a
// reader actually sees, not the first <p> the blank-trim preference may have
// hidden. jsdom lays nothing out, so that visibility check needs an offsetParent
// to look at; the article is the nearest positioned ancestor, as in a window.
describe("the drop-cap target", () => {
  it("marks the first visible paragraph", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest(".article") ?? null;
      },
    });
    const wrapper = await mountText();
    await flushRaf();
    await flushPromises();

    const target = wrapper.get(".article-body").element.querySelector("p.dropcap-target");
    expect(target?.textContent).toContain("Hello world");
    wrapper.unmount();
  });
});
