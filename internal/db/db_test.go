package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"hiread/internal/books"
	"hiread/internal/models"
)

// openTemp opens a fresh database in a per-test temp dir.
func openTemp(t *testing.T) *DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hiread_test.db")
	d, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func TestMigrateToLatest(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()

	var version int
	if err := d.W.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	if version != len(migrations) {
		t.Fatalf("user_version = %d, want %d", version, len(migrations))
	}

	for _, table := range []string{
		"collections", "books", "chapters", "book_resources", "reading_progress",
		"bookmarks", "highlights", "tags", "book_tags", "settings",
		"installed_fonts", "chapters_fts",
	} {
		var name string
		if err := d.R.QueryRowContext(ctx,
			"SELECT name FROM sqlite_master WHERE name = ?", table).Scan(&name); err != nil {
			t.Errorf("expected table %q to exist: %v", table, err)
		}
	}
}

func TestMigrateIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hiread_test.db")
	for i := 0; i < 2; i++ {
		d, err := Open(path)
		if err != nil {
			t.Fatalf("Open #%d: %v", i+1, err)
		}
		if err := d.Close(); err != nil {
			t.Fatalf("Close #%d: %v", i+1, err)
		}
	}
}

func TestUnicodeLower(t *testing.T) {
	d := openTemp(t)
	var got string
	if err := d.R.QueryRowContext(context.Background(),
		"SELECT unicode_lower('ÉCOLE Straße')").Scan(&got); err != nil {
		t.Fatalf("query: %v", err)
	}
	if got != "école straße" {
		t.Errorf("unicode_lower = %q", got)
	}
}

// sampleBook is a two-chapter book with one image, enough to exercise the whole
// import path.
func sampleBook() *books.Book {
	return &books.Book{
		Format: books.FormatEPUB,
		Metadata: books.Metadata{
			Title:  "山月记",
			Author: "中岛敦",
		},
		Chapters: []books.Chapter{
			{Index: 0, Title: "第一章", HTML: `<p>李征博学才颖。</p><img data-res="i/a.png">`, Text: "李征博学才颖。"},
			{Index: 1, Title: "第二章", HTML: `<p>其声悲怆，闻者落泪。</p>`, Text: "其声悲怆，闻者落泪。"},
		},
		Cover:     &books.Resource{Path: "i/cover.png", Mime: "image/png", Data: []byte("coverbytes")},
		Resources: []books.Resource{{Path: "i/a.png", Mime: "image/png", Data: []byte("imgbytes")}},
	}
}

func importSample(t *testing.T, d *DB, hash string) int64 {
	t.Helper()
	id, dup, err := ImportBook(context.Background(), d, sampleBook(), "shanyueji.epub", hash, 4096, nil)
	if err != nil {
		t.Fatalf("ImportBook: %v", err)
	}
	if dup {
		t.Fatalf("ImportBook reported a duplicate on first import")
	}
	return id
}

func TestImportBookRoundTrip(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-1")

	detail, err := GetBook(ctx, d.R, id)
	if err != nil {
		t.Fatalf("GetBook: %v", err)
	}
	if detail.Title != "山月记" || deref(detail.Author) != "中岛敦" {
		t.Errorf("book = %+v", detail.Book)
	}
	if detail.ChapterCount != 2 || len(detail.Chapters) != 2 {
		t.Errorf("chapters = %d / %d", detail.ChapterCount, len(detail.Chapters))
	}
	if !detail.HasCover {
		t.Error("cover flag not set")
	}
	wantChars := int64(len([]rune("李征博学才颖。")) + len([]rune("其声悲怆，闻者落泪。")))
	if detail.CharCount != wantChars {
		t.Errorf("charCount = %d, want %d", detail.CharCount, wantChars)
	}

	chapter, err := GetChapter(ctx, d.R, id, 1)
	if err != nil {
		t.Fatalf("GetChapter: %v", err)
	}
	if !strings.Contains(chapter.HTML, "闻者落泪") {
		t.Errorf("chapter html = %q", chapter.HTML)
	}

	// The image reference survives sanitization, which is what lets the reader
	// resolve it against the stored resource.
	first, err := GetChapter(ctx, d.R, id, 0)
	if err != nil {
		t.Fatalf("GetChapter(0): %v", err)
	}
	if !strings.Contains(first.HTML, `data-res="i/a.png"`) {
		t.Errorf("data-res dropped by sanitization: %q", first.HTML)
	}

	data, mime, err := ResourceBytes(ctx, d.R, id, "i/a.png")
	if err != nil {
		t.Fatalf("ResourceBytes: %v", err)
	}
	if string(data) != "imgbytes" || mime != "image/png" {
		t.Errorf("resource = %q / %q", data, mime)
	}
	cover, _, err := CoverBytes(ctx, d.R, id)
	if err != nil || string(cover) != "coverbytes" {
		t.Errorf("cover = %q, err = %v", cover, err)
	}
}

