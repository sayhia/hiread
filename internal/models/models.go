// Package models holds the domain types shared between the database layer, the
// services and the frontend. All structs serialize to camelCase so the Vue side
// stays idiomatic and matches src/types.ts.
//
// Nullable fields use pointer types so a nil value marshals to JSON `null`
// (matching the `T | null` frontend types) rather than being omitted.
package models

// Collection is a shelf in the sidebar: a user-made grouping of books.
type Collection struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Position int64  `json:"position"`
	// BookCount is computed at query time.
	BookCount int64 `json:"bookCount"`
}

// Book is a row in the library grid. It carries no chapter text — just what the
// cover card shows and what sorting and filtering need.
type Book struct {
	ID           int64   `json:"id"`
	Title        string  `json:"title"`
	Author       *string `json:"author"`
	Language     *string `json:"language"`
	Publisher    *string `json:"publisher"`
	Format       string  `json:"format"`
	FileName     string  `json:"fileName"`
	FileSize     int64   `json:"fileSize"`
	CollectionID *int64  `json:"collectionId"`
	// HasCover says whether to request cover bytes; the bytes themselves are
	// fetched separately so the list payload stays small.
	HasCover     bool    `json:"hasCover"`
	ChapterCount int64   `json:"chapterCount"`
	CharCount    int64   `json:"charCount"`
	PageCount    int64   `json:"pageCount"`
	AddedAt      string  `json:"addedAt"`
	LastReadAt   *string `json:"lastReadAt"`
	IsFinished   bool    `json:"isFinished"`
	IsFavorite   bool    `json:"isFavorite"`
	// Percent is how far through the book the reader is, 0..1.
	Percent float64 `json:"percent"`
	// Tags currently attached to this book.
	Tags []Tag `json:"tags"`
}

// BookDetail is what the reader loads when a book is opened: everything in Book
// plus the description, the table of contents and the saved position.
type BookDetail struct {
	Book
	Description *string   `json:"description"`
	Identifier  *string   `json:"identifier"`
	PublishedAt *string   `json:"publishedAt"`
	Chapters    []Chapter `json:"chapters"`
	Progress    Progress  `json:"progress"`
}

// Chapter is a table-of-contents entry: the chapter without its body.
type Chapter struct {
	Index int64  `json:"index"`
	Title string `json:"title"`
	Level int64  `json:"level"`
	// Href is the chapter's path inside the original container (EPUB), which is
	// what an intra-book link points at. nil for formats that have none.
	Href *string `json:"href"`
	// CharCount drives both the reading-time estimate and the weight this
	// chapter carries in whole-book progress.
	CharCount int64 `json:"charCount"`
}

// ChapterContent is one chapter's readable body.
type ChapterContent struct {
	BookID int64  `json:"bookId"`
	Index  int64  `json:"index"`
	Title  string `json:"title"`
	// HTML is sanitized and ready to render. Image references carry a data-res
	// attribute naming a book resource rather than a src the webview could
	// fetch on its own.
	HTML      string `json:"html"`
	CharCount int64  `json:"charCount"`
	// AiSummary is the cached AI summary of this chapter, if one was generated.
	AiSummary *string `json:"aiSummary"`
}

// ChapterTranslation is one cached rendering of a chapter, keyed by target
// language and engine.
type ChapterTranslation struct {
	Lang   string  `json:"lang"`
	Engine string  `json:"engine"`
	Title  *string `json:"title"`
	HTML   string  `json:"html"`
}

// Progress is where the reader left off in a book.
type Progress struct {
	ChapterIndex int64 `json:"chapterIndex"`
	// ChapterRatio is the scroll position within the chapter, 0..1.
	ChapterRatio float64 `json:"chapterRatio"`
	// Page is the PDF page number, 1-based, and is meaningless for other formats.
	Page int64 `json:"page"`
	// Percent is progress through the whole book, 0..1.
	Percent   float64 `json:"percent"`
	UpdatedAt string  `json:"updatedAt"`
}

