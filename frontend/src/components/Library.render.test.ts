// Render smoke tests for the two surfaces a reader actually lives in: the
// library grid and the reading view. Type-checking proves the props line up;
// these prove the templates mount, bind and branch — the class of failure that
// only shows up as a blank pane in the running app.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createI18n } from "vue-i18n";
import en from "../locales/en.json";
import type { Book, BookDetail, ChapterContent } from "../types";

/** Scroll handlers coalesce to one pass per frame; let that frame land. */
const flushRaf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const book: Book = {
  id: 1,
  title: "Walden",
  author: "Henry David Thoreau",
  language: "en",
  publisher: "Ticknor and Fields",
  format: "epub",
  fileName: "walden.epub",
  fileSize: 5505,
  collectionId: null,
  hasCover: true,
  chapterCount: 2,
  charCount: 900,
  pageCount: 0,
  addedAt: "2026-08-05 12:00:00",
  lastReadAt: "2026-08-05 13:00:00",
  isFinished: false,
  isFavorite: true,
  percent: 0.42,
  tags: [{ id: 1, name: "essays", color: "moss", position: 0, bookCount: 1 }],
};

const detail: BookDetail = {
  ...book,
  description: "Life in the woods.",
  identifier: "urn:uuid:walden",
  publishedAt: "1854",
  chapters: [
    { index: 0, title: "Economy", level: 0, href: "OEBPS/ch1.xhtml", charCount: 600 },
    { index: 1, title: "Solitude", level: 1, href: "OEBPS/ch2.xhtml", charCount: 300 },
  ],
  progress: { chapterIndex: 1, chapterRatio: 0.5, page: 1, percent: 0.42, updatedAt: "" },
};

const chapter: ChapterContent = {
  bookId: 1,
  index: 1,
  title: "Solitude",
  html: '<p>This is a delicious evening.</p><img data-res="OEBPS/img/pond.png">',
  charCount: 300,
  aiSummary: null,
};

vi.mock("../api", () => ({
  listBooks: vi.fn(async () => [book]),
  getBook: vi.fn(async () => detail),
  getChapter: vi.fn(async () => chapter),
  coverBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  resourceBytes: vi.fn(async () => new Uint8Array([4, 5, 6])),
  libraryCounts: vi.fn(async () => ({ all: 1, reading: 1, finished: 0, favorite: 1, highlights: 0 })),
  listCollections: vi.fn(async () => []),
  setBookCollection: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listHighlights: vi.fn(async () => []),
  saveProgress: vi.fn(async () => {}),
  setBookFlag: vi.fn(async () => {}),
  deleteBook: vi.fn(async () => {}),
  pickAndImport: vi.fn(async () => []),
  importBytes: vi.fn(async () => ({ fileName: "", bookId: 0, title: "", duplicate: false, error: "" })),
  searchLibrary: vi.fn(async () => []),
  getTranslation: vi.fn(async () => null),
  aiConfigured: vi.fn(async () => true),
  listBookmarks: vi.fn(async () => [
    {
      id: 5,
      bookId: 1,
      chapterIndex: 0,
      chapterRatio: 0.4,
      page: null,
      label: "the woods",
      createdAt: "2026-08-05T10:00:00Z",
    },
  ]),
  addBookmark: vi.fn(async () => 6),
  listBookHighlights: vi.fn(async () => [
    {
      id: 11,
      bookId: 1,
      chapterIndex: 0,
      quote: "I went to the woods",
      prefix: "",
      suffix: "",
      textOffset: 10,
      color: "yellow",
      note: "the reason for the whole book",
      createdAt: "2026-08-05T10:00:00Z",
      bookTitle: "Walden",
      bookAuthor: "Henry David Thoreau",
      chapterTitle: "Economy",
    },
  ]),
  deleteBookmark: vi.fn(async () => {}),
  aiTranslate: vi.fn(() => {
    const p: any = Promise.resolve();
    p.cancel = () => {};
    return p;
  }),
  setWindowBackground: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  toggleFullscreen: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
  listInstalledFonts: vi.fn(async () => []),
  aiSummarize: vi.fn(() => {
    const p: any = Promise.resolve();
    p.cancel = () => {};
    return p;
  }),
}));

// The Wails runtime is not present under jsdom; the components only use it to
// subscribe to backend events.
vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
  Browser: { OpenURL: async () => {} },
}));

const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });

// One Pinia per test, shared between the store the test drives and the
// component under test — two instances would leave the component reading a
// fresh store that the test never touched.
let pinia: ReturnType<typeof createPinia>;
// A per-test QueryClient so chapter queries answered by one test can't serve
// the next from cache (the chapter query now has staleTime, so a cached
// chapter stays fresh for 5 minutes). The tests that jump chapters
// invalidate it before the jump to simulate "load the latest".
let testClient: QueryClient;

function globals(queryClient?: QueryClient) {
  const vueQuery: [typeof VueQueryPlugin, Record<string, unknown>] = [
    VueQueryPlugin,
    queryClient ? { queryClient } : { queryClient: testClient },
  ];
  return { plugins: [pinia, vueQuery, i18n] };
}

/** jsdom has no ResizeObserver. This one records its callbacks so a test can
 *  say "the content moved" — which is when the reader re-measures headings. */
const resizeCallbacks: ResizeObserverCallback[] = [];
const resized = () => resizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

