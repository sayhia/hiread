package db

import (
	"context"

	"hiread/internal/apperr"
	"hiread/internal/models"
)

// StorageStats reports database size and library counts for the storage panel.
//
// A library grows by whole books at a time — an illustrated EPUB or a scanned
// PDF is tens of megabytes — so the panel breaks out how much of the database
// is book payload (images and PDF originals) as opposed to text and metadata.
func StorageStats(ctx context.Context, q Querier) (models.StorageStats, error) {
	var s models.StorageStats
	var pageCount, pageSize int64
	if err := q.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pageCount); err != nil {
		return s, apperr.Wrap("db", err)
	}
	if err := q.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
		return s, apperr.Wrap("db", err)
	}
	if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM books").Scan(&s.BookCount); err != nil {
		return s, apperr.Wrap("db", err)
	}
	if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM chapters").Scan(&s.ChapterCount); err != nil {
		return s, apperr.Wrap("db", err)
	}
	if err := q.QueryRowContext(ctx, `
		SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM book_resources)
		     + (SELECT COALESCE(SUM(LENGTH(source_blob)), 0) FROM books WHERE source_blob IS NOT NULL)
		     + (SELECT COALESCE(SUM(LENGTH(cover)), 0) FROM books WHERE cover IS NOT NULL)`).
		Scan(&s.ResourceBytes); err != nil {
		return s, apperr.Wrap("db", err)
	}
	s.DBBytes = pageCount * pageSize
	return s, nil
}

// Vacuum rebuilds the database file, returning the space deleted books left
// behind. SQLite only ever grows a file on its own; deleting a 40 MB PDF frees
// pages for reuse but does not shrink anything on disk until VACUUM runs.
func Vacuum(ctx context.Context, d *DB) error {
	if _, err := d.W.ExecContext(ctx, "VACUUM"); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// ClearLibrary deletes every book. Chapters, resources, highlights, bookmarks,
// progress and tag links all cascade from the books table, so one DELETE is the
// whole operation; shelves, tags and settings are deliberately left standing.
func ClearLibrary(ctx context.Context, d *DB) error {
	if _, err := d.W.ExecContext(ctx, "DELETE FROM books"); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// ResetSettings clears every stored setting.
func ResetSettings(ctx context.Context, q Querier) error {
	if _, err := q.ExecContext(ctx, "DELETE FROM settings"); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}
