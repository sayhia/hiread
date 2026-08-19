package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"hiread/internal/apperr"
	"hiread/internal/appstate"
	"hiread/internal/books"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/models"
)

// LibraryService is the frontend's entry point to the library: importing books,
// listing them, reading them, and remembering where reading stopped.
type LibraryService struct {
	app *appstate.State
}

// maxBookBytes caps what will be read into memory and stored. A 200 MB scanned
// PDF is a real thing people own, but it is also the point past which holding
// the whole file as a BLOB stops being reasonable.
const maxBookBytes = 200 << 20

// PickAndImport opens the native file picker and imports whatever is chosen.
// Returns one result per file: a batch where one file is corrupt still imports
// the rest, and the frontend reports the failures individually.
func (s *LibraryService) PickAndImport() ([]models.ImportResult, error) {
	lang := settingLang(s.app)
	dialog := application.Get().Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(true).
		SetTitle(pickerTitle(lang))
	exts := books.Extensions()
	patterns := make([]string, 0, len(exts))
	for _, ext := range exts {
		patterns = append(patterns, "*."+ext)
	}
	// One combined filter so a pile of EPUBs and PDFs can be picked together;
	// per-type filters stay below for people who want to narrow.
	dialog = dialog.AddFilter(pickerFilter(lang), strings.Join(patterns, ";"))
	for _, ext := range exts {
		dialog = dialog.AddFilter(strings.ToUpper(ext), "*."+ext)
	}
	paths, err := dialog.PromptForMultipleSelection()
	if err != nil {
		return nil, apperr.Wrap("importFailed", err)
	}
	return s.ImportFiles(paths)
}

// ImportFiles imports book files by path — what the file picker, a command-line
// argument and a drop onto the dock all end up calling.
func (s *LibraryService) ImportFiles(paths []string) ([]models.ImportResult, error) {
	paths = expandImportPaths(paths)
	out := make([]models.ImportResult, 0, len(paths))
	imported := false
	for _, path := range paths {
		r := s.importPath(path)
		out = append(out, r)
		imported = imported || (r.Error == "" && !r.Duplicate)
	}
	if imported {
		events.Emit("library-changed", true)
	}
	return out, nil
}

// ImportBytes imports a book the frontend already holds — a file dropped onto
// the window, which the webview hands over as bytes rather than as a path.
func (s *LibraryService) ImportBytes(fileName string, data []byte) (models.ImportResult, error) {
	r := s.importData(fileName, data)
	if r.Error == "" && !r.Duplicate {
		events.Emit("library-changed", true)
	}
	return r, nil
}

func settingLang(state *appstate.State) string {
	v, _ := db.GetSetting(context.Background(), state.DB.R, "language")
	if v == nil {
		return "en"
	}
	lang := strings.ToLower(strings.TrimSpace(*v))
	if i := strings.IndexAny(lang, "-_"); i >= 0 {
		lang = lang[:i]
	}
	if lang != "zh" && lang != "ja" && lang != "en" {
		return "en"
	}
	return lang
}

func pickerTitle(lang string) string {
	switch lang {
	case "zh":
		return "添加书籍"
	case "ja":
		return "本を追加"
	default:
		return "Add books"
	}
}

func pickerFilter(lang string) string {
	switch lang {
	case "zh":
		return "图书"
	case "ja":
		return "本"
	default:
		return "Books"
	}
}

func isKnownBookExt(path string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	for _, known := range books.Extensions() {
		if ext == known {
			return true
		}
	}
	return false
}

// expandImportPaths walks any directories in the picker / dock drop so a
// folder of mixed EPUBs and PDFs imports as the files inside it.
func expandImportPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil || !info.IsDir() {
			out = append(out, p)
			continue
		}
		_ = filepath.WalkDir(p, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != p {
					return filepath.SkipDir
				}
				return nil
			}
			if isKnownBookExt(path) {
				out = append(out, path)
			}
			return nil
		})
	}
	return out
}

func (s *LibraryService) importPath(path string) models.ImportResult {
	name := filepath.Base(path)
	info, err := os.Stat(path)
	if err != nil {
		return models.ImportResult{FileName: name, Error: "fileUnreadable"}
	}
	if info.Size() > maxBookBytes {
		return models.ImportResult{FileName: name, Error: "fileTooLarge"}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return models.ImportResult{FileName: name, Error: "fileUnreadable"}
	}
	return s.importData(name, data)
}

func (s *LibraryService) importData(fileName string, data []byte) models.ImportResult {
	result := models.ImportResult{FileName: fileName}
	if len(data) == 0 {
		result.Error = "fileEmpty"
		return result
	}
	if len(data) > maxBookBytes {
		result.Error = "fileTooLarge"
		return result
	}

	book, err := books.Parse(fileName, data)
	if err != nil {
		// The parse error itself is the useful part here (unsupported format,
		// DRM, corrupt archive), so it rides along as the code's detail.
		result.Error = "unsupportedBook"
		return result
	}

	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])

	// Only PDF needs its original bytes kept: everything else has been fully
	// extracted into chapters and resources by now.
	var source []byte
	if book.Format == books.FormatPDF {
		source = data
	}

	id, duplicate, err := db.ImportBook(bg(), s.app.DB, book, fileName, hash, int64(len(data)), source)
	if err != nil {
		result.Error = "importFailed"
		return result
	}
	result.BookID = id
	result.Title = book.Metadata.Title
	result.Duplicate = duplicate
	return result
}

