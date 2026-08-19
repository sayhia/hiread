package services

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/models"
)

// newLibrary builds a LibraryService over a throwaway database.
func newLibrary(t *testing.T) *LibraryService {
	t.Helper()
	state, err := appstate.New(t.TempDir())
	if err != nil {
		t.Fatalf("appstate.New: %v", err)
	}
	t.Cleanup(func() { _ = state.Close() })
	return &LibraryService{app: state}
}

// sampleEPUB builds a minimal but valid EPUB in memory.
func sampleEPUB(t *testing.T) []byte {
	t.Helper()
	return epubOf(t, "Walden", "Economy", "<p>I lived alone, in the woods.</p>")
}

// sampleEPUBTitled builds an EPUB with a title and body of its own, for tests
// that need two distinguishable books.
func sampleEPUBTitled(t *testing.T, title, body string) []byte {
	t.Helper()
	return epubOf(t, title, "Chapter", "<p>"+body+"</p>")
}

func epubOf(t *testing.T, title, chapterTitle, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mimetype, err := zw.CreateHeader(&zip.FileHeader{Name: "mimetype", Method: zip.Store})
	if err != nil {
		t.Fatalf("mimetype: %v", err)
	}
	if _, err := mimetype.Write([]byte("application/epub+zip")); err != nil {
		t.Fatalf("mimetype write: %v", err)
	}
	files := map[string]string{
		"META-INF/container.xml": `<container><rootfiles>
			<rootfile full-path="content.opf"/></rootfiles></container>`,
		"content.opf": `<package>
			<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
				<dc:title>` + title + `</dc:title><dc:creator>Henry David Thoreau</dc:creator>
			</metadata>
			<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
			<spine><itemref idref="c1"/></spine>
		</package>`,
		"ch1.xhtml": `<html><body><h1>` + chapterTitle + `</h1>` + body + `</body></html>`,
	}
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return buf.Bytes()
}

// ImportBytes is the drag-and-drop path: the webview hands over a dropped
// file's bytes rather than a path it is not allowed to reveal. Wails delivers
// them as a base64 JSON string that encoding/json decodes back into []byte, so
// by the time the service runs it is holding the same bytes ImportFiles would
// have read off disk — and must reach the same result.
func TestImportBytesAddsTheBook(t *testing.T) {
	s := newLibrary(t)

	got, err := s.ImportBytes("walden.epub", sampleEPUB(t))
	if err != nil {
		t.Fatalf("ImportBytes: %v", err)
	}
	if got.Error != "" {
		t.Fatalf("import reported %q", got.Error)
	}
	if got.Duplicate {
		t.Error("a first import must not be reported as a duplicate")
	}
	if got.Title != "Walden" {
		t.Errorf("title = %q", got.Title)
	}

	detail, err := db.GetBook(context.Background(), s.app.DB.R, got.BookID)
	if err != nil {
		t.Fatalf("GetBook: %v", err)
	}
	if detail.ChapterCount != 1 || detail.Chapters[0].Title != "Economy" {
		t.Errorf("chapters = %d / %+v", detail.ChapterCount, detail.Chapters)
	}

	chapter, err := db.GetChapter(context.Background(), s.app.DB.R, got.BookID, 0)
	if err != nil {
		t.Fatalf("GetChapter: %v", err)
	}
	if !bytes.Contains([]byte(chapter.HTML), []byte("lived alone")) {
		t.Errorf("chapter body = %q", chapter.HTML)
	}
}

// Dropping the same file twice is a mistake, not an intent — the second import
// resolves to the copy already in the library instead of adding a twin.
func TestImportBytesRejectsTheSameFileTwice(t *testing.T) {
	s := newLibrary(t)
	data := sampleEPUB(t)

	first, err := s.ImportBytes("walden.epub", data)
	if err != nil {
		t.Fatalf("ImportBytes: %v", err)
	}
	second, err := s.ImportBytes("walden-copy.epub", data)
	if err != nil {
		t.Fatalf("ImportBytes (again): %v", err)
	}
	if !second.Duplicate || second.BookID != first.BookID {
		t.Errorf("re-import gave %+v, want duplicate of book %d", second, first.BookID)
	}

	books, err := db.ListBooks(context.Background(), s.app.DB.R,
		models.LibraryQuery{Kind: models.QueryAll}, models.SortRecent, 10, 0)
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(books) != 1 {
		t.Errorf("library holds %d books, want 1", len(books))
	}
}

// A batch import reports per file: one unreadable file must not cost the user
// the rest of the drop.
func TestImportFilesReportsEachFileSeparately(t *testing.T) {
	s := newLibrary(t)
	dir := t.TempDir()

	good := filepath.Join(dir, "walden.epub")
	if err := os.WriteFile(good, sampleEPUB(t), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	junk := filepath.Join(dir, "notes.bin")
	if err := os.WriteFile(junk, []byte("this is not a book"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	missing := filepath.Join(dir, "gone.epub")

	results, err := s.ImportFiles([]string{good, junk, missing})
	if err != nil {
		t.Fatalf("ImportFiles: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("got %d results, want 3", len(results))
	}
	if results[0].Error != "" || results[0].Title != "Walden" {
		t.Errorf("good file = %+v", results[0])
	}
	if results[1].Error != "unsupportedBook" {
		t.Errorf("unparseable file = %+v", results[1])
	}
	if results[2].Error != "fileUnreadable" {
		t.Errorf("missing file = %+v", results[2])
	}
}

// A folder dropped on the dock or picked as a directory should import the
// books inside it (and nested folders), not fail as an unreadable file, and
// skip notes / hidden junk along the way.
func TestImportFilesWalksADirectory(t *testing.T) {
	s := newLibrary(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "walden.epub"), sampleEPUB(t), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.bin"), []byte("shopping list"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	nested := filepath.Join(dir, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nested, "other.epub"), sampleEPUBTitled(t, "Other", "another book"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	hidden := filepath.Join(dir, ".stash")
	if err := os.Mkdir(hidden, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(hidden, "secret.epub"), sampleEPUBTitled(t, "Secret", "hidden"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	results, err := s.ImportFiles([]string{dir})
	if err != nil {
		t.Fatalf("ImportFiles: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2 (notes and hidden dir skipped): %+v", len(results), results)
	}
	titles := map[string]bool{}
	for _, r := range results {
		if r.Error != "" {
			t.Errorf("unexpected error for %s: %s", r.FileName, r.Error)
		}
		titles[r.Title] = true
	}
	if !titles["Walden"] || !titles["Other"] {
		t.Errorf("titles = %v, want Walden and Other", titles)
	}
}

func TestPickerCopyAndKnownExt(t *testing.T) {
	if got := pickerTitle("zh"); got != "添加书籍" {
		t.Errorf("zh title = %q", got)
	}
	if got := pickerTitle("ja"); got != "本を追加" {
		t.Errorf("ja title = %q", got)
	}
	if got := pickerTitle("en"); got != "Add books" {
		t.Errorf("en title = %q", got)
	}
	if got := pickerFilter("zh"); got != "图书" {
		t.Errorf("zh filter = %q", got)
	}
	if !isKnownBookExt("a.EPUB") || !isKnownBookExt("/tmp/b.pdf") {
		t.Error("known book extensions were rejected")
	}
	if isKnownBookExt("notes.bin") || isKnownBookExt("archive.zip") {
		t.Error("unknown extensions were accepted")
	}
}
