// The highlight layer is the one place where a mouse gesture turns into stored
// data, and the conversion to books moved what that data is keyed by — from an
// article id to a (book, chapter) pair. These tests drive it the way a reader
// does: select text in a rendered chapter, and check what reaches the backend
// and what comes back onto the page.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../locales/en.json";
import { useUi } from "../stores/ui";
import type { Highlight } from "../types";

const listHighlights = vi.fn(async (_bookId: number, _chapterIndex: number): Promise<Highlight[]> => []);
const createHighlight = vi.fn(async (_h: unknown): Promise<number> => 1);

vi.mock("../api", () => ({
  listHighlights: (b: number, c: number) => listHighlights(b, c),
  createHighlight: (h: unknown) => createHighlight(h),
  updateHighlightNote: vi.fn(async () => {}),
  setHighlightColor: vi.fn(async () => {}),
  deleteHighlight: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  toggleFullscreen: vi.fn(async () => false),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

const CHAPTER_HTML =
  "<p>I went to the woods because I wished to live deliberately.</p>" +
  "<p>I did not wish to live what was not life.</p>";

/** A rendered chapter body, attached to the document so ranges and events
 *  behave the way they do in the reader. */
function renderChapter(): HTMLElement {
  const body = document.createElement("div");
  body.className = "article-body";
  body.innerHTML = CHAPTER_HTML;
  document.body.appendChild(body);
  return body;
}

/** The layer defers reading the selection by a macrotask, so the browser has
 *  committed it before the popover is placed; flushPromises alone only drains
 *  microtasks. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
};

/** Select `length` characters starting at `start` inside a text node, the way
 *  dragging across a phrase does. */
function selectText(node: Text, start: number, length: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  listHighlights.mockResolvedValue([]);
  createHighlight.mockClear();
  // jsdom has no layout, so every rect is zero — the popover only uses these to
  // place itself.
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 40, right: 200, width: 160, height: 20 }) as DOMRect;
  Element.prototype.scrollIntoView = vi.fn();
});