// Bookmark is a position the reader saved by hand.
type Bookmark struct {
	ID           int64   `json:"id"`
	BookID       int64   `json:"bookId"`
	ChapterIndex int64   `json:"chapterIndex"`
	ChapterRatio float64 `json:"chapterRatio"`
	Page         *int64  `json:"page"`
	Label        string  `json:"label"`
	CreatedAt    string  `json:"createdAt"`
}

// Highlight is a user highlight / annotation pinned to a span of a chapter's
// rendered plain text. TextOffset plus Prefix / Suffix form a resilient anchor:
// the offset is tried first, the context window second.
type Highlight struct {
	ID           int64 `json:"id"`
	BookID       int64 `json:"bookId"`
	ChapterIndex int64 `json:"chapterIndex"`
	// Quote is the highlighted text itself.
	Quote string `json:"quote"`
	// Prefix is a short window of text immediately before the quote.
	Prefix string `json:"prefix"`
	// Suffix is a short window of text immediately after the quote.
	Suffix string `json:"suffix"`
	// TextOffset is the character offset of the quote within the chapter's
	// plain-text render.
	TextOffset int64 `json:"textOffset"`
	// Color is a palette key resolved to a colour by the frontend.
	Color string `json:"color"`
	// Note is an optional user note; an empty string means no note.
	Note      string `json:"note"`
	CreatedAt string `json:"createdAt"`
}

// HighlightWithContext is Highlight enriched with the book and chapter it
// belongs to, used by the highlights browser and the Markdown export. Reader
// code keeps using the lean Highlight type.
type HighlightWithContext struct {
	Highlight
	BookTitle    string  `json:"bookTitle"`
	BookAuthor   *string `json:"bookAuthor"`
	ChapterTitle string  `json:"chapterTitle"`
}

// Tag is a user-defined label that can be attached to any number of books.
type Tag struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	// Color is a palette key (resolved to a colour by the frontend).
	Color    string `json:"color"`
	Position int64  `json:"position"`
	// BookCount is how many books currently carry this tag.
	BookCount int64 `json:"bookCount"`
}

// SearchHit is one full-text match inside a book.
type SearchHit struct {
	BookID       int64  `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterIndex int64  `json:"chapterIndex"`
	ChapterTitle string `json:"chapterTitle"`
	// Snippet is the matching passage with the query terms wrapped in <mark>.
	Snippet string `json:"snippet"`
}

// ImportResult reports what happened to one file in an import batch. The
// frontend shows a per-file outcome rather than failing the whole batch on one
// bad file.
type ImportResult struct {
	FileName string `json:"fileName"`
	BookID   int64  `json:"bookId"`
	Title    string `json:"title"`
	// Duplicate is set when the file is already in the library; BookID then
	// points at the copy that is already there.
	Duplicate bool `json:"duplicate"`
	// Error is a frontend i18n key when the file could not be imported.
	Error string `json:"error"`
}

// StorageStats summarizes on-disk usage for the storage panel.
type StorageStats struct {
	DBBytes      int64 `json:"dbBytes"`
	BookCount    int64 `json:"bookCount"`
	ChapterCount int64 `json:"chapterCount"`
	// ResourceBytes is how much of the database the books' images and PDF
	// originals account for.
	ResourceBytes int64 `json:"resourceBytes"`
}

// LibraryQuery filters the library grid, mirroring the sidebar selection. Kind
// is one of all | reading | finished | favorite | collection | tag | format,
// and Value carries the collection or tag id for the two that need one.
type LibraryQuery struct {
	Kind  string  `json:"kind"`
	Value *int64  `json:"value"`
	Text  *string `json:"text"`
}

// Query kinds for LibraryQuery.Kind.
const (
	QueryAll        = "all"
	QueryReading    = "reading"
	QueryFinished   = "finished"
	QueryFavorite   = "favorite"
	QueryCollection = "collection"
	QueryTag        = "tag"
	QueryFormat     = "format"
)

// Sort orders for the library grid.
const (
	SortRecent   = "recent"   // most recently read, then most recently added
	SortAdded    = "added"    // most recently added
	SortTitle    = "title"    // A→Z
	SortAuthor   = "author"   // A→Z
	SortProgress = "progress" // furthest along first
)
