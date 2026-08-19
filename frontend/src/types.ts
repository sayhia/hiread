// Type mirrors of the Go domain model (see internal/models/models.go).

/** A book container format. */
export type BookFormat = "epub" | "mobi" | "pdf" | "txt" | "md";

/** A shelf in the sidebar: a user-made grouping of books. */
export interface Collection {
  id: number;
  name: string;
  position: number;
  bookCount: number;
}

/** A row in the library grid. */
export interface Book {
  id: number;
  title: string;
  author: string | null;
  language: string | null;
  publisher: string | null;
  format: BookFormat;
  fileName: string;
  fileSize: number;
  collectionId: number | null;
  /** Whether to request cover bytes; the bytes are fetched separately. */
  hasCover: boolean;
  chapterCount: number;
  charCount: number;
  pageCount: number;
  addedAt: string;
  lastReadAt: string | null;
  isFinished: boolean;
  isFavorite: boolean;
  /** How far through the book the reader is, 0..1. */
  percent: number;
  tags: Tag[];
}

/** Everything the reader needs when a book is opened. */
export interface BookDetail extends Book {
  description: string | null;
  identifier: string | null;
  publishedAt: string | null;
  chapters: Chapter[];
  progress: Progress;
}

/** A table-of-contents entry: the chapter without its body. */
export interface Chapter {
  index: number;
  title: string;
  level: number;
  /** The chapter's path inside the original container (EPUB), which is what an
   *  intra-book link points at; null for formats that have none. */
  href: string | null;
  charCount: number;
}

/** One chapter's readable body. */
export interface ChapterContent {
  bookId: number;
  index: number;
  title: string;
  /** Sanitized HTML. Images carry `data-res` naming a stored book resource
   *  rather than a src the webview could fetch on its own. */
  html: string;
  charCount: number;
  aiSummary: string | null;
}

/** One cached rendering of a chapter, keyed by target language + engine. */
export interface ChapterTranslation {
  lang: string;
  engine: string;
  title: string | null;
  html: string;
}

/** How a translated chapter is shown: the original, the translation, or both. */
export type TransView = "original" | "bilingual" | "translation";

/** Where the reader left off in a book. */
export interface Progress {
  chapterIndex: number;
  /** Scroll position within the chapter, 0..1. */
  chapterRatio: number;
  /** PDF page number, 1-based; meaningless for other formats. */
  page: number;
  /** Progress through the whole book, 0..1. */
  percent: number;
  updatedAt: string;
}

/** A position the reader saved by hand. */
export interface Bookmark {
  id: number;
  bookId: number;
  chapterIndex: number;
  chapterRatio: number;
  page: number | null;
  label: string;
  createdAt: string;
}

/** A highlight pinned to a span of a chapter's rendered plain text. */
export interface Highlight {
  id: number;
  bookId: number;
  chapterIndex: number;
  quote: string;
  prefix: string;
  suffix: string;
  textOffset: number;
  color: string;
  note: string;
  createdAt: string;
}

/** Highlight enriched with its book and chapter, for the highlights browser and
 *  the Markdown export. Reader code keeps using `Highlight`. */
export interface HighlightWithContext extends Highlight {
  bookTitle: string;
  bookAuthor: string | null;
  chapterTitle: string;
}

/** A user-defined label attachable to any number of books. */
export interface Tag {
  id: number;
  name: string;
  color: string;
  position: number;
  bookCount: number;
}

/** One full-text match inside a book. */
export interface SearchHit {
  bookId: number;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  /** The matching passage, query terms wrapped in `<mark>`. */
  snippet: string;
}

/** What happened to one file in an import batch. */
export interface ImportResult {
  fileName: string;
  bookId: number;
  title: string;
  /** Set when the file was already in the library; `bookId` is the copy there. */
  duplicate: boolean;
  /** An i18n key under `error.*` when the file could not be imported. */
  error: string;
}

/** The counts beside the sidebar's smart shelves. */
export interface LibraryCounts {
  all: number;
  reading: number;
  finished: number;
  favorite: number;
  highlights: number;
}

/** On-disk usage for the storage panel. */
export interface StorageStats {
  dbBytes: number;
  bookCount: number;
  chapterCount: number;
  /** How much of the database the books' images and PDF originals account for. */
  resourceBytes: number;
}

/** The library-grid filter, mirroring the sidebar selection. */
export type LibraryQuery =
  | { kind: "all" }
  | { kind: "reading" }
  | { kind: "finished" }
  | { kind: "favorite" }
  | { kind: "collection"; value: number }
  | { kind: "tag"; value: number }
  | { kind: "format"; text: BookFormat };

/** How the library grid is ordered. */
export type BookSort = "recent" | "added" | "title" | "author" | "progress";

/** Build identity (mirrors services.AppInfo). */
export interface AppInfo {
  version: string;
  os: string;
  arch: string;
}

/** Update-check result (mirrors services.UpdateInfo). */
export interface UpdateInfo {
  current: string;
  latest: string;
  releaseUrl: string;
  hasUpdate: boolean;
}

export type AiEvent =
  | { type: "delta"; data: string }
  | { type: "done" }
  | { type: "error"; data: string }
  // Emitted once, before the answer, by the RAG Q&A path: `data` is a JSON
  // array of AiSource (the retrieved chapters) the UI shows as citations.
  | { type: "sources"; data: string };

/** One retrieved chapter the Q&A answer drew on, surfaced as a clickable
 *  citation. Parsed from a "sources" AiEvent's JSON `data`. */
export interface AiSource {
  bookId: number;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
}

/** One turn of the Ask conversation sent back as history so a follow-up keeps
 *  its context. Matches the generated bindings' ai.Message shape. */
export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Progress for a font download (events on "font:<streamID>"). `total` is -1
 *  when the server doesn't send a Content-Length; `done` marks the final event. */
export interface FontProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error: string;
}

/** Batch-level translation progress. The start/done events also carry the
 *  translated title (empty when unavailable). */
export type TranslateEvent =
  | { type: "start"; data: { total: number; title?: string } }
  // A batch arrives as whole translated blocks while the model writes them,
  // then a final event carrying the completed count and no html. Go omits zero
  // values, so both fields are optional on the wire.
  | { type: "batch"; data: { html?: string; done?: number } }
  | { type: "done"; data: { html: string; title?: string } };
