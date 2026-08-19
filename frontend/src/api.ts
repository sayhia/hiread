// Typed wrappers over the Wails service bindings (frontend/bindings/hiread/services).
// Components import from here, never from the generated bindings directly: this
// is where nulls are coerced, wire shapes are adapted, and streaming calls are
// wrapped into the StreamHandle contract.

import { Events } from "@wailsio/runtime";
import {
  AIService,
  CollectionService,
  FontService,
  HighlightService,
  LibraryService,
  SettingService,
  StorageService,
  SystemService,
  TagService,
} from "../bindings/hiread/services";
import type {
  AiChatTurn,
  AiEvent,
  AppInfo,
  Book,
  BookDetail,
  BookSort,
  Bookmark,
  ChapterContent,
  ChapterTranslation,
  Collection,
  FontProgress,
  Highlight,
  HighlightWithContext,
  ImportResult,
  LibraryCounts,
  LibraryQuery,
  Progress,
  SearchHit,
  StorageStats,
  Tag,
  TranslateEvent,
  UpdateInfo,
} from "./types";
import { createReorderBuffer } from "./lib/streamOrder";
import { pendingBookDeletes, pendingCollectionDeletes, pendingTagDeletes } from "./lib/pendingDeletes";
import type { InstalledFont } from "../bindings/hiread/internal/db/models";

// ── streaming helper ──
/** A running stream: awaitable like a Promise, and stoppable via `cancel()`.
 *  `cancel` aborts the backend call — Wails cancels the Go context, so a
 *  streamed generation actually stops instead of running to completion (or the
 *  300s timeout) in the background, burning API quota, after the UI moved on. */
export interface StreamHandle extends Promise<void> {
  cancel(): void;
}

/** Subscribe to a per-request event, run the bound streaming call, and tear the
 *  subscription down when it settles. Wails has no per-call Channel, so the
 *  backend emits on `"<base>:<id>"` and we listen for the lifetime of the call.
 *
 *  Wails v3 (alpha) dispatches every backend Emit on its own goroutine, so
 *  consecutive emits race and can arrive out of order — for a token stream that
 *  scrambles the text. The backend stamps each event with a monotonic sequence
 *  number (events.Sequencer) wrapped as `{ seq, data }`; here we buffer by that
 *  number and release only a contiguous prefix, so `onEvent` always sees the
 *  original emit order. */
function stream<T>(
  base: string,
  onEvent: (e: T) => void,
  call: (id: string) => Promise<unknown>,
): StreamHandle {
  const id = crypto.randomUUID();
  const buf = createReorderBuffer<T>(onEvent);
  const off = Events.On(`${base}:${id}`, (ev: { data: unknown }) => {
    // Wails delivers the payload as `ev.data`; the backend wraps it as
    // `{ seq, data }` (events.Sequencer) so we can restore order.
    const env: any = (ev && (ev as any).data) ?? ev;
    if (typeof env?.seq === "number") buf.push(env.seq, env.data as T);
    // A payload with no seq can only come from a non-sequenced emit on this
    // name; deliver it as-is rather than drop it.
    else if (env != null) onEvent(env as T);
  });
  // Keep the raw call result: a Wails-generated streaming method returns a
  // CancellablePromise whose `.cancel()` cancels the backend context.
  const pending = call(id) as Promise<unknown> & { cancel?: () => void };
  const done = Promise.resolve(pending)
    .then(() => void 0)
    .finally(() => {
      // The call has settled, so every event has been emitted. Flush any
      // out-of-order tail still buffered, then unsubscribe.
      buf.flush();
      off();
    }) as StreamHandle;
  done.cancel = () => {
    try {
      pending.cancel?.();
    } catch {
      /* not cancellable or already settled — nothing to stop */
    }
  };
  return done;
}

// The Go backend returns a nil slice for an empty result, which crosses the
// Wails bridge as `null`. Every list endpoint coerces null → [] here so no
// consumer can crash on `.map` / `.length`.
//
// listBooks / listCollections / listTags additionally drop rows whose delete
// sits inside its undo window (lib/pendingDeletes.ts): the backend still holds
// those rows until the deferred delete commits, so an unfiltered mid-window
// refetch would resurrect them ("vanish → reappear → vanish").

// ── library ──
/** The wire shape of a LibraryQuery: the Go struct is {kind, value, text}
 *  while the TS union carries only the field its kind needs. */