// ListBooks returns the library grid for a sidebar selection.
func (s *LibraryService) ListBooks(query models.LibraryQuery, sortBy string, limit, offset int64) ([]models.Book, error) {
	if limit <= 0 {
		limit = 200
	}
	return db.ListBooks(bg(), s.app.DB.R, query, sortBy, limit, offset)
}

// GetBook loads a book's metadata, table of contents and saved position.
func (s *LibraryService) GetBook(id int64) (*models.BookDetail, error) {
	return db.GetBook(bg(), s.app.DB.R, id)
}

// GetChapter returns one chapter's rendered body.
func (s *LibraryService) GetChapter(bookID, index int64) (*models.ChapterContent, error) {
	return db.GetChapter(bg(), s.app.DB.R, bookID, index)
}

// IndexPdfText stores the text behind a PDF's pages so the library can find
// it. The frontend reads it with pdf.js — the Go side cannot, since a PDF's
// pages are drawing instructions — and hands it over once per book.
func (s *LibraryService) IndexPdfText(bookID int64, pages []string) error {
	return db.IndexPdfPages(bg(), s.app.DB, bookID, pages)
}

// HasIndexedText reports whether a book's text has already been indexed, so a
// PDF is read for it once rather than on every open.
func (s *LibraryService) HasIndexedText(bookID int64) (bool, error) {
	return db.HasIndexedPages(bg(), s.app.DB.R, bookID)
}

// ResourceBytes returns an image a chapter references through data-res. Wails
// marshals a []byte as base64, which the frontend turns into a blob URL.
func (s *LibraryService) ResourceBytes(bookID int64, path string) ([]byte, error) {
	data, _, err := db.ResourceBytes(bg(), s.app.DB.R, bookID, path)
	return data, err
}

// CoverBytes returns a book's cover image.
func (s *LibraryService) CoverBytes(bookID int64) ([]byte, error) {
	data, _, err := db.CoverBytes(bg(), s.app.DB.R, bookID)
	return data, err
}

// SourceBytes returns the original file, which the PDF reader renders from.
func (s *LibraryService) SourceBytes(bookID int64) ([]byte, error) {
	return db.SourceBytes(bg(), s.app.DB.R, bookID)
}

// SaveProgress records where reading stopped. Called on a debounce as the
// reader scrolls, so it stays a single cheap upsert.
func (s *LibraryService) SaveProgress(bookID, chapterIndex int64, ratio float64, page int64) error {
	return db.SetProgress(bg(), s.app.DB.W, bookID, chapterIndex, ratio, page)
}

// SetFlag toggles "finished" or "favorite" on a book.
func (s *LibraryService) SetFlag(bookID int64, flag string, on bool) error {
	if err := db.SetBookFlag(bg(), s.app.DB.W, bookID, flag, on); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// SetCollection moves a book onto a shelf, or off every shelf when
// collectionID is null.
func (s *LibraryService) SetCollection(bookID int64, collectionID *int64) error {
	if err := db.SetBookCollection(bg(), s.app.DB.W, bookID, collectionID); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// UpdateMeta corrects a book's title and author.
func (s *LibraryService) UpdateMeta(bookID int64, title, author string) error {
	if err := db.UpdateBookMeta(bg(), s.app.DB.W, bookID, title, author); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// SetPDFMetadata backfills what only a PDF renderer can know: the page count
// and a cover rendered from page one. The frontend calls it the first time it
// opens a PDF.
func (s *LibraryService) SetPDFMetadata(bookID, pageCount int64, title, author string, cover []byte, coverMime string) error {
	if err := db.SetPDFMetadata(bg(), s.app.DB.W, bookID, pageCount, title, author, cover, coverMime); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// DeleteBook removes a book and everything attached to it.
func (s *LibraryService) DeleteBook(bookID int64) error {
	if err := db.DeleteBook(bg(), s.app.DB.W, bookID); err != nil {
		return err
	}
	events.Emit("library-changed", true)
	return nil
}

// Search runs full-text search over chapter bodies, either across the library
// or within one book.
func (s *LibraryService) Search(text string, bookID *int64, limit int64) ([]models.SearchHit, error) {
	if limit <= 0 {
		limit = 60
	}
	return db.SearchLibrary(bg(), s.app.DB.R, text, bookID, limit)
}

// Counts are the numbers beside the sidebar's smart shelves.
func (s *LibraryService) Counts() (db.LibraryCounts, error) {
	return db.CountLibrary(bg(), s.app.DB.R)
}

// ListBookmarks returns a book's bookmarks in reading order.
func (s *LibraryService) ListBookmarks(bookID int64) ([]models.Bookmark, error) {
	return db.ListBookmarks(bg(), s.app.DB.R, bookID)
}

// AddBookmark saves the current position under an optional label.
func (s *LibraryService) AddBookmark(bookID, chapterIndex int64, ratio float64, page *int64, label string) (int64, error) {
	return db.InsertBookmark(bg(), s.app.DB.W, bookID, chapterIndex, ratio, page, label)
}

// DeleteBookmark removes a bookmark.
func (s *LibraryService) DeleteBookmark(id int64) error {
	return db.DeleteBookmark(bg(), s.app.DB.W, id)
}