func TestImportBookRejectsDuplicateFile(t *testing.T) {
	d := openTemp(t)
	first := importSample(t, d, "same-hash")

	second, dup, err := ImportBook(context.Background(), d, sampleBook(), "copy.epub", "same-hash", 4096, nil)
	if err != nil {
		t.Fatalf("ImportBook: %v", err)
	}
	if !dup || second != first {
		t.Errorf("re-import gave id=%d dup=%v, want id=%d dup=true", second, dup, first)
	}
	var count int64
	if err := d.R.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM books").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("books in library = %d, want 1", count)
	}
}

func TestProgressWeightsChaptersByLength(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-p")

	// Chapter 0 is 7 runes, chapter 1 is 10 — 17 in total. Opening chapter 1 at
	// its very start means exactly chapter 0 has been read: 7/17.
	if err := SetProgress(ctx, d.W, id, 1, 0, 1); err != nil {
		t.Fatalf("SetProgress: %v", err)
	}
	p, err := GetProgress(ctx, d.R, id)
	if err != nil {
		t.Fatalf("GetProgress: %v", err)
	}
	want := 7.0 / 17.0
	if p.Percent < want-0.001 || p.Percent > want+0.001 {
		t.Errorf("percent = %v, want ≈ %v", p.Percent, want)
	}
	if p.ChapterIndex != 1 {
		t.Errorf("chapterIndex = %d", p.ChapterIndex)
	}

	// Reading opens the book, so it must now count as in-progress.
	counts, err := CountLibrary(ctx, d.R)
	if err != nil {
		t.Fatalf("CountLibrary: %v", err)
	}
	if counts.Reading != 1 || counts.All != 1 || counts.Highlights != 0 {
		t.Errorf("counts = %+v", counts)
	}

	// Marking finished pins the bar to full and moves the book out of "reading".
	if err := SetBookFlag(ctx, d.W, id, "finished", true); err != nil {
		t.Fatalf("SetBookFlag: %v", err)
	}
	p, _ = GetProgress(ctx, d.R, id)
	if p.Percent != 1 {
		t.Errorf("finished percent = %v, want 1", p.Percent)
	}
	counts, _ = CountLibrary(ctx, d.R)
	if counts.Reading != 0 || counts.Finished != 1 {
		t.Errorf("counts after finishing = %+v", counts)
	}
}