beforeEach(async () => {
  resizeCallbacks.length = 0;
  pinia = createPinia();
  setActivePinia(pinia);
  testClient = new QueryClient();
  // jsdom never fires rAF callbacks on its own; run them synchronously so
  // scroll/reflow handlers that coalesce through rAF stay deterministic.
  // The depth cap keeps a callback that re-registers itself — auto-scroll's
  // stepAuto — from recursing through this mock until the stack overflows:
  // the cap bounds one synchronous "frame" to a realistic burst of work.
  // Return 0: a nonzero id would linger in the handlers' own `scrollRaf`
  // guards and swallow the next scroll.
  let rafDepth = 0;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    if (rafDepth < 100) {
      rafDepth++;
      cb(performance.now());
      rafDepth--;
    }
    return 0;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  // The api module is mocked once for the file, so a test that redirects a
  // call (switching books, or answering a setting differently) would otherwise
  // leak that into the next one — as would its recorded calls, which several
  // tests assert on.
  vi.clearAllMocks();
  const api = await import("../api");
  (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValue([book]);
  (api.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
  (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue(chapter);
  (api.getSetting as ReturnType<typeof vi.fn>).mockImplementation(async () => null);
  // jsdom implements neither object URLs nor scrolling.
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Library", () => {
  // Virtualization measures the scroll container through offsetWidth/
  // offsetHeight (getRect) and getBoundingClientRect; jsdom reports all-zero
  // for both, which would leave the virtual window empty. Give elements
  // plausible sizes for these two tests.
  let origGetRect: typeof Element.prototype.getBoundingClientRect;
  let origOffsetWidth: PropertyDescriptor | undefined;
  let origOffsetHeight: PropertyDescriptor | undefined;
  let origClientWidth: PropertyDescriptor | undefined;
  let origClientHeight: PropertyDescriptor | undefined;
  beforeEach(() => {
    origGetRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () =>
      ({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = origGetRect;
    if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", origOffsetWidth);
    if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origOffsetHeight);
    if (origClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origClientWidth);
    if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
  });

  it("renders a card per book, with its author and progress", async () => {
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.findAll(".book-card")).toHaveLength(1);
    expect(wrapper.text()).toContain("Walden");
    expect(wrapper.text()).toContain("Henry David Thoreau");
    // 42% read, so the progress hairline is drawn at 0.42 of the cover width.
    expect(wrapper.find(".book-progress-fill").attributes("style")).toContain("scaleX(0.42)");
    // Favourite books carry their marker.
    expect(wrapper.find(".book-flag.favorite").exists()).toBe(true);
    expect(wrapper.find(".book-tag").text()).toBe("essays");
    // A card is focused without opening the reader, so arrows have somewhere to start.
    expect(wrapper.find(".book-card.selected").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the shelf total rather than the loaded page", async () => {
    const api = await import("../api");
    (api.libraryCounts as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      all: 450, reading: 12, finished: 3, favorite: 1, highlights: 0,
    });
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();
    expect(wrapper.find(".list-title .count").text()).toBe("450");
    expect(wrapper.find(".list-title .count").text()).not.toContain("+");
    wrapper.unmount();
  });

  it("renders list view as flat thumbnail rows, not poster cards", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().setViewMode("list");
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    // The list shape (thumbnail beside the title, no poster layout) hangs off
    // the virtualized container's `as-list` flag — this is the CSS contract the
    // cover-thumbnail grid in styles.css keys on.
    expect(wrapper.find(".library-grid-virtual.as-list").exists()).toBe(true);
    expect(wrapper.findAll(".library-row")).toHaveLength(1);
    expect(wrapper.findAll(".book-card")).toHaveLength(1);
    expect(wrapper.find(".library-grid-virtual.as-list .book-cover").exists()).toBe(true);
  });

  it("rebuilds rows when switching between grid and list so cards do not keep the old height", async () => {
    const api = await import("../api");
    const second: Book = { ...book, id: 2, title: "Cape Cod", isFavorite: false, percent: 0, tags: [] };
    (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([book, second]);
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.setViewMode("grid");
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.find(".library-grid-virtual.as-list").exists()).toBe(false);
    expect(wrapper.findAll(".book-card")).toHaveLength(2);
    expect(wrapper.findAll(".library-row")).toHaveLength(1);
    expect(wrapper.find(".library-row").attributes("style") ?? "").toMatch(/repeat\(/);

    ui.setViewMode("list");
    await flushPromises();
    expect(wrapper.find(".library-grid-virtual.as-list").exists()).toBe(true);
    expect(wrapper.findAll(".library-row")).toHaveLength(2);
    expect(wrapper.findAll(".book-card")).toHaveLength(2);
    expect(wrapper.find(".library-row").attributes("style") ?? "").toMatch(/1fr/);
    expect(wrapper.find(".library-row").attributes("style") ?? "").not.toMatch(/repeat\(/);

    ui.setViewMode("grid");
    await flushPromises();
    expect(wrapper.find(".library-grid-virtual.as-list").exists()).toBe(false);
    expect(wrapper.findAll(".library-row")).toHaveLength(1);
    expect(wrapper.findAll(".book-card")).toHaveLength(2);
    wrapper.unmount();
  });

  it("shows the empty state when the library has no books", async () => {
    const api = await import("../api");
    (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.find(".empty").exists()).toBe(true);
    expect(wrapper.text()).toContain(en.library.emptyTitle);
  });

  it("uses shelf-specific empty copy for favorites", async () => {
    const api = await import("../api");
    (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const { useUi } = await import("../stores/ui");
    useUi().select({ kind: "favorite" }, en.smart.favorite);
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.find(".empty").text()).toContain(en.library.emptyFavorites);
    expect(wrapper.find(".empty").text()).toContain(en.library.emptyFavoritesHint);
    expect(wrapper.find(".empty").text()).not.toContain(en.library.addBooks);
    wrapper.unmount();
  });

  it("uses tag-specific empty copy rather than a wiped library", async () => {
    const api = await import("../api");
    (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const { useUi } = await import("../stores/ui");
    useUi().select({ kind: "tag", value: 9 }, "essays");
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.find(".empty").text()).toContain(en.library.emptyTag);
    expect(wrapper.find(".empty").text()).toContain(en.library.emptyTagHint);
    expect(wrapper.find(".empty").text()).not.toContain(en.library.addBooks);
    wrapper.unmount();
  });

  it("moves focus with Home/End and deletes the focused card", async () => {
    const api = await import("../api");
    const second: Book = { ...book, id: 2, title: "Civil Disobedience", isFavorite: false, percent: 0, tags: [] };
    const third: Book = { ...book, id: 3, title: "Cape Cod", isFavorite: false, percent: 0, tags: [] };
    (api.listBooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([book, second, third]);
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    expect(wrapper.findAll(".book-card")).toHaveLength(3);
    expect(wrapper.findAll(".book-card.selected")).toHaveLength(1);
    expect(wrapper.findAll(".book-card.selected")[0].text()).toContain("Walden");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    await flushPromises();
    expect(wrapper.find(".book-card.selected").text()).toContain("Cape Cod");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    await flushPromises();
    expect(wrapper.find(".book-card.selected").text()).toContain("Walden");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    await flushPromises();
    const { useToasts } = await import("../stores/toasts");
    expect(useToasts().current?.text).toContain("Walden");
    wrapper.unmount();
  });

  it("does not delete a book while a dialog is open", async () => {
    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";
    document.body.appendChild(backdrop);
    const Library = (await import("./Library.vue")).default;
    const wrapper = mount(Library, { global: globals() });
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    await flushPromises();
    const { useToasts } = await import("../stores/toasts");
    expect(useToasts().current).toBeNull();
    backdrop.remove();
    wrapper.unmount();
  });
});

describe("Reader", () => {
  it("opens at the saved chapter and renders its body", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // The saved position is chapter 1, not the first chapter.
    expect(wrapper.find(".article-title").text()).toBe("Solitude");
    expect(wrapper.find(".article-body").html()).toContain("delicious evening");
    expect(wrapper.text()).toContain("Chapter 2 of 2");

    // The chapter's image is resolved from stored book resources rather than
    // left pointing at a path the webview cannot fetch.
    const api = await import("../api");
    expect(api.resourceBytes).toHaveBeenCalledWith(1, "OEBPS/img/pond.png");
    expect(wrapper.find(".article-body img").attributes("src")).toBe("blob:mock");

    // Chapter navigation reflects where in the book we are.
    const navButtons = wrapper.findAll(".chapter-nav-btn");
    expect(navButtons).toHaveLength(2);
    expect(navButtons[0].attributes("disabled")).toBeUndefined(); // has a previous
    expect(navButtons[1].attributes("disabled")).toBeDefined(); // last chapter
    wrapper.unmount();
  });

  // Reopening a book serves its detail straight from the query cache, so the
  // book is already there during setup rather than arriving a tick later. That
  // path used to throw "Cannot access 'restoreRatio' before initialization":
  // the immediate watcher that seeds the reading position ran while the `let`
  // it assigns was still in its temporal dead zone.
  it("opens a book whose detail is already cached", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const queryClient = new QueryClient();
    queryClient.setQueryData(["book", 1], detail);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(queryClient), attachTo: document.body });
    await flushPromises();

    expect(wrapper.find(".article-title").text()).toBe("Solitude");
    wrapper.unmount();
  });

  // Switching books without closing the reader — a ⌘K hit, an AI citation —
  // has to carry the chapter index over to the new book's saved position, not
  // leave it pointing into the book that was open before.
  it("follows a switch to another book", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    expect(wrapper.find(".article-title").text()).toBe("Solitude");

    const api = await import("../api");
    const other: BookDetail = {
      ...detail,
      id: 2,
      title: "Moby-Dick",
      chapterCount: 1,
      chapters: [{ index: 0, title: "Loomings", level: 0, href: null, charCount: 500 }],
      progress: { chapterIndex: 0, chapterRatio: 0, page: 1, percent: 0, updatedAt: "" },
    };
    (api.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(other);
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      bookId: 2,
      index: 0,
      title: "Loomings",
      html: "<p>Call me Ishmael.</p>",
    });

    ui.openBook(2);
    await flushPromises();
    await flushPromises();

    expect(wrapper.find(".article-title").text()).toBe("Loomings");
    expect(wrapper.text()).toContain("Chapter 1 of 1");
    // The one-chapter book has nowhere to go in either direction.
    const nav = wrapper.findAll(".chapter-nav-btn");
    expect(nav[0].attributes("disabled")).toBeDefined();
    expect(nav[1].attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  // Translation is reached from the reader, applies to the chapter on screen,
  // and leaves the original one click away.
  it("translates the chapter it is showing", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    expect(wrapper.find(".article-body").html()).toContain("delicious evening");

    await wrapper.get('button[aria-label="Translate chapter (T)"]').trigger("click");
    await flushPromises();

    // It asks the backend for this book, this chapter — not the book as a whole.
    const api = await import("../api");
    const call = (api.aiTranslate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(1); // book
    expect(call[1]).toBe(1); // the chapter on screen

    // Feeding the stream a batch puts the translation on the page, and the
    // original is still one click away. The batch arrives the way the backend
    // sends it now: whole blocks as they are written, then a final event
    // with no html of its own.
    const onEvent = call[4] as (e: unknown) => void;
    onEvent({ type: "start", data: { total: 1, title: "孤独" } });
    onEvent({ type: "batch", data: { html: "<p>今夜甚美。</p>" } });
    onEvent({ type: "batch", data: { done: 1 } });
    await flushPromises();

    expect(wrapper.find(".article-body").html()).toContain("今夜甚美");
    expect(wrapper.find(".article-title").text()).toBe("孤独");

    await wrapper.get('button[aria-label="Translate chapter (T)"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".article-body").html()).toContain("delicious evening");
    wrapper.unmount();
  });

  // The LLM engine needs a provider, and whether one is configured is the
  // backend's answer — this warning used to be driven by one raw setting the
  // Settings screen had stopped writing, so it fired at users who had just
  // configured a provider and worked fine everywhere else.
  it("warns that the LLM engine needs a provider only when none is configured", async () => {
    const api = await import("../api");
    const configured = api.aiConfigured as ReturnType<typeof vi.fn>;
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const open = async () => {
      const w = mount(Reader, { global: globals(), attachTo: document.body });
      await flushPromises();
      await w.get(".tb-trans-caret").trigger("click");
      await flushPromises();
      return w;
    };

    let wrapper = await open();
    expect(wrapper.find(".tr-pop").exists()).toBe(true);
    expect(wrapper.find(".tr-pop-warn").exists()).toBe(false);
    wrapper.unmount();

    configured.mockResolvedValue(false);
    // aiReady is staleTime'd (30s); the first open cached it, so invalidate
    // before re-opening to make the new mock value take effect.
    testClient.invalidateQueries({ queryKey: ["ai", "configured"] });
    await flushPromises();
    wrapper = await open();
    expect(wrapper.find(".tr-pop-warn").exists()).toBe(true);
    wrapper.unmount();
    configured.mockResolvedValue(true);
  });

  // Translation used to switch itself off at every page turn: someone reading a
  // book in translation re-armed it, and re-waited for it, chapter after
  // chapter.
  it("keeps translating after the page is turned", async () => {
    const api = await import("../api");
    const translate = api.aiTranslate as ReturnType<typeof vi.fn>;
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    await wrapper.get('button[aria-label="Translate chapter (T)"]').trigger("click");
    await flushPromises();
    expect(translate.mock.calls.map((c) => c[1])).toContain(1); // this chapter

    // Back a chapter: the mode is still on, and the new chapter starts.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();
    expect(translate.mock.calls.map((c) => c[1])).toContain(0);
    wrapper.unmount();
  });

  // The model writes at the speed it writes; the way to not wait for it is to
  // have the next chapter already done by the time the page turns.
  it("translates the next chapter in the background while this one is read", async () => {
    const api = await import("../api");
    const translate = api.aiTranslate as ReturnType<typeof vi.fn>;
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // Start on the first chapter, so there is a next one to run ahead to.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();
    await wrapper.get('button[aria-label="Translate chapter (T)"]').trigger("click");
    await flushPromises();

    // Nothing is prefetched until this chapter has something on screen.
    expect(translate.mock.calls.map((c) => c[1])).not.toContain(1);

    const call = translate.mock.calls.find((c) => c[1] === 0)!;
    const onEvent = call[4] as (e: unknown) => void;
    onEvent({ type: "start", data: { total: 1, title: "经济" } });
    onEvent({ type: "batch", data: { html: "<p>今夜甚美。</p>", done: 1 } });
    await flushPromises();
    await flushPromises();

    expect(translate.mock.calls.map((c) => c[1])).toContain(1);
    wrapper.unmount();
  });

  // The auto-translate switch in Settings wrote a setting nothing read.
  it("translates on open when auto-translate is on", async () => {
    const api = await import("../api");
    const translate = api.aiTranslate as ReturnType<typeof vi.fn>;
    (api.getSetting as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) =>
      k === "translate_auto" ? "1" : null,
    );
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // No click on anything: the chapter is already being translated.
    expect(translate).toHaveBeenCalled();
    expect(wrapper.find(".tb-trans-main").classes()).toContain("on");
    wrapper.unmount();
  });

  // A "chapter" is whatever the book calls one, and in this library that is
  // routinely a whole part with dozens of headings inside it. The contents
  // stopped at the part, leaving the reader a wall of text.
  it("lists the headings inside the chapter being read", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html:
        "<h2>自序</h2><p>a</p><h2>一 绪论</h2><p>b</p><h3>其一</h3><p>c</p><h2>二 厚黑学</h2><p>d</p>",
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();

    const outline = wrapper.findAll(".toc-section").map((s) => s.text());
    expect(outline).toEqual(["自序", "一 绪论", "其一", "二 厚黑学"]);

    // They hang under the chapter being read, indented past it.
    const rows = wrapper.findAll(".toc-item");
    const chapterRow = rows.find((r) => r.classes().includes("current") && !r.classes().includes("toc-section"))!;
    const padOf = (el: (typeof rows)[number]) =>
      parseInt((el.attributes("style") ?? "").replace(/.*padding-left:\s*(\d+)px.*/, "$1"), 10);
    expect(padOf(wrapper.findAll(".toc-section")[0])).toBeGreaterThan(padOf(chapterRow));
    wrapper.unmount();
  });

  // Which section you are in is the answer to "where am I" in a chapter that is
  // forty pages long, so it is tracked as you scroll and shown in both places.
  it("follows the section being read", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html: "<h2>自序</h2><p>a</p><h2>一 绪论</h2><p>b</p><h2>二 厚黑学</h2><p>c</p>",
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // jsdom measures nothing, so the geometry is supplied: the container's top
    // is at 0 with the page scrolled to 0, and the headings sit at 0/900/1800.
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    el.getBoundingClientRect = (() => ({ top: 0 })) as unknown as HTMLElement["getBoundingClientRect"];
    const heads = wrapper.get(".article-body").element.querySelectorAll("h2");
    [0, 900, 1800].forEach((top, i) => {
      (heads[i] as HTMLElement).getBoundingClientRect = (() => ({
        top: top - el.scrollTop,
      })) as unknown as HTMLElement["getBoundingClientRect"];
    });
    // The chapter was measured before that geometry existed, which is exactly
    // what happens in the app when images finish loading and move everything.
    // The body's resize observer is what says "measure again".
    resized();

    const sectionInMeta = () => wrapper.find(".art-section").text();

    el.scrollTop = 1000;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();
    expect(sectionInMeta()).toBe("一 绪论");

    el.scrollTop = 1850;
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();
    expect(sectionInMeta()).toBe("二 厚黑学");

    // And the outline marks the same one.
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    const marked = wrapper.findAll(".toc-section.current");
    expect(marked).toHaveLength(1);
    expect(marked[0].text()).toBe("二 厚黑学");
    wrapper.unmount();
  });

  // Only the chapter on screen opens up, and only when it has sections worth
  // listing: a single heading is the chapter's own title repeated.
  it("shows no outline for a chapter with one heading", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html: "<h2>Solitude</h2><p>This is a delicious evening.</p>",
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();
    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".toc-section")).toHaveLength(0);
    wrapper.unmount();
  });

  // Space is the key people read with. The scroller is a div, so the browser
  // only pages it when it happens to hold focus — which, after a click on the
  // toolbar or nothing at all, it does not.
  it("pages with the space bar, and turns the page at the end of a chapter", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // Start on the first chapter, so there is one to turn to.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();

    // jsdom has no layout, so the scroller is given some.
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    el.scrollTop = 500;

    const press = async (init: KeyboardEventInit) => {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
      await flushPromises();
    };

    // Where the reader ends up, not which method took them there: the reader
    // asks a position layer to move now, and how it moves is that layer's
    // business.
    await press({ key: " " });
    const down = el.scrollTop - 500;
    // A screenful, less a couple of lines of overlap so the eye has a landing.
    expect(down).toBeGreaterThan(400);
    expect(down).toBeLessThan(600);

    await press({ key: " ", shiftKey: true });
    expect(el.scrollTop).toBeCloseTo(500, 6);

    // PageDown is the same gesture.
    await press({ key: "PageDown" });
    expect(el.scrollTop).toBeCloseTo(500 + down, 6);

    // At the bottom of the chapter, paging on turns the page rather than
    // stopping dead.
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockClear();
    // The chapter query is staleTime'd; force a refetch so the turn loads the
    // next chapter through the api rather than the 5-minute-fresh cache.
    testClient.invalidateQueries({ queryKey: ["chapter"] });
    await flushPromises();
    el.scrollTop = 1400;

    await press({ key: " " });
    expect(el.scrollTop).toBeCloseTo(1400, 6);
    expect(api.getChapter).toHaveBeenCalledWith(1, 1);
    wrapper.unmount();
  });

  // Reading backwards over a chapter boundary lands at the end of the previous
  // chapter, which is where you were reading.
  it("pages back into the end of the previous chapter", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    const api = await import("../api");
    (api.saveProgress as ReturnType<typeof vi.fn>).mockClear();
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    el.scrollBy = vi.fn() as unknown as HTMLElement["scrollBy"];
    el.scrollTop = 0;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    await flushPromises();

    // Chapter 0, at its end.
    expect(api.saveProgress).toHaveBeenCalledWith(1, 0, 1, 1);
    wrapper.unmount();
  });

  // The panel is where typography is judged — over the page it changes — so
  // every control in it has to be wired to the page, not just to the store.
  it("changes the page from the typography panel", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();

    const group = (label: string) =>
      wrapper.findAll(".rs-row").find((r) => r.find(".rs-label").text() === label)!;
    /** A tab shows its own settings and does not render the others at all. */
    const shows = (label: string) => group(label) !== undefined;
    /** Numbers are sliders now — set the value directly. */
    const setSlider = async (label: string, value: number) => {
      await group(label).find("input[type='range']").setValue(String(value));
      await flushPromises();
    };

    // The panel is three short pages, not one column: the control you came for
    // is a tab away rather than a scroll away.
    const tabs = wrapper.findAll(".rp-tabs button").map((b) => b.text());
    expect(tabs).toEqual(["Type", "Layout", "Page", "Turning", "Screen"]);
    const openTab = async (name: string) => {
      await wrapper.findAll(".rp-tabs button").find((b) => b.text() === name)!.trigger("click");
      await flushPromises();
    };
    // Layout's controls are not on the text page, and vice versa.
    expect(shows("Letter spacing")).toBe(true);
    expect(shows("Margins")).toBe(false);
    await openTab("Layout");
    expect(shows("Margins")).toBe(true);
    expect(shows("Letter spacing")).toBe(false);
    await openTab("Type");

    await setSlider("Letter spacing", 4);
    expect(ui.readerTracking).toBe(4);
    await openTab("Layout");
    await setSlider("Paragraph spacing", 32);
    expect(ui.readerParaGap).toBe(32);
    // Justified is a switch now, not two words to choose between: it is on or
    // it is not.
    await group("Justify").get("input").setValue(true);
    await flushPromises();
    expect(ui.readerJustify).toBe(true);

    // Both margins move together from the panel: "page margin" is one thing to
    // a reader, and a sheet with wide sides and a tight head looks like a bug.
    await setSlider("Margins", 88);
    expect(ui.readerPadX).toBe(88);
    expect(ui.readerPadY).toBeGreaterThan(52);

    // The page's own colour, which is not the app's theme.
    await openTab("Page");
    const sepia = group("Page colour").findAll("button")[1];
    await sepia.trigger("click");
    await flushPromises();
    expect(ui.readerPaper).toBe("sepia");
    expect(ui.theme).not.toBe("sepia");

    // Reset puts all of it back, including the parts the panel does not show.
    ui.setReader({ readerWarmth: 40 });
    await wrapper.get(".rp-reset").trigger("click");
    await flushPromises();
    expect(ui.readerTracking).toBe(0);
    expect(ui.readerParaGap).toBe(18);
    expect(ui.readerPadX).toBe(52);
    expect(ui.readerWarmth).toBe(0);
    expect(ui.readerPaper).toBe("theme");
    expect(ui.readerJustify).toBe(false);
    wrapper.unmount();
  });

  // Reading without a hand on the keyboard, and stopping the moment the reader
  // touches the page themselves — two things scrolling at once is a fight.
  it("scrolls by itself, carries into the next chapter, and yields to the reader", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click"); // chapter 0, so there is a next
    await flushPromises();

    // Drive the animation frames by hand.
    let frame: FrameRequestCallback | null = null;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frame = cb;
      return 1;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});

    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    el.scrollTop = 0;

    await wrapper.get('button[aria-label="Auto-scroll (S)"]').trigger("click");
    await flushPromises();
    expect(raf).toHaveBeenCalled();

    // The first frame only starts the clock; after that the page moves by the
    // speed times the time that passed.
    frame!(0);
    frame!(100);
    expect(el.scrollTop).toBe(Math.floor(ui.readerAutoSpeed * 0.1));

    // A second of frames adds up to a second of reading — the sub-pixel carry
    // matters here, since at this speed a frame is a fraction of a pixel and
    // scrollTop is an integer.
    for (let i = 2; i <= 10; i++) frame!(i * 100);
    expect(el.scrollTop).toBeGreaterThanOrEqual(ui.readerAutoSpeed - 1);

    // A frame after a long pause (the window was elsewhere) must not teleport
    // the page down the chapter.
    const before = el.scrollTop;
    frame!(60_000);
    expect(el.scrollTop - before).toBeLessThan(ui.readerAutoSpeed);

    // The page cannot move — the chapter is done — so it turns to the next one.
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockClear();
    testClient.invalidateQueries({ queryKey: ["chapter"] });
    await flushPromises();
    // A scroll container at its maximum: assigning does nothing and reading
    // gives back the clamped value, which is how the browser behaves.
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => 999, set: () => {} });
    frame!(60_100);
    await flushPromises();
    expect(api.getChapter).toHaveBeenCalledWith(1, 1);

    // Further frames while the next chapter is still loading must not keep
    // calling goTo — with three or more chapters that used to skip through
    // the book as fast as the animation frames fired.
    (api.getChapter as ReturnType<typeof vi.fn>).mockClear();
    frame!(60_200);
    frame!(60_300);
    frame!(60_400);
    await flushPromises();
    expect(api.getChapter).not.toHaveBeenCalled();

    // And the reader touching the page stops it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await flushPromises();
    expect(wrapper.get('button[aria-label="Auto-scroll (S)"]').classes()).not.toContain("on");
    raf.mockRestore();
    wrapper.unmount();
  });

  // Clicking the text is how a selection starts, so paging by click is opt-in.
  it("turns the page from the edges only when asked to", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    const scroller = wrapper.get(".reader-scroll");
    const el = scroller.element as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    el.scrollTop = 500;
    el.getBoundingClientRect = (() => ({ left: 0, width: 1000, top: 0 })) as unknown as HTMLElement["getBoundingClientRect"];

    // Where the reader ends up, not which method took them there.
    const at = () => el.scrollTop;

    // Off: a click in the text does nothing but start a selection.
    await scroller.trigger("click", { clientX: 950 });
    expect(at()).toBe(500);

    ui.setReaderClickPaging(true);
    await scroller.trigger("click", { clientX: 950 });
    expect(at()).toBeGreaterThan(500);
    const forward = at();
    await scroller.trigger("click", { clientX: 50 });
    expect(at()).toBeLessThan(forward);

    // The middle is still just the page.
    el.scrollTop = 500;
    await scroller.trigger("click", { clientX: 500 });
    expect(at()).toBe(500);

    // A click that is putting something away is not a click for turning the
    // page: reaching out to close the typography panel would otherwise page
    // the book under it.
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();
    await scroller.trigger("click", { clientX: 950 });
    expect(at()).toBe(500);
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();

    // Same for a highlight's popover, which belongs to the layer over the text
    // rather than to the reader.
    const pop = document.createElement("div");
    pop.className = "hl-popover";
    document.body.appendChild(pop);
    await scroller.trigger("click", { clientX: 950 });
    expect(at()).toBe(500);
    pop.remove();

    // With all of it away, the edge pages again.
    await scroller.trigger("click", { clientX: 950 });
    expect(at()).toBeGreaterThan(500);
    wrapper.unmount();
  });

  // The three ways people read, as one press each.
  it("switches the whole reading surface with a preset", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();

    // The presets live with the page they set, which is a tab away.
    await wrapper.findAll(".rp-tabs button").find((b) => b.text() === "Page")!.trigger("click");
    await flushPromises();
    const presets = wrapper.get(".rp-preset-row");
    await presets.findAll("button")[1].trigger("click"); // Comfort
    await flushPromises();
    expect(ui.theme).toBe("light");
    expect(ui.readerPaper).toBe("sepia");
    expect(ui.readerWarmth).toBeGreaterThan(0);

    await presets.findAll("button")[2].trigger("click"); // Night
    await flushPromises();
    expect(ui.theme).toBe("dark");
    expect(ui.readerPaper).toBe("gray");
    expect(ui.readerWarmth).toBe(0);
    wrapper.unmount();
  });

  // Opening a book that keeps its own settings must apply them before the page
  // is drawn: a frame late and the reader watches the type resize under them.
  it("applies a book's own reading settings as it opens, and puts them back on close", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.setReader({ readerSize: 16 });
    // Book 1 keeps its own, larger, type.
    ui.setPerBook(1, true);
    ui.setReader({ readerSize: 21 });
    ui.useBookProfile(null);
    expect(ui.readerSize).toBe(16);

    ui.openBook(1);
    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    // No awaits: the settings must already be in place, not applied after the
    // book detail arrives.
    expect(ui.readerSize).toBe(21);
    expect(ui.perBook).toBe(true);

    await flushPromises();
    // The panel says whose settings these are.
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();
    expect((wrapper.get(".rp-perbook input").element as HTMLInputElement).checked).toBe(true);

    wrapper.unmount();
    expect(ui.perBook).toBe(false);
    expect(ui.readerSize).toBe(16);
  });

  // Most of a book's links are footnote markers, and a marker without its
  // fragment is a link to nothing — which is what they were.
  it("follows a footnote marker to the note, and back again", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html:
        '<p>正文<a data-link="#fn1" id="ref1">[1]</a>后面还有很多字。</p>' +
        '<p id="fn1">注释一：这里是注文。</p>',
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    el.getBoundingClientRect = (() => ({ top: 0 })) as unknown as HTMLElement["getBoundingClientRect"];
    const note = wrapper.get(".article-body #fn1").element as HTMLElement;
    note.getBoundingClientRect = (() => ({ top: 900 })) as unknown as HTMLElement["getBoundingClientRect"];
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    el.scrollTop = 300;

    // No way back is offered until a link has actually been followed.
    expect(wrapper.find(".link-back").exists()).toBe(false);

    await wrapper.get('a[data-link="#fn1"]').trigger("click");
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect((scrollTo.mock.calls[0][0] as { top: number }).top).toBeGreaterThan(800);

    // And back to the sentence the marker was in.
    const back = wrapper.get(".link-back");
    await back.trigger("click");
    await flushPromises();
    // 300 of a 1400 scrollable range is where the reader was.
    expect((scrollTo.mock.calls[1][0] as { top: number }).top).toBeCloseTo(300, 0);
    expect(wrapper.find(".link-back").exists()).toBe(false);
    wrapper.unmount();
  });

  // A link to a fragment that is not in the chapter must not offer a way back
  // from a jump that never happened.
  it("ignores a link whose target is not there", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html: '<p><a data-link="#nope">[1]</a>正文</p>',
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    el.scrollTo = vi.fn() as unknown as HTMLElement["scrollTo"];

    await wrapper.get('a[data-link="#nope"]').trigger("click");
    await flushPromises();
    expect(el.scrollTo).not.toHaveBeenCalled();
    expect(wrapper.find(".link-back").exists()).toBe(false);
    wrapper.unmount();
  });

  // A note that lives in another chapter: open it, then land on the note
  // rather than at the top of it.
  it("follows a link into another chapter and lands on the note", async () => {
    const api = await import("../api");
    const getChapter = api.getChapter as ReturnType<typeof vi.fn>;
    getChapter.mockImplementation(async (_b: number, index: number) =>
      index === 0
        ? { ...chapter, index: 0, title: "Economy", html: '<p>正文<a data-link="OEBPS/ch2.xhtml#fn9">[9]</a>。</p>' }
        : { ...chapter, index: 1, title: "Solitude", html: '<p>前面</p><p id="fn9">注释九。</p>' },
    );
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click"); // chapter 0
    await flushPromises();

    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    el.getBoundingClientRect = (() => ({ top: 0 })) as unknown as HTMLElement["getBoundingClientRect"];

    await wrapper.get('a[data-link="OEBPS/ch2.xhtml#fn9"]').trigger("click");
    await flushPromises();
    await flushPromises();

    // Chapter 1 — whose href is OEBPS/ch2.xhtml in the fixture — is open, and
    // the note in it was scrolled to.
    expect(wrapper.find(".article-title").text()).toBe("Solitude");
    expect(scrollTo).toHaveBeenCalled();
    expect(wrapper.find(".link-back").exists()).toBe(true);
    wrapper.unmount();
  });

  // Five preset papers is five; a reader who wants their own gets to pick it,
  // and only picks the ground — the ink follows so no choice is unreadable.
  it("takes a page colour of the reader's own", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await wrapper.get('button[aria-label="Typography"]').trigger("click");
    await flushPromises();
    await wrapper.findAll(".rp-tabs button").find((b) => b.text() === "Page")!.trigger("click");
    await flushPromises();

    const well = wrapper.get(".rs-swatch-custom input");
    (well.element as HTMLInputElement).value = "#101418";
    await well.trigger("input");
    await flushPromises();

    // Picking a colour is choosing it: no separate "custom" button to press.
    expect(ui.readerPaperCustom).toBe("#101418");
    expect(ui.readerPaper).toBe("custom");

    // And switching to a preset keeps the pick for next time.
    ui.setReaderPaper("sepia");
    expect(ui.readerPaperCustom).toBe("#101418");
    wrapper.unmount();
  });

  // Reading aloud starts from the line on screen, and takes the page from
  // whatever else was moving it.
  it("starts reading aloud where the reader is, and stops the auto-scroll", async () => {
    const spoken: string[] = [];
    class Utter {
      text: string;
      rate = 1;
      voice: unknown = null;
      lang = "";
      onend: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    type Utterance = { text: string; onend?: ((e: Event) => void) | null };
    let lastUtterance: Utterance | null = null;
    Object.assign(globalThis, {
      speechSynthesis: {
        speak: (u: Utterance) => {
          spoken.push(u.text);
          lastUtterance = u;
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        getVoices: () => [],
        addEventListener: () => {},
      },
      SpeechSynthesisUtterance: Utter,
    });

    const api = await import("../api");
    // A chapter that already carries one of the reader's own highlights: the
    // voice must read it, not step over it.
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html: '<p>第一句。<mark data-hl="1">第二句。</mark></p><p>第三句。第四句。</p>',
    });
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    el.scrollBy = vi.fn() as unknown as HTMLElement["scrollBy"];
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });

    // Auto-scroll running, then the voice is asked for.
    await wrapper.get('button[aria-label="Auto-scroll (S)"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('button[aria-label="Pause auto-scroll (S)"]').classes()).toContain("on");

    await wrapper.get('button[aria-label="Read aloud (R)"]').trigger("click");
    await flushPromises();

    // It is reading, from the first sentence (jsdom has no layout, so the
    // fallback estimate puts it at the top), and the page has stopped moving
    // by itself.
    expect(spoken).toEqual(["第一句。"]);
    expect(wrapper.get('button[aria-label="Auto-scroll (S)"]').classes()).not.toContain("on");

    // Sentence at a time, while it reads.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "]" }));
    await flushPromises();
    expect(spoken.at(-1)).toBe("第二句。");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
    await flushPromises();
    expect(spoken.at(-1)).toBe("第一句。");

    // And starting the auto-scroll takes the page back from the voice, the
    // same way the voice took it from the auto-scroll.
    await wrapper.get('button[aria-label="Auto-scroll (S)"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('button[aria-label="Read aloud (R)"]').classes()).not.toContain("on");
    expect(wrapper.get('button[aria-label="Pause auto-scroll (S)"]').classes()).toContain("on");
    await wrapper.get('button[aria-label="Pause auto-scroll (S)"]').trigger("click");
    await flushPromises();

    // Reading again picks up from the top, and the highlighted sentence is
    // spoken rather than skipped.
    await wrapper.get('button[aria-label="Read aloud (R)"]').trigger("click");
    await flushPromises();
    (lastUtterance as Utterance | null)?.onend?.(new Event("end"));
    await flushPromises();
    // The highlighted sentence follows the first one, spoken rather than
    // stepped over.
    expect(spoken.slice(-2)).toEqual(["第一句。", "第二句。"]);
    wrapper.unmount();
  });

  // Bilingual view holds every sentence twice. The voice must not read both.
  it("reads only one side of a bilingual page aloud", async () => {
    const spoken: string[] = [];
    class Utter {
      text: string;
      rate = 1;
      voice: unknown = null;
      lang = "";
      onend: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.assign(globalThis, {
      speechSynthesis: {
        speak: (u: { text: string }) => {
          spoken.push(u.text);
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        getVoices: () => [],
        addEventListener: () => {},
      },
      SpeechSynthesisUtterance: Utter,
    });

    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chapter,
      html: "<p>原文一句。</p>",
    });
    (api.getTranslation as ReturnType<typeof vi.fn>).mockResolvedValue({
      html: "<p>A translated sentence.</p>",
      title: "Solitude",
      engine: "llm",
      lang: "en",
    });

    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // Open the translation options and pick bilingual. A finished translation
    // is already in the cache, so the page interleaves immediately.
    await wrapper.get('button[aria-label="Translation options"]').trigger("click");
    await flushPromises();
    const bilingualBtn = wrapper
      .findAll(".tr-pop-modes button")
      .find((b) => b.text() === "Bilingual");
    expect(bilingualBtn).toBeTruthy();
    await bilingualBtn!.trigger("click");
    await flushPromises();

    const bodyHtml = wrapper.get(".article-body").element.innerHTML;
    expect(bodyHtml).toContain("bi-tr");
    expect(bodyHtml).toContain("原文一句");
    expect(bodyHtml).toContain("A translated sentence");

    await wrapper.get('button[aria-label="Read aloud (R)"]').trigger("click");
    await flushPromises();

    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.some((s) => s.includes("原文"))).toBe(true);
    expect(spoken.some((s) => /translated|A translated/i.test(s))).toBe(false);
    wrapper.unmount();
  });

  // The voice finishes a chapter and keeps going — a book does not stop at a
  // chapter boundary, and neither should listening to one.
  it("carries reading aloud into the next chapter", async () => {
    const spoken: string[] = [];
    class Utter {
      text: string;
      rate = 1;
      voice: unknown = null;
      lang = "";
      onend: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    type Utterance = { text: string; onend?: ((e: Event) => void) | null };
    let lastUtterance: Utterance | null = null;
    Object.assign(globalThis, {
      speechSynthesis: {
        speak: (u: Utterance) => {
          spoken.push(u.text);
          lastUtterance = u;
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        getVoices: () => [],
        addEventListener: () => {},
      },
      SpeechSynthesisUtterance: Utter,
    });

    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockImplementation(async (_id: number, index: number) => {
      if (index === 0) {
        return { bookId: 1, index: 0, title: "Economy", html: "<p>章末一句。</p>", charCount: 4, aiSummary: null };
      }
      return { bookId: 1, index: 1, title: "Solitude", html: "<p>下一章的第一句。</p>", charCount: 8, aiSummary: null };
    });

    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    // Start on chapter 0 so there is a next one. The nav's first button is
    // "previous chapter"; the chapter on screen opens at the saved position
    // (index 1), so go back once.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.get(".article-title").text()).toBe("Economy");

    await wrapper.get('button[aria-label="Read aloud (R)"]').trigger("click");
    await flushPromises();
    expect(spoken.at(-1)).toBe("章末一句。");

    // Natural end of the queue — the only sentence of the chapter.
    (lastUtterance as Utterance | null)?.onend?.(new Event("end"));
    await flushPromises();
    await flushPromises();

    expect(spoken.at(-1)).toBe("下一章的第一句。");
    expect(wrapper.get(".article-title").text()).toBe("Solitude");
    wrapper.unmount();
  });

  // A bookmark that cannot be found again is not a bookmark. They live in the
  // same sheet as the contents, because both answer "where can I go".
  it("lists bookmarks beside the contents, and returns to one", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();

    const tabs = wrapper.findAll(".toc-tabs button");
    await tabs[1].trigger("click");
    await flushPromises();

    const mark = wrapper.get(".toc-mark");
    expect(mark.text()).toContain("the woods");
    // It says which chapter it sits in, so a label like "the woods" is placeable.
    expect(mark.text()).toContain("Economy");

    // Following it opens that chapter at the position it was made at, not its top.
    // The chapter query is staleTime'd; invalidate so the jump loads through
    // the api instead of the fresh cache.
    testClient.invalidateQueries({ queryKey: ["chapter"] });
    await flushPromises();
    await mark.get(".toc-mark-go").trigger("click");
    await flushPromises();
    const api = await import("../api");
    expect(api.saveProgress).toHaveBeenCalledWith(1, 0, 0.4, 1);
    // …and it is chapter 0 that gets loaded, not the one that was open.
    expect(api.getChapter).toHaveBeenLastCalledWith(1, 0);
    wrapper.unmount();
  });

  // Reviewing what you marked should not mean leaving the book.
  it("lists this book's highlights and jumps to one", async () => {
    const { useUi } = await import("../stores/ui");
    const ui = useUi();
    ui.openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();
    await wrapper.findAll(".toc-tabs button")[2].trigger("click");
    await flushPromises();

    const note = wrapper.get(".toc-note");
    expect(note.text()).toContain("I went to the woods");
    // The reader's own words about the passage, and where it sits.
    expect(note.text()).toContain("the reason for the whole book");
    expect(note.text()).toContain("Economy");

    // The chapter query is staleTime'd; invalidate so the jump loads through
    // the api instead of the fresh cache.
    testClient.invalidateQueries({ queryKey: ["chapter"] });
    await flushPromises();
    await note.trigger("click");
    await flushPromises();

    // The chapter it lives in is loaded, and the id is left for the highlight
    // layer to scroll to once the marks are back on the page.
    const api = await import("../api");
    expect(api.getChapter).toHaveBeenLastCalledWith(1, 0);
    expect(ui.pendingHighlightId).toBe(11);
    wrapper.unmount();
  });

  it("opens the table of contents with every chapter", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    await wrapper.get('button[aria-label="Contents"]').trigger("click");
    await flushPromises();

    const items = wrapper.findAll(".toc-item");
    expect(items.map((i) => i.get(".toc-item-title").text())).toEqual(["Economy", "Solitude"]);
    // The chapter being read is marked, and a nested TOC entry keeps its depth
    // (12px base + one 14px level).
    expect(wrapper.find(".toc-item.current").text()).toContain("Solitude");
    expect(items[1].attributes("style")).toContain("padding-left: 26px");
    wrapper.unmount();
  });

  // Esc with the summary open used to close the whole book — the summary was
  // missing from the dismiss chain.
  it("closes the summary with Escape before closing the book", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    // ChapterSummary is async-loaded; wait for the dynamic import + mount.
    await vi.waitFor(() => {
      expect(wrapper.find(".chapter-summary").exists()).toBe(true);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find(".chapter-summary").exists()).toBe(false);
    // The book is still open — Esc closed the panel, not the reader.
    expect(wrapper.find(".reader").exists()).toBe(true);
    expect(wrapper.emitted("close")).toBeFalsy();
    wrapper.unmount();
  });

  // The top progress bar used to show whatever percent the book had when it
  // opened, and never move — saveProgress writes the database, not the query
  // cache the bar was reading.
  it("moves the progress bar as the reader moves through the book", async () => {
    const api = await import("../api");
    (api.getChapter as ReturnType<typeof vi.fn>).mockImplementation(async (_id: number, index: number) => ({
      bookId: 1,
      index,
      title: index === 0 ? "Economy" : "Solitude",
      html: `<p>chapter ${index}</p>`,
      charCount: index === 0 ? 600 : 300,
      aiSummary: null,
    }));

    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();
    // Wait until the saved chapter is on screen — the bar is derived from it.
    expect(wrapper.get(".article-title").text()).toBe("Solitude");

    // Chapters weigh 600 + 300. On chapter 1 with no restorable ratio (jsdom
    // has no layout), the bar sits at the chapter boundary: 600/900. That is
    // already not the frozen open-time percent (0.42).
    const fill = () =>
      (wrapper.get(".reader-progress-fill").element as HTMLElement).style.transform;
    expect(fill()).toBe("scaleX(0.6666666666666666)");

    // Back to chapter 0 at the top → 0.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.get(".article-title").text()).toBe("Economy");
    expect(fill()).toBe("scaleX(0)");

    // Halfway through chapter 0 → 300/900.
    const el = wrapper.get(".reader-scroll").element as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 1500, configurable: true });
    el.scrollTop = 500; // ratio 0.5 of max 1000
    await wrapper.get(".reader-scroll").trigger("scroll");
    await flushRaf();
    await flushPromises();
    expect(fill()).toBe("scaleX(0.3333333333333333)");
    wrapper.unmount();
  });

  // A chapter the reader picks while auto-scroll is running must stop it —
  // otherwise the page keeps creeping after they have already said where to go.
  it("stops auto-scroll when the reader picks a chapter", async () => {
    const { useUi } = await import("../stores/ui");
    useUi().openBook(1);

    const Reader = (await import("./reader/Reader.vue")).default;
    const wrapper = mount(Reader, { global: globals(), attachTo: document.body });
    await flushPromises();
    await flushPromises();
    expect(wrapper.get(".article-title").text()).toBe("Solitude");

    vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});

    await wrapper.get('button[aria-label="Auto-scroll (S)"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('button[aria-label="Pause auto-scroll (S)"]').classes()).toContain("on");

    // Previous chapter — a deliberate navigation, not the auto-scroll's own turn.
    await wrapper.findAll(".chapter-nav-btn")[0].trigger("click");
    await flushPromises();

    expect(wrapper.get('button[aria-label="Auto-scroll (S)"]').classes()).not.toContain("on");
    wrapper.unmount();
  });
});