async function mountLayer(
  body: HTMLElement,
  bookId = 7,
  chapterIndex = 2,
  scrollEl?: HTMLElement | null,
) {
  const HighlightLayer = (await import("./HighlightLayer.vue")).default;
  const wrapper = mount(HighlightLayer, {
    props: { bookId, chapterIndex, bodyEl: body, scrollEl },
    // The layer invalidates the reader's notes list when a highlight is made.
    global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient: new QueryClient() }], i18n] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe("HighlightLayer", () => {
  it("saves a selection against the book and chapter being read", async () => {
    const body = renderChapter();
    const wrapper = await mountLayer(body);

    // "the woods" — 9 characters starting at offset 10 of the first paragraph.
    const text = body.querySelector("p")!.firstChild as Text;
    selectText(text, 10, 9);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();

    // The popover opens on the selection, quoting it back.
    const popover = document.querySelector(".hl-popover");
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain("the woods");

    // Committing writes it through with the reader's own coordinates.
    const done = Array.from(document.querySelectorAll(".hl-popover button")).find((b) =>
      /done|save/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement | undefined;
    expect(done, "the popover should offer a way to commit").toBeDefined();
    done!.click();
    await flushPromises();

    expect(createHighlight).toHaveBeenCalledTimes(1);
    const sent = createHighlight.mock.calls[0][0] as {
      bookId: number;
      chapterIndex: number;
      quote: string;
      textOffset: number;
      prefix: string;
      suffix: string;
    };
    expect(sent.bookId).toBe(7);
    expect(sent.chapterIndex).toBe(2);
    expect(sent.quote).toBe("the woods");
    // The offset is into the chapter's plain text, which is what re-anchors the
    // highlight when the same chapter is rendered again.
    expect(sent.textOffset).toBe(10);
    expect(sent.prefix.endsWith("I went to ")).toBe(true);
    expect(sent.suffix.startsWith(" because")).toBe(true);
    wrapper.unmount();
  });

  it("anchors the popover beside the selection in vertical mode", async () => {
    const body = renderChapter();
    const wrapper = await mountLayer(body);
    const ui = useUi(wrapper.vm.$pinia);
    ui.setReading("readerOrientation", "vertical");

    const text = body.querySelector("p")!.firstChild as Text;
    selectText(text, 10, 9);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();

    // Beside the selection — on its left (reading-end), so the column just
    // read is not covered. A right-side anchor used to sit on the glyphs.
    const popover = document.querySelector(".hl-popover") as HTMLElement | null;
    expect(popover?.style.left).toBe("8px");
    expect(popover?.style.top).toBe("100px"); // rect.top, not bottom + 8
    wrapper.unmount();
  });

  it("paints stored highlights back onto the chapter", async () => {
    listHighlights.mockResolvedValue([
      {
        id: 3,
        bookId: 7,
        chapterIndex: 2,
        quote: "deliberately",
        prefix: "wished to live ",
        suffix: ".",
        textOffset: 47,
        color: "yellow",
        note: "",
        createdAt: "2026-08-05T00:00:00Z",
      },
    ]);
    const body = renderChapter();
    const wrapper = await mountLayer(body);
    await flushPromises();

    const mark = body.querySelector("mark");
    expect(mark, "the stored highlight should be marked up in the body").not.toBeNull();
    expect(mark!.textContent).toBe("deliberately");
    // The chapter's own text is untouched around it.
    expect(body.textContent).toContain("I wished to live deliberately.");
    wrapper.unmount();
  });

  it("asks for the highlights of the chapter it is given, and again when the page turns", async () => {
    const body = renderChapter();
    const wrapper = await mountLayer(body, 7, 2);
    expect(listHighlights).toHaveBeenCalledWith(7, 2);

    await wrapper.setProps({ chapterIndex: 3 });
    await flushPromises();
    expect(listHighlights).toHaveBeenLastCalledWith(7, 3);
    wrapper.unmount();
  });

  it("keeps the selection popover through a layout scroll, not a user wheel", async () => {
    const body = renderChapter();
    const el = document.createElement("div");
    const wrapper = await mountLayer(body, 7, 2, el);

    const text = body.querySelector("p")!.firstChild as Text;
    selectText(text, 10, 9);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    expect(document.querySelector(".hl-popover")).not.toBeNull();

    // Image resolve / translation / paged restore only fire `scroll`.
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    await settle();
    expect(document.querySelector(".hl-popover")).not.toBeNull();

    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    await settle();
    expect(document.querySelector(".hl-popover")).toBeNull();
    wrapper.unmount();
  });

  it("ignores a collapsed click, which is not a selection", async () => {
    const body = renderChapter();
    const wrapper = await mountLayer(body);

    window.getSelection()!.removeAllRanges();
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();

    expect(document.querySelector(".hl-popover")).toBeNull();
    expect(createHighlight).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

// `scrollIntoView` has no idea that a paged chapter only has positions a page
// apart: `block` is the axis a horizontal scroller does not use, and `inline`
// defaults to "nearest", which moves the least it can and lands between two
// pages. It was the fifth place in the reader computing a position in pixels
// without knowing pixels are not where a page can be.
describe("bringing a highlight into view", () => {
  function scroller(axis: "y" | "x") {
    const el = document.createElement("div");
    const set = (k: string, v: number) =>
      Object.defineProperty(el, k, { value: v, configurable: true });
    if (axis === "x") {
      set("clientWidth", 744);
      set("scrollWidth", 7440);
      set("clientHeight", 0);
      set("scrollHeight", 0);
    } else {
      set("clientHeight", 600);
      set("scrollHeight", 6000);
      set("clientWidth", 0);
      set("scrollWidth", 0);
    }
    el.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
    return el;
  }

  /** A mark sitting a given distance along the content. */
  function markAt(host: HTMLElement, axis: "y" | "x", offset: number) {
    const mark = document.createElement("mark");
    mark.dataset.hl = "7";
    mark.getBoundingClientRect = () =>
      (axis === "x"
        ? { top: 0, left: offset, height: 20 }
        : { top: offset, left: 0, height: 20 }) as DOMRect;
    host.appendChild(mark);
    return mark;
  }

  it("puts a paged chapter on the page the highlight is on", async () => {
    const { metrics, offsetOf, settle } = await import("../lib/reading/position");
    const el = scroller("x");
    const body = document.createElement("div");
    el.appendChild(body);
    markAt(body, "x", 744 * 3 + 500);

    const m = metrics(el, "x");
    const at = offsetOf(el, body.firstElementChild as Element, "x");
    // The page it is on, not the least the view could move.
    expect(settle(m, "x", at, "contain")).toBe(744 * 3);
  });

  it("centres it down a scrolled one", async () => {
    const { metrics, offsetOf } = await import("../lib/reading/position");
    const el = scroller("y");
    const body = document.createElement("div");
    el.appendChild(body);
    const mark = markAt(body, "y", 2000);

    const m = metrics(el, "y");
    const at = offsetOf(el, mark, "y");
    const to = at - m.view / 2 + 20 / 2;
    // A highlight at the very top of the view reads as something already
    // passed.
    expect(to).toBe(2000 - 300 + 10);
  });

  // Vertical (古籍) reading runs across even when it is not paged — the axis
  // decision has to know that, or a scrolled vertical chapter would scroll
  // down to its highlights and never find them.
  it("scrolls the x axis to a highlight in vertical scroll mode", async () => {
    listHighlights.mockResolvedValue([
      {
        id: 3,
        bookId: 7,
        chapterIndex: 2,
        quote: "deliberately",
        prefix: "wished to live ",
        suffix: ".",
        textOffset: 47,
        color: "yellow",
        note: "",
        createdAt: "2026-08-05T00:00:00Z",
      },
    ]);
    const body = renderChapter();
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 744, configurable: true });
    Object.defineProperty(el, "scrollWidth", { value: 7440, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 6000, configurable: true });
    el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 744, width: 744 }) as DOMRect;

    const wrapper = await mountLayer(body, 7, 2, el);
    const ui = useUi(wrapper.vm.$pinia);
    ui.setReading("readerOrientation", "vertical");

    // Vertical (古籍) starts on the right. The mark sits 2000px in from the
    // start, so its right edge is 2000px left of the viewport's right. The
    // apply pass rebuilds every <mark>, so the position has to come from the
    // prototype — the new mark gets its rect the way the old one did.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.hl) {
        return { top: 0, left: 744 - 2000 - 20, right: 744 - 2000, height: 20, width: 20 } as DOMRect;
      }
      return { top: 0, left: 0, right: 744, width: 744, height: 0 } as DOMRect;
    });
    ui.pendingHighlightId = 3;
    // A body mutation schedules the apply pass that consumes the pending id,
    // the way a translation landing would.
    body.appendChild(document.createTextNode(" "));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    // Scrolled 古籍 has no page grid: land on the mark, not the nearest screenful.
    expect(el.scrollLeft).toBe(2000);
    expect(el.scrollTop).toBe(0);
    wrapper.unmount();
  });
});