func TestSearchLibraryFindsCJKSubstrings(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	importSample(t, d, "hash-s")

	// "闻者落泪" sits mid-sentence with no spaces anywhere near it: exactly the
	// case a plain unicode61 index cannot match.
	hits, err := SearchLibrary(ctx, d.R, "闻者落泪", nil, 10)
	if err != nil {
		t.Fatalf("SearchLibrary: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("hits = %d, want 1", len(hits))
	}
	if hits[0].ChapterIndex != 1 || hits[0].BookTitle != "山月记" {
		t.Errorf("hit = %+v", hits[0])
	}
	if !strings.Contains(hits[0].Snippet, "<mark>") {
		t.Errorf("snippet has no highlight: %q", hits[0].Snippet)
	}
	// The snippet must read as prose, not as spaced-out characters.
	if strings.Contains(hits[0].Snippet, "闻 者") {
		t.Errorf("snippet still index-spaced: %q", hits[0].Snippet)
	}

	if hits, _ := SearchLibrary(ctx, d.R, "没有这句话", nil, 10); len(hits) != 0 {
		t.Errorf("unexpected hits for absent text: %+v", hits)
	}
}

func TestSearchLibraryFindsLatinPrefixes(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	b := sampleBook()
	b.Metadata.Title = "Deep Work"
	b.Chapters = []books.Chapter{{
		Index: 0, Title: "Rules", HTML: "<p>Deliberate practice compounds.</p>",
		Text: "Deliberate practice compounds.",
	}}
	if _, _, err := ImportBook(ctx, d, b, "dw.epub", "hash-en", 10, nil); err != nil {
		t.Fatalf("ImportBook: %v", err)
	}
	hits, err := SearchLibrary(ctx, d.R, "delib", nil, 10)
	if err != nil {
		t.Fatalf("SearchLibrary: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("prefix search hits = %d, want 1", len(hits))
	}
}

func TestDeleteBookCascades(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-d")

	if _, err := InsertHighlight(ctx, d.W, NewHighlight{
		BookID: id, ChapterIndex: 0, Quote: "李征", Color: "yellow",
	}); err != nil {
		t.Fatalf("InsertHighlight: %v", err)
	}
	counts, err := CountLibrary(ctx, d.R)
	if err != nil {
		t.Fatalf("CountLibrary: %v", err)
	}
	if counts.Highlights != 1 {
		t.Errorf("highlights count = %d, want 1", counts.Highlights)
	}
	if err := DeleteBook(ctx, d.W, id); err != nil {
		t.Fatalf("DeleteBook: %v", err)
	}
	for _, table := range []string{"chapters", "book_resources", "highlights", "reading_progress"} {
		var n int64
		if err := d.R.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if n != 0 {
			t.Errorf("%s still holds %d row(s) after the book was deleted", table, n)
		}
	}
	// The FTS trigger must have taken the chapter rows with it, or search would
	// keep returning passages from a book that no longer exists.
	var fts int64
	if err := d.R.QueryRowContext(ctx, "SELECT COUNT(*) FROM chapters_fts").Scan(&fts); err != nil {
		t.Fatalf("count fts: %v", err)
	}
	if fts != 0 {
		t.Errorf("chapters_fts still holds %d row(s)", fts)
	}
}

func TestListBooksFiltersAndSorts(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()

	a := sampleBook()
	a.Metadata.Title = "Anna Karenina"
	a.Metadata.Author = "Tolstoy"
	idA, _, err := ImportBook(ctx, d, a, "anna.epub", "h-a", 1, nil)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	z := sampleBook()
	z.Metadata.Title = "Zorba"
	z.Metadata.Author = "Kazantzakis"
	if _, _, err := ImportBook(ctx, d, z, "zorba.epub", "h-z", 1, nil); err != nil {
		t.Fatalf("import: %v", err)
	}

	list, err := ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(list) != 2 || list[0].Title != "Anna Karenina" {
		t.Fatalf("title sort = %v", titles(list))
	}

	text := "kazan"
	list, err = ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll, Text: &text}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(filter): %v", err)
	}
	if len(list) != 1 || list[0].Title != "Zorba" {
		t.Errorf("author filter = %v", titles(list))
	}

	if err := SetBookFlag(ctx, d.W, idA, "favorite", true); err != nil {
		t.Fatalf("SetBookFlag: %v", err)
	}
	list, err = ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryFavorite}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(favorite): %v", err)
	}
	if len(list) != 1 || list[0].ID != idA {
		t.Errorf("favorites = %v", titles(list))
	}
}

func TestCollectionKeepsBooksWhenDeleted(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-c")

	cid, err := CreateCollection(ctx, d.W, "  Classics  ")
	if err != nil {
		t.Fatalf("CreateCollection: %v", err)
	}
	// The same name in another case must reuse the shelf rather than make a twin.
	again, err := CreateCollection(ctx, d.W, "classics")
	if err != nil || again != cid {
		t.Errorf("CreateCollection dedup: got %d, %v", again, err)
	}
	if err := SetBookCollection(ctx, d.W, id, &cid); err != nil {
		t.Fatalf("SetBookCollection: %v", err)
	}
	list, err := ListCollections(ctx, d.R)
	if err != nil || len(list) != 1 || list[0].BookCount != 1 || list[0].Name != "Classics" {
		t.Fatalf("collections = %+v, err = %v", list, err)
	}

	if err := DeleteCollection(ctx, d.W, cid); err != nil {
		t.Fatalf("DeleteCollection: %v", err)
	}
	var n int64
	if err := d.R.QueryRowContext(ctx, "SELECT COUNT(*) FROM books").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("books left after deleting a shelf = %d, want 1", n)
	}
}

