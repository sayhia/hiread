package services

import (
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"hiread/internal/apperr"
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/models"
)

// HighlightService exposes the highlight / annotation layer.
type HighlightService struct {
	app *appstate.State
}

// CreateHighlight inserts a highlight and returns its new id. The anchor fields
// (prefix / suffix / textOffset) let the frontend re-locate the span even after
// the rendered text shifts.
func (s *HighlightService) CreateHighlight(bookID, chapterIndex int64, quote, prefix, suffix string, textOffset int64, color, note string) (int64, error) {
	if strings.TrimSpace(quote) == "" {
		return 0, apperr.Code("emptyHighlight")
	}
	return db.InsertHighlight(bg(), s.app.DB.W, db.NewHighlight{
		BookID:       bookID,
		ChapterIndex: chapterIndex,
		Quote:        quote,
		Prefix:       prefix,
		Suffix:       suffix,
		TextOffset:   textOffset,
		Color:        color,
		Note:         note,
	})
}

// ListHighlights returns the highlights inside one chapter, in reading order.
func (s *HighlightService) ListHighlights(bookID, chapterIndex int64) ([]models.Highlight, error) {
	return db.ListHighlights(bg(), s.app.DB.R, bookID, chapterIndex)
}

// ListBookHighlights returns every highlight in one book, in reading order —
// what the reader's annotation panel shows.
func (s *HighlightService) ListBookHighlights(bookID int64) ([]models.HighlightWithContext, error) {
	return db.ListBookHighlights(bg(), s.app.DB.R, bookID)
}

// ListAllHighlights returns every highlight enriched with its book and chapter,
// newest first — used by the Highlights browser panel.
func (s *HighlightService) ListAllHighlights() ([]models.HighlightWithContext, error) {
	return db.ListAllHighlights(bg(), s.app.DB.R)
}

// UpdateHighlightNote replaces a highlight's note (empty string clears it).
func (s *HighlightService) UpdateHighlightNote(id int64, note string) error {
	return db.UpdateHighlightNote(bg(), s.app.DB.W, id, note)
}

// SetHighlightColor changes a highlight's colour (a palette key).
func (s *HighlightService) SetHighlightColor(id int64, color string) error {
	return db.SetHighlightColor(bg(), s.app.DB.W, id, color)
}

// DeleteHighlight removes a highlight.
func (s *HighlightService) DeleteHighlight(id int64) error {
	return db.DeleteHighlight(bg(), s.app.DB.W, id)
}

// DeleteHighlights removes a batch of highlights (the browser's multi-select
// delete) in one transactional call rather than one IPC round-trip per row.
func (s *HighlightService) DeleteHighlights(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	return db.DeleteHighlights(bg(), s.app.DB, ids)
}

// SearchHighlights filters the global highlight list by quote, note, or
// owning-book title. An empty query is equivalent to ListAllHighlights.
func (s *HighlightService) SearchHighlights(query string) ([]models.HighlightWithContext, error) {
	return db.SearchAllHighlights(bg(), s.app.DB.R, strings.TrimSpace(query))
}

// ExportSelectionMarkdown renders the given highlights — in the given order —
// as one Markdown document. The Highlights browser passes the ids it is
// showing (or just the ticked ones), so the file matches the screen rather
// than re-deriving a filter the backend cannot see: a search term, a colour
// filter and a date range compose there, and only the frontend knows the
// result. Returns the saved path, or an empty string when the user cancels.
func (s *HighlightService) ExportSelectionMarkdown(ids []int64) (string, error) {
	rows, err := db.HighlightsByIDs(bg(), s.app.DB.R, ids)
	if err != nil {
		return "", apperr.Wrap("highlight", err)
	}
	today := time.Now().Format("2006-01-02")
	return s.saveMarkdown("hiread-highlights-"+today+".md", db.BuildHighlightsMarkdown(rows, today))
}

// saveMarkdown asks for a destination and writes the document there. The Wails
// WKWebView has no download handler, so a webview `<a download>` saves nothing;
// the export is driven by a native save panel and written here in Go. An empty
// path means the user cancelled, which is not an error.
func (s *HighlightService) saveMarkdown(defaultName, content string) (string, error) {
	path, err := application.Get().Dialog.SaveFile().
		SetFilename(defaultName).
		AddFilter("Markdown", "*.md").
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return "", apperr.Wrap("highlightExport", err)
	}
	if path == "" {
		return "", nil // user cancelled — not an error
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", apperr.Wrap("highlightExport", err)
	}
	return path, nil
}
