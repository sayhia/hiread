package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"hiread/internal/apperr"
	"hiread/internal/models"
)

const highlightCols = "id, book_id, chapter_index, quote, prefix, suffix, text_offset, color, note, created_at"

// NewHighlight is the input for creating a highlight — everything in Highlight
// except the database-assigned id and created_at.
type NewHighlight struct {
	BookID       int64
	ChapterIndex int64
	Quote        string
	Prefix       string
	Suffix       string
	TextOffset   int64
	Color        string
	Note         string
}

func scanHighlight(s interface {
	Scan(dest ...any) error
}) (models.Highlight, error) {
	var h models.Highlight
	err := s.Scan(&h.ID, &h.BookID, &h.ChapterIndex, &h.Quote, &h.Prefix, &h.Suffix,
		&h.TextOffset, &h.Color, &h.Note, &h.CreatedAt)
	return h, err
}

// InsertHighlight inserts a highlight and returns its new id.
func InsertHighlight(ctx context.Context, q Querier, h NewHighlight) (int64, error) {
	res, err := q.ExecContext(ctx,
		`INSERT INTO highlights(book_id, chapter_index, quote, prefix, suffix, text_offset, color, note)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		h.BookID, h.ChapterIndex, h.Quote, h.Prefix, h.Suffix, h.TextOffset, h.Color, h.Note)
	if err != nil {
		return 0, apperr.Wrap("db", err)
	}
	return res.LastInsertId()
}

// ListHighlights returns the highlights inside one chapter, in reading order.
func ListHighlights(ctx context.Context, q Querier, bookID, chapterIndex int64) ([]models.Highlight, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT "+highlightCols+
			" FROM highlights WHERE book_id = ?1 AND chapter_index = ?2 ORDER BY text_offset, id",
		bookID, chapterIndex)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []models.Highlight{}
	for rows.Next() {
		h, err := scanHighlight(rows)
		if err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ListBookHighlights returns every highlight in one book, in reading order —
// what the reader's annotation sidebar shows for the book as a whole.
func ListBookHighlights(ctx context.Context, q Querier, bookID int64) ([]models.HighlightWithContext, error) {
	return queryHighlightsWithContext(ctx, q,
		" WHERE h.book_id = ?1 ORDER BY h.chapter_index, h.text_offset, h.id", bookID)
}

// highlightWithCtxCols is the JOIN projection used by the highlights browser and
// the Markdown exporter. The h.* columns mirror highlightCols.
//
// The chapter join is LEFT: a highlight outlives nothing (chapters are deleted
// only with their book, which cascades the highlight away too), but an index
// that has drifted past the end of a re-imported book should still export with
// its quote rather than disappear from the query.
const highlightWithCtxCols = "h.id, h.book_id, h.chapter_index, h.quote, h.prefix, h.suffix, " +
	"h.text_offset, h.color, h.note, h.created_at, " +
	"b.title, b.author, COALESCE(c.title, '')"

const highlightWithCtxFrom = " FROM highlights h" +
	" JOIN books b ON b.id = h.book_id" +
	" LEFT JOIN chapters c ON c.book_id = h.book_id AND c.idx = h.chapter_index"

func scanHighlightWithContext(s interface {
	Scan(dest ...any) error
}) (models.HighlightWithContext, error) {
	var (
		hc     models.HighlightWithContext
		author sql.Null[string]
	)
	err := s.Scan(
		&hc.ID, &hc.BookID, &hc.ChapterIndex, &hc.Quote, &hc.Prefix, &hc.Suffix,
		&hc.TextOffset, &hc.Color, &hc.Note, &hc.CreatedAt,
		&hc.BookTitle, &author, &hc.ChapterTitle,
	)
	hc.BookAuthor = nullPtr(author)
	return hc, err
}

func queryHighlightsWithContext(ctx context.Context, q Querier, tail string, args ...any) ([]models.HighlightWithContext, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+highlightWithCtxCols+highlightWithCtxFrom+tail, args...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []models.HighlightWithContext{}
	for rows.Next() {
		hc, err := scanHighlightWithContext(rows)
		if err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, hc)
	}
	return out, rows.Err()
}

// ListAllHighlights returns every highlight enriched with the book and chapter
// it belongs to, newest first. Used by the global Highlights browser.
func ListAllHighlights(ctx context.Context, q Querier) ([]models.HighlightWithContext, error) {
	return queryHighlightsWithContext(ctx, q, " ORDER BY h.created_at DESC, h.id DESC")
}

// escapeLikeForHighlights escapes the three SQL LIKE wildcards (% _ \) so user
// input matches literally. The query is paired with `LIKE ?1 ESCAPE '\\'`.
func escapeLikeForHighlights(q string) string {
	r := make([]byte, 0, len(q)+4)
	for i := 0; i < len(q); i++ {
		c := q[i]
		if c == '\\' || c == '%' || c == '_' {
			r = append(r, '\\')
		}
		r = append(r, c)
	}
	return string(r)
}

// SearchAllHighlights returns every highlight whose quote, note, or owning book
// title matches the query (case-insensitive substring). An empty query returns
// the full list, identical to ListAllHighlights.
func SearchAllHighlights(ctx context.Context, q Querier, query string) ([]models.HighlightWithContext, error) {
	if query == "" {
		return ListAllHighlights(ctx, q)
	}
	pat := "%" + escapeLikeForHighlights(query) + "%"
	return queryHighlightsWithContext(ctx, q,
		" WHERE h.quote LIKE ?1 ESCAPE '\\'"+
			" OR h.note  LIKE ?1 ESCAPE '\\'"+
			" OR b.title LIKE ?1 ESCAPE '\\'"+
			" ORDER BY h.created_at DESC, h.id DESC", pat)
}

// HighlightsByIDs returns the given highlights, enriched with book and chapter,
// **in the order the ids were given** — the export walks the list once and
// starts a new heading whenever the book or chapter changes, so the caller's
// order is what the document looks like. The Highlights browser passes the ids
// it is showing, which makes the file match the screen.
//
// Ids that no longer exist are skipped; the query is chunked to stay well under
// SQLite's bind-variable limit.
func HighlightsByIDs(ctx context.Context, q Querier, ids []int64) ([]models.HighlightWithContext, error) {
	if len(ids) == 0 {
		return []models.HighlightWithContext{}, nil
	}
	byID := make(map[int64]models.HighlightWithContext, len(ids))
	const chunk = 500
	for start := 0; start < len(ids); start += chunk {
		end := min(start+chunk, len(ids))
		part := ids[start:end]
		args := make([]any, len(part))
		ph := make([]string, len(part))
		for i, id := range part {
			args[i] = id
			ph[i] = "?"
		}
		rows, err := queryHighlightsWithContext(ctx, q, " WHERE h.id IN ("+strings.Join(ph, ",")+")", args...)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			byID[r.ID] = r
		}
	}
	out := make([]models.HighlightWithContext, 0, len(ids))
	for _, id := range ids {
		if r, ok := byID[id]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// GetHighlight fetches one highlight by id, if it exists.
func GetHighlight(ctx context.Context, q Querier, id int64) (*models.Highlight, error) {
	h, err := scanHighlight(q.QueryRowContext(ctx,
		"SELECT "+highlightCols+" FROM highlights WHERE id = ?1", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return &h, nil
}

// UpdateHighlightNote replaces a highlight's note text (an empty string clears it).
func UpdateHighlightNote(ctx context.Context, q Querier, id int64, note string) error {
	if _, err := q.ExecContext(ctx, "UPDATE highlights SET note = ?2 WHERE id = ?1", id, note); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// SetHighlightColor changes a highlight's colour (a palette key).
func SetHighlightColor(ctx context.Context, q Querier, id int64, color string) error {
	if _, err := q.ExecContext(ctx, "UPDATE highlights SET color = ?2 WHERE id = ?1", id, color); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// DeleteHighlight removes a highlight.
func DeleteHighlight(ctx context.Context, q Querier, id int64) error {
	if _, err := q.ExecContext(ctx, "DELETE FROM highlights WHERE id = ?1", id); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// DeleteHighlights removes a batch of highlights in chunked IN-clause deletes,
// all inside one transaction: a mid-batch failure deletes nothing rather than
// an unknown prefix (the frontend has already cleared its selection by commit
// time, so a partial delete would be unretryable and silently divergent).
// Chunking keeps the bind-variable count well under SQLite's limit.
func DeleteHighlights(ctx context.Context, d *DB, ids []int64) error {
	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Wrap("db", err)
	}
	defer tx.Rollback()

	const chunk = 500
	for start := 0; start < len(ids); start += chunk {
		end := min(start+chunk, len(ids))
		part := ids[start:end]
		ph := make([]string, len(part))
		args := make([]any, len(part))
		for i, id := range part {
			ph[i] = "?"
			args[i] = id
		}
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM highlights WHERE id IN ("+strings.Join(ph, ",")+")", args...); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}