func TestBuildHighlightsMarkdownGroupsByBookAndChapter(t *testing.T) {
	author := "中岛敦"
	rows := []models.HighlightWithContext{
		{Highlight: models.Highlight{BookID: 1, ChapterIndex: 0, Quote: "李征"}, BookTitle: "山月记", BookAuthor: &author, ChapterTitle: "第一章"},
		{Highlight: models.Highlight{BookID: 1, ChapterIndex: 0, Quote: "博学才颖", Note: "记一下"}, BookTitle: "山月记", BookAuthor: &author, ChapterTitle: "第一章"},
		{Highlight: models.Highlight{BookID: 1, ChapterIndex: 1, Quote: "其声悲怆"}, BookTitle: "山月记", BookAuthor: &author, ChapterTitle: "第二章"},
		{Highlight: models.Highlight{BookID: 2, ChapterIndex: 0, Quote: "Deep"}, BookTitle: "Deep Work"},
	}
	md := BuildHighlightsMarkdown(rows, "2026-08-05")

	for _, want := range []string{
		"# Highlights — exported 2026-08-05",
		"## 山月记", "*中岛敦*", "### 第一章", "### 第二章",
		"> 李征", "> 博学才颖", "*记一下*", "## Deep Work",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown missing %q:\n%s", want, md)
		}
	}
	// Two highlights in one chapter are separated by a rule; a new chapter
	// heading is separator enough on its own.
	if strings.Count(md, "\n---\n") != 1 {
		t.Errorf("expected exactly one separator:\n%s", md)
	}
}

func titles(list []models.Book) []string {
	out := make([]string, len(list))
	for i, b := range list {
		out[i] = b.Title
	}
	return out
}

func TestBookmarksRoundTrip(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-bm")

	if _, err := InsertBookmark(ctx, d.W, id, 1, 0.25, nil, "其声悲怆"); err != nil {
		t.Fatalf("InsertBookmark: %v", err)
	}
	page := int64(4)
	if _, err := InsertBookmark(ctx, d.W, id, 0, 0, &page, ""); err != nil {
		t.Fatalf("InsertBookmark(page): %v", err)
	}

	list, err := ListBookmarks(ctx, d.R, id)
	if err != nil {
		t.Fatalf("ListBookmarks: %v", err)
	}
	// Reading order, not insertion order: the chapter-0 bookmark comes first.
	if len(list) != 2 || list[0].ChapterIndex != 0 || list[1].ChapterIndex != 1 {
		t.Fatalf("bookmarks = %+v", list)
	}
	if list[0].Page == nil || *list[0].Page != 4 {
		t.Errorf("page bookmark = %+v", list[0])
	}
	if list[1].Page != nil {
		t.Errorf("a chapter bookmark should carry no page: %+v", list[1])
	}
	if list[1].Label != "其声悲怆" || list[1].ChapterRatio != 0.25 {
		t.Errorf("bookmark = %+v", list[1])
	}

	if err := DeleteBookmark(ctx, d.W, list[0].ID); err != nil {
		t.Fatalf("DeleteBookmark: %v", err)
	}
	if list, _ = ListBookmarks(ctx, d.R, id); len(list) != 1 {
		t.Errorf("after delete: %+v", list)
	}

	// Bookmarks belong to their book and go with it.
	if err := DeleteBook(ctx, d.W, id); err != nil {
		t.Fatalf("DeleteBook: %v", err)
	}
	var n int64
	if err := d.R.QueryRowContext(ctx, "SELECT COUNT(*) FROM bookmarks").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("%d bookmark(s) outlived their book", n)
	}
}