function wireQuery(q: LibraryQuery) {
  return {
    kind: q.kind,
    value: "value" in q ? q.value : null,
    text: "text" in q ? q.text : null,
  };
}

export const listBooks = (
  query: LibraryQuery,
  sort: BookSort,
  limit: number,
  offset: number,
  filterText?: string,
) =>
  (
    LibraryService.ListBooks(
      { ...wireQuery(query), text: filterText?.trim() ? filterText : wireQuery(query).text },
      sort,
      limit,
      offset,
    ) as Promise<Book[] | null>
  ).then((rows) => (rows ?? []).filter((b) => !pendingBookDeletes.has(b.id)));

export const getBook = (id: number) =>
  (LibraryService.GetBook(id) as unknown as Promise<BookDetail | null>).then((b) => {
    if (!b) throw new Error("book not found");
    // Go returns nil slices as null; the reader indexes into chapters freely.
    return { ...b, chapters: b.chapters ?? [], tags: b.tags ?? [] };
  });
export const getChapter = (bookId: number, index: number) =>
  LibraryService.GetChapter(bookId, index) as Promise<ChapterContent>;
export const libraryCounts = () => LibraryService.Counts() as Promise<LibraryCounts>;
/** Store the text behind a PDF's pages so the library can find it. Only the
 *  frontend can read it — a PDF's pages are drawing instructions, which the Go
 *  importer cannot decode. */
export const indexPdfText = (bookId: number, pages: string[]) =>
  LibraryService.IndexPdfText(bookId, pages) as Promise<void>;
export const hasIndexedText = (bookId: number) =>
  LibraryService.HasIndexedText(bookId) as Promise<boolean>;
export const searchLibrary = (text: string, bookId: number | null, limit = 60) =>
  (LibraryService.Search(text, bookId, limit) as Promise<SearchHit[] | null>).then((r) => r ?? []);

export const saveProgress = (bookId: number, chapterIndex: number, ratio: number, page: number) =>
  LibraryService.SaveProgress(bookId, chapterIndex, ratio, page) as Promise<void>;
export const setBookFlag = (bookId: number, flag: "finished" | "favorite", on: boolean) =>
  LibraryService.SetFlag(bookId, flag, on) as Promise<void>;
export const setBookCollection = (bookId: number, collectionId: number | null) =>
  LibraryService.SetCollection(bookId, collectionId) as Promise<void>;
export const updateBookMeta = (bookId: number, title: string, author: string) =>
  LibraryService.UpdateMeta(bookId, title, author) as Promise<void>;
export const deleteBook = (bookId: number) => LibraryService.DeleteBook(bookId) as Promise<void>;

// ── import ──
/** Open the native file picker and import whatever is chosen. */
export const pickAndImport = () =>
  (LibraryService.PickAndImport() as Promise<ImportResult[] | null>).then((r) => r ?? []);
/** Import a file the webview holds as bytes (a drop onto the window). */
export const importBytes = (fileName: string, data: Uint8Array) =>
  LibraryService.ImportBytes(fileName, bytesToBase64(data)) as unknown as Promise<ImportResult>;

// ── book bytes (covers, chapter images, PDF originals) ──
/** Wails marshals a Go []byte as a base64 string; every byte-returning call
 *  decodes here so callers always get real bytes. */