func TestHighlightsCarryTheirChapter(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-hl")

	for _, h := range []NewHighlight{
		{BookID: id, ChapterIndex: 0, Quote: "李征", TextOffset: 0, Color: "yellow"},
		{BookID: id, ChapterIndex: 1, Quote: "其声悲怆", TextOffset: 0, Color: "blue", Note: "记一下"},
	} {
		if _, err := InsertHighlight(ctx, d.W, h); err != nil {
			t.Fatalf("InsertHighlight: %v", err)
		}
	}

	// The reader asks for one chapter at a time.
	first, err := ListHighlights(ctx, d.R, id, 0)
	if err != nil {
		t.Fatalf("ListHighlights: %v", err)
	}
	if len(first) != 1 || first[0].Quote != "李征" {
		t.Fatalf("chapter 0 highlights = %+v", first)
	}

	// The annotation panel asks for the whole book, and needs the chapter each
	// highlight belongs to in order to group them.
	all, err := ListBookHighlights(ctx, d.R, id)
	if err != nil {
		t.Fatalf("ListBookHighlights: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("book highlights = %d", len(all))
	}
	if all[0].ChapterTitle != "第一章" || all[1].ChapterTitle != "第二章" {
		t.Errorf("chapter titles = %q / %q", all[0].ChapterTitle, all[1].ChapterTitle)
	}
	if all[1].BookTitle != "山月记" || deref(all[1].BookAuthor) != "中岛敦" {
		t.Errorf("book context = %+v", all[1])
	}
	if all[1].Note != "记一下" {
		t.Errorf("note = %q", all[1].Note)
	}
}

// The Highlights browser exports what it is showing, so the ids it passes are
// already in the order the document should read — including ids that were
// deleted in another window since the list was fetched.
func TestHighlightsByIDsKeepsTheGivenOrder(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	book := importSample(t, d, "hash-hl")

	quotes := []string{"李征", "博学才颖", "其声悲怆"}
	ids := make([]int64, len(quotes))
	for i, q := range quotes {
		id, err := InsertHighlight(ctx, d.W, NewHighlight{BookID: book, ChapterIndex: int64(i % 2), Quote: q, Color: "yellow"})
		if err != nil {
			t.Fatalf("InsertHighlight: %v", err)
		}
		ids[i] = id
	}

	want := []int64{ids[2], ids[0], ids[1]}
	rows, err := HighlightsByIDs(ctx, d.R, want)
	if err != nil {
		t.Fatalf("HighlightsByIDs: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	for i, id := range want {
		if rows[i].ID != id {
			t.Errorf("row %d = %d, want %d", i, rows[i].ID, id)
		}
	}
	if rows[0].BookTitle != "山月记" || rows[0].ChapterTitle == "" {
		t.Errorf("rows are missing their book/chapter context: %+v", rows[0])
	}

	if err := DeleteHighlight(ctx, d.W, ids[0]); err != nil {
		t.Fatalf("DeleteHighlight: %v", err)
	}
	rows, err = HighlightsByIDs(ctx, d.R, want)
	if err != nil {
		t.Fatalf("HighlightsByIDs after delete: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != ids[2] || rows[1].ID != ids[1] {
		t.Errorf("a since-deleted id should be skipped, not error; got %d rows", len(rows))
	}

	empty, err := HighlightsByIDs(ctx, d.R, nil)
	if err != nil || len(empty) != 0 {
		t.Errorf("no ids = %v, %v", empty, err)
	}
}

// The sidebar's drag-to-reorder is the only writer of these positions, and
// both lists are read back sorted by them.
func TestReorderShelvesAndTags(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()

	shelfIDs := make([]int64, 0, 3)
	for _, name := range []string{"Classics", "History", "To read"} {
		id, err := CreateCollection(ctx, d.W, name)
		if err != nil {
			t.Fatalf("CreateCollection: %v", err)
		}
		shelfIDs = append(shelfIDs, id)
	}
	want := []int64{shelfIDs[2], shelfIDs[0], shelfIDs[1]}
	if err := ReorderCollections(ctx, d, want); err != nil {
		t.Fatalf("ReorderCollections: %v", err)
	}
	shelves, err := ListCollections(ctx, d.R)
	if err != nil {
		t.Fatalf("ListCollections: %v", err)
	}
	for i, id := range want {
		if shelves[i].ID != id {
			t.Errorf("shelf %d = %d, want %d", i, shelves[i].ID, id)
		}
	}

	tagIDs := make([]int64, 0, 2)
	for _, name := range []string{"strategy", "essays"} {
		id, err := CreateTag(ctx, d.W, name)
		if err != nil {
			t.Fatalf("CreateTag: %v", err)
		}
		tagIDs = append(tagIDs, id)
	}
	if err := ReorderTags(ctx, d, []int64{tagIDs[1], tagIDs[0]}); err != nil {
		t.Fatalf("ReorderTags: %v", err)
	}
	tags, err := ListTags(ctx, d.R)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if tags[0].ID != tagIDs[1] || tags[1].ID != tagIDs[0] {
		t.Errorf("tag order = %d, %d", tags[0].ID, tags[1].ID)
	}
}

// A PDF's pages are drawing instructions, so nothing about them reaches the
// index at import: searching the library for a phrase that is in one found
// nothing, which is indistinguishable from the phrase not being there.
func TestIndexPdfPagesMakesAPdfFindable(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()

	var bookID int64
	err := d.W.QueryRowContext(ctx, `
		INSERT INTO books (title, format, file_name, file_hash, chapter_count, char_count, page_count, added_at)
		VALUES ('我不是教你诈', 'pdf', 'a.pdf', 'h1', 0, 0, 411, datetime('now')) RETURNING id`).Scan(&bookID)
	if err != nil {
		t.Fatalf("insert book: %v", err)
	}

	pages := []string{"封面", "", "  ", "新版序 写给年轻朋友的人生三书", "第一章 谈诈"}
	if err := IndexPdfPages(ctx, d, bookID, pages); err != nil {
		t.Fatalf("IndexPdfPages: %v", err)
	}

	// A page of pictures indexes nothing; the rest keep their page number.
	rows, err := SearchLibrary(ctx, d.R, "年轻朋友", &bookID, 10)
	if err != nil {
		t.Fatalf("SearchLibrary: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d hits, want the one page it is on", len(rows))
	}
	if rows[0].ChapterIndex != 3 {
		t.Errorf("hit is on index %d, want 3 — the page it was given", rows[0].ChapterIndex)
	}
	if rows[0].ChapterTitle != "" {
		t.Errorf("a page has no title of its own, got %q", rows[0].ChapterTitle)
	}

	// Two-character CJK search has to work here as it does everywhere else.
	if hits, _ := SearchLibrary(ctx, d.R, "谈诈", &bookID, 10); len(hits) != 1 {
		t.Errorf("two-character CJK search found %d, want 1", len(hits))
	}

	// The book's chapter count stays zero: a PDF has no chapters, and that is
	// what tells progress to measure it by page rather than by chapter weight.
	var count int64
	_ = d.R.QueryRowContext(ctx, `SELECT chapter_count FROM books WHERE id = ?1`, bookID).Scan(&count)
	if count != 0 {
		t.Errorf("chapter_count = %d, want it left alone", count)
	}
	if err := SetProgress(ctx, d.W, bookID, 0, 0, 206); err != nil {
		t.Fatalf("SetProgress: %v", err)
	}
	p, err := GetProgress(ctx, d.R, bookID)
	if err != nil {
		t.Fatalf("GetProgress: %v", err)
	}
	if p.Percent < 0.4 || p.Percent > 0.6 {
		t.Errorf("percent = %v for page 206 of 411; indexing changed how a PDF's progress is measured", p.Percent)
	}

	// Indexing again replaces what was there rather than doubling it.
	if err := IndexPdfPages(ctx, d, bookID, pages); err != nil {
		t.Fatalf("re-index: %v", err)
	}
	if hits, _ := SearchLibrary(ctx, d.R, "年轻朋友", &bookID, 10); len(hits) != 1 {
		t.Errorf("re-indexing left %d hits, want 1", len(hits))
	}

	if ok, _ := HasIndexedPages(ctx, d.R, bookID); !ok {
		t.Error("HasIndexedPages says no after indexing")
	}
}

func TestV2BackfillsLoweredTitleAuthor(t *testing.T) {
	// Build a v1 database by hand (schema + user_version), insert a row the
	// old schema would have left, then Open — which applies v2 and backfills.
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v1.db")

	registerFunctions()
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatalf("open raw v1: %v", err)
	}
	if _, err := raw.Exec(migrations[0]); err != nil {
		raw.Close()
		t.Fatalf("apply v1: %v", err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 1`); err != nil {
		raw.Close()
		t.Fatalf("set v1 version: %v", err)
	}
	if _, err := raw.Exec(
		`INSERT INTO books (title, author, format, file_name, file_hash, added_at)
		 VALUES ('ÉCOLE Straße', 'Kazantzakis', 'epub', 'x.epub', 'h-1', datetime('now'))`); err != nil {
		raw.Close()
		t.Fatalf("insert v1 row: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("close raw: %v", err)
	}

	d, err := Open(path)
	if err != nil {
		t.Fatalf("Open (v1 -> latest): %v", err)
	}
	defer d.Close()

	var tl, al string
	if err := d.R.QueryRowContext(ctx,
		`SELECT title_lower, author_lower FROM books WHERE file_hash = 'h-1'`).Scan(&tl, &al); err != nil {
		t.Fatalf("read lowered columns: %v", err)
	}
	if tl != "école straße" {
		t.Errorf("title_lower = %q, want %q", tl, "école straße")
	}
	if al != "kazantzakis" {
		t.Errorf("author_lower = %q, want %q", al, "kazantzakis")
	}

	// The filter now matches the backfilled row case-insensitively, exactly as
	// the old per-row unicode_lower query did.
	text := "ÉCOLE"
	list, err := ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll, Text: &text}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(filter): %v", err)
	}
	if len(list) != 1 || list[0].Title != "ÉCOLE Straße" {
		t.Errorf("backfilled row not found by case-insensitive filter: %v", titles(list))
	}
}

func TestListBooksFilterFollowsMetaEdits(t *testing.T) {
	d := openTemp(t)
	ctx := context.Background()
	id := importSample(t, d, "hash-edit")

	// Rename via UpdateBookMeta, then filter on the new title in a different
	// case than stored.
	if err := UpdateBookMeta(ctx, d.W, id, "WALDEN", "Thoreau"); err != nil {
		t.Fatalf("UpdateBookMeta: %v", err)
	}
	text := "walden"
	list, err := ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll, Text: &text}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(filter): %v", err)
	}
	if len(list) != 1 || list[0].Title != "WALDEN" {
		t.Errorf("filter after rename = %v", titles(list))
	}

	// The old title must no longer match.
	text = "山月记"
	list, err = ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll, Text: &text}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(filter): %v", err)
	}
	if len(list) != 0 {
		t.Errorf("stale lowercased title still matches: %v", titles(list))
	}
}

// TestV3RepairsV2IntermediateLibrary covers the database shape an intermediate
// build actually shipped: v2 applied (search_text column, user_version = 2)
// but nothing after it. Open must add the v3 columns, drop the dead
// search_text, and backfill — a regression for the "no such column:
// title_lower" failure on real libraries that hit that intermediate build.
func TestV3RepairsV2IntermediateLibrary(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v2_intermediate.db")

	registerFunctions()
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	for _, m := range migrations[:2] { // v1 + the frozen v2
		if _, err := raw.Exec(m); err != nil {
			raw.Close()
			t.Fatalf("apply migration: %v", err)
		}
	}
	if _, err := raw.Exec(`PRAGMA user_version = 2`); err != nil {
		raw.Close()
		t.Fatalf("set version: %v", err)
	}
	if _, err := raw.Exec(
		`INSERT INTO books (title, author, format, file_name, file_hash, added_at)
		 VALUES ('WALDEN', 'Thoreau', 'epub', 'w.epub', 'h-int', datetime('now'))`); err != nil {
		raw.Close()
		t.Fatalf("insert row: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("close raw: %v", err)
	}

	d, err := Open(path)
	if err != nil {
		t.Fatalf("Open (v2 intermediate -> latest): %v", err)
	}
	defer d.Close()

	// v3 columns exist and are backfilled.
	var tl, al string
	if err := d.R.QueryRowContext(ctx,
		`SELECT title_lower, author_lower FROM books WHERE file_hash = 'h-int'`).Scan(&tl, &al); err != nil {
		t.Fatalf("read lowered columns: %v", err)
	}
	if tl != "walden" || al != "thoreau" {
		t.Errorf("backfill = %q / %q, want %q / %q", tl, al, "walden", "thoreau")
	}

	// The dead search_text column is gone.
	var hasSearchText bool
	if err := d.R.QueryRowContext(ctx,
		`SELECT COUNT(*) > 0 FROM pragma_table_info('books') WHERE name = 'search_text'`).Scan(&hasSearchText); err != nil {
		t.Fatalf("check search_text: %v", err)
	}
	if hasSearchText {
		t.Error("search_text column still present after v3")
	}

	// And the filter works against the repaired library.
	text := "walden"
	list, err := ListBooks(ctx, d.R, models.LibraryQuery{Kind: models.QueryAll, Text: &text}, models.SortTitle, 50, 0)
	if err != nil {
		t.Fatalf("ListBooks(filter): %v", err)
	}
	if len(list) != 1 || list[0].Title != "WALDEN" {
		t.Errorf("filter after repair = %v", titles(list))
	}
}