async function decodeBytes(p: Promise<unknown>): Promise<Uint8Array> {
  const b64 = (await p) as unknown as string;
  if (!b64) return new Uint8Array();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunked so a multi-megabyte cover does not blow the argument limit of
  // String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const coverBytes = (bookId: number) => decodeBytes(LibraryService.CoverBytes(bookId));
export const resourceBytes = (bookId: number, path: string) =>
  decodeBytes(LibraryService.ResourceBytes(bookId, path));
export const sourceBytes = (bookId: number) => decodeBytes(LibraryService.SourceBytes(bookId));

/** Backfill what only a PDF renderer knows: page count, embedded metadata, and
 *  a cover rendered from page one. */
export const setPdfMetadata = (
  bookId: number,
  pageCount: number,
  title: string,
  author: string,
  cover: Uint8Array | null,
  coverMime: string,
) =>
  LibraryService.SetPDFMetadata(
    bookId,
    pageCount,
    title,
    author,
    cover ? bytesToBase64(cover) : "",
    coverMime,
  ) as unknown as Promise<void>;

// ── bookmarks ──
export const listBookmarks = (bookId: number) =>
  (LibraryService.ListBookmarks(bookId) as Promise<Bookmark[] | null>).then((r) => r ?? []);
export const addBookmark = (
  bookId: number,
  chapterIndex: number,
  ratio: number,
  page: number | null,
  label: string,
) => LibraryService.AddBookmark(bookId, chapterIndex, ratio, page, label) as Promise<number>;
export const deleteBookmark = (id: number) => LibraryService.DeleteBookmark(id) as Promise<void>;

// ── collections (shelves) ──
export const listCollections = () =>
  (CollectionService.ListCollections() as Promise<Collection[] | null>).then((r) =>
    (r ?? []).filter((c) => !pendingCollectionDeletes.has(c.id)),
  );
export const createCollection = (name: string) =>
  CollectionService.CreateCollection(name) as Promise<number>;
export const renameCollection = (id: number, name: string) =>
  CollectionService.RenameCollection(id, name) as Promise<void>;
export const deleteCollection = (id: number) =>
  CollectionService.DeleteCollection(id) as Promise<void>;
export const reorderCollections = (ids: number[]) =>
  CollectionService.ReorderCollections(ids) as Promise<void>;

// ── tags ──
export const listTags = () =>
  (TagService.ListTags() as Promise<Tag[] | null>).then((r) =>
    (r ?? []).filter((tg) => !pendingTagDeletes.has(tg.id)),
  );
export const createTag = (name: string) => TagService.CreateTag(name) as Promise<number>;
export const renameTag = (id: number, name: string) => TagService.RenameTag(id, name) as Promise<void>;
export const setTagColor = (id: number, color: string) => TagService.SetTagColor(id, color) as Promise<void>;
export const deleteTag = (id: number) => TagService.DeleteTag(id) as Promise<void>;
export const reorderTags = (ids: number[]) => TagService.ReorderTags(ids) as Promise<void>;
export const setBookTag = (bookId: number, tagId: number, on: boolean) =>
  TagService.SetBookTag(bookId, tagId, on) as Promise<void>;

// ── highlights / annotations ──
export interface NewHighlight {
  bookId: number;
  chapterIndex: number;
  quote: string;
  prefix: string;
  suffix: string;
  textOffset: number;
  color: string;
  note: string;
}
export const createHighlight = (h: NewHighlight) =>
  HighlightService.CreateHighlight(
    h.bookId,
    h.chapterIndex,
    h.quote,
    h.prefix,
    h.suffix,
    h.textOffset,
    h.color,
    h.note,
  ) as Promise<number>;
export const listHighlights = (bookId: number, chapterIndex: number) =>
  (HighlightService.ListHighlights(bookId, chapterIndex) as Promise<Highlight[] | null>).then((r) => r ?? []);
export const listBookHighlights = (bookId: number) =>
  (HighlightService.ListBookHighlights(bookId) as Promise<HighlightWithContext[] | null>).then((r) => r ?? []);
export const listAllHighlights = () =>
  (HighlightService.ListAllHighlights() as Promise<HighlightWithContext[] | null>).then((r) => r ?? []);
export const searchHighlights = (query: string) =>
  (HighlightService.SearchHighlights(query) as Promise<HighlightWithContext[] | null>).then((r) => r ?? []);
/** Export exactly these highlights, in this order. Resolves to the saved path,
 *  or "" if the native save panel was cancelled. */
export const exportSelectionMarkdown = (ids: number[]) =>
  HighlightService.ExportSelectionMarkdown(ids) as Promise<string>;
export const updateHighlightNote = (id: number, note: string) =>
  HighlightService.UpdateHighlightNote(id, note) as Promise<void>;
export const setHighlightColor = (id: number, color: string) =>
  HighlightService.SetHighlightColor(id, color) as Promise<void>;
export const deleteHighlight = (id: number) => HighlightService.DeleteHighlight(id) as Promise<void>;
/** Batch delete for the browser's multi-select (one IPC call, chunked SQL). */
export const deleteHighlights = (ids: number[]) =>
  HighlightService.DeleteHighlights(ids) as Promise<void>;

// ── AI (streaming over events) ──
/** Summarize one chapter. A completed summary is cached backend-side. */
export function aiSummarize(
  bookId: number,
  chapterIndex: number,
  onToken: (e: AiEvent) => void,
): StreamHandle {
  return stream<AiEvent>("ai", onToken, (id) => AIService.Summarize(bookId, chapterIndex, id));
}
/** Ask a RAG question over the library, or over one book when `bookId` is set,
 *  streaming the answer. `history` is the prior conversation (empty for a first
 *  question) so a follow-up keeps its context. */
export function aiAsk(
  question: string,
  bookId: number | null,
  history: AiChatTurn[],
  onToken: (e: AiEvent) => void,
): StreamHandle {
  return stream<AiEvent>("ai", onToken, (id) => AIService.Ask(question, bookId, history, id));
}
/** Plain assistant chat — no library context. */
export function aiChat(
  question: string,
  history: AiChatTurn[],
  onToken: (e: AiEvent) => void,
): StreamHandle {
  return stream<AiEvent>("ai", onToken, (id) => AIService.Chat(question, history, id));
}
/** Translate a chapter, streaming batch by batch. The result is cached
 *  backend-side per (chapter, lang, engine). */
export function aiTranslate(
  bookId: number,
  chapterIndex: number,
  lang: string,
  engine: string,
  onEvent: (e: TranslateEvent) => void,
): StreamHandle {
  return stream<TranslateEvent>("translate", onEvent, (id) =>
    AIService.Translate(bookId, chapterIndex, lang, engine, id),
  );
}
/** The cached translation for a chapter, or null when it has none. */
/** Whether an LLM provider is configured — resolved by the backend, which is
 *  the only side that knows about provider profiles and the legacy settings
 *  behind them. */
export const aiConfigured = () => AIService.Configured() as Promise<boolean>;
export const getTranslation = (bookId: number, chapterIndex: number, lang: string, engine: string) =>
  AIService.GetTranslation(bookId, chapterIndex, lang, engine) as Promise<ChapterTranslation | null>;

// ── settings ──
/** The reader's settings as a file the reader picks. Both go through Go: the
 *  WKWebView has no download handler, so an `<a download>` here saves nothing
 *  and says nothing about it. An empty string means they cancelled. */
export const exportReadingFile = (content: string) => SettingService.ExportReading(content);
export const importReadingFile = () => SettingService.ImportReading();

export const getSetting = (key: string) => SettingService.GetSetting(key) as Promise<string | null>;
export const setSetting = (key: string, value: string) => SettingService.SetSetting(key, value) as Promise<void>;
export const applyNetworkSettings = () => SettingService.ApplyNetworkSettings() as Promise<void>;

// ── fonts (downloadable fonts are added by URL; there is no built-in catalog) ──
export const listInstalledFonts = () =>
  (FontService.ListInstalled() as Promise<InstalledFont[] | null>).then((r) => r ?? []);
export const deleteFont = (id: string) => FontService.DeleteFont(id) as Promise<void>;
export function addCustomFont(
  url: string,
  family: string,
  axis: string,
  onProgress: (p: FontProgress) => void,
): Promise<void> {
  return stream<FontProgress>("font", onProgress, (sid) => FontService.AddCustomFont(url, family, axis, sid));
}

// ── storage ──
export const storageStats = () => StorageService.StorageStats() as Promise<StorageStats>;
export const vacuumDb = () => StorageService.VacuumDB() as Promise<void>;
export const resetSettings = () => StorageService.ResetSettings() as Promise<void>;
export const clearLibrary = () => StorageService.ClearLibrary() as Promise<void>;

// ── app identity / update check ──
export const appInfo = () => SystemService.AppInfo() as Promise<AppInfo>;
export const checkForUpdate = () => SystemService.CheckForUpdate() as Promise<UpdateInfo>;

// ── tray ──
export const refreshTray = () => SystemService.RefreshTray() as Promise<void>;

// ── window ──
/** Repaint the native window backing (macOS resize strips) to the theme's
 *  paper colour. */
export const setWindowBackground = (r: number, g: number, b: number) =>
  SystemService.SetWindowBackground(r, g, b) as Promise<void>;
export const toggleFullscreen = () => SystemService.ToggleFullscreen() as Promise<boolean>;
export const isFullscreen = () => SystemService.IsFullscreen() as Promise<boolean>;
