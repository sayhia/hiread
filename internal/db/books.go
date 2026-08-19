package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"hiread/internal/apperr"
	"hiread/internal/books"
	"hiread/internal/models"
	"hiread/internal/sanitize"
)

// ImportBook writes a parsed book, its chapters, its resources and its search
// index in one transaction: a half-imported book is worse than no book, since
// the library would show a cover that opens onto nothing.
//
// A file already in the library (same content hash) is not re-imported; the
// existing book's id comes back with duplicate = true so the caller can say so
// and select it instead.
func ImportBook(ctx context.Context, d *DB, b *books.Book, fileName, fileHash string, fileSize int64, sourceBlob []byte) (id int64, duplicate bool, err error) {
	if existing, err := BookIDByHash(ctx, d.R, fileHash); err != nil {
		return 0, false, err
	} else if existing != nil {
		return *existing, true, nil
	}

	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, apperr.Wrap("db", err)
	}
	defer tx.Rollback()

	var coverData []byte
	var coverMime *string
	if b.Cover != nil && len(b.Cover.Data) > 0 {
		coverData = b.Cover.Data
		mime := b.Cover.Mime
		coverMime = &mime
	}

	// Count each chapter's runes once: the per-chapter figure feeds both the
	// book's total and the row inserted below, and len([]rune) on a long book's
	// text is a full conversion — it was done twice per chapter before.
	charCount := 0
	chapterChars := make([]int, len(b.Chapters))
	for i := range b.Chapters {
		chapterChars[i] = len([]rune(b.Chapters[i].Text))
		charCount += chapterChars[i]
	}

	titleLower, authorLower := searchTextFor(b.Metadata.Title, b.Metadata.Author)
	res, err := tx.ExecContext(ctx,
		`INSERT INTO books
		   (title, author, language, publisher, description, identifier, published_at,
		    format, file_name, file_size, file_hash, cover, cover_mime,
		    chapter_count, char_count, page_count, source_blob, title_lower, author_lower)
		 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
		b.Metadata.Title, nz(strOrNil(b.Metadata.Author)), nz(strOrNil(b.Metadata.Language)),
		nz(strOrNil(b.Metadata.Publisher)), nz(strOrNil(b.Metadata.Description)),
		nz(strOrNil(b.Metadata.Identifier)), nz(strOrNil(b.Metadata.Published)),
		b.Format, fileName, fileSize, fileHash, coverData, coverMime,
		len(b.Chapters), charCount, b.PageCount, sourceBlob,
		titleLower, authorLower)
	if err != nil {
		return 0, false, apperr.Wrap("db", err)
	}
	bookID, err := res.LastInsertId()
	if err != nil {
		return 0, false, apperr.Wrap("db", err)
	}

	for i, c := range b.Chapters {
		html := sanitize.Chapter(c.HTML)
		chapRes, err := tx.ExecContext(ctx,
			`INSERT INTO chapters (book_id, idx, title, level, href, html, text, char_count)
			 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
			bookID, c.Index, c.Title, c.Level, nz(strOrNil(c.Href)), html, c.Text, chapterChars[i])
		if err != nil {
			return 0, false, apperr.Wrap("db", err)
		}
		chapterID, err := chapRes.LastInsertId()
		if err != nil {
			return 0, false, apperr.Wrap("db", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO chapters_fts(rowid, title, body) VALUES (?1, ?2, ?3)`,
			chapterID, searchText(c.Title), searchText(c.Text)); err != nil {
			return 0, false, apperr.Wrap("db", err)
		}
	}

	for _, r := range b.Resources {
		if r.Path == "" || len(r.Data) == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO book_resources (book_id, path, mime, data) VALUES (?1,?2,?3,?4)`,
			bookID, r.Path, r.Mime, r.Data); err != nil {
			return 0, false, apperr.Wrap("db", err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO reading_progress (book_id) VALUES (?1)`, bookID); err != nil {
		return 0, false, apperr.Wrap("db", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, false, apperr.Wrap("db", err)
	}
	return bookID, false, nil
}

// BookIDByHash reports which book a file's content hash already belongs to.
func BookIDByHash(ctx context.Context, q Querier, hash string) (*int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM books WHERE file_hash = ?1`, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return &id, nil
}

// ListBooks runs the library-grid query for a sidebar selection. The WHERE
// clause and ORDER BY are assembled dynamically, so this uses plain positional
// placeholders.
func ListBooks(ctx context.Context, q Querier, query models.LibraryQuery, sortBy string, limit, offset int64) ([]models.Book, error) {
	where := []string{"1=1"}
	var binds []any

	switch query.Kind {
	case models.QueryAll:
	case models.QueryReading:
		// Started but not finished: what "continue reading" should offer.
		where = append(where, "b.is_finished = 0 AND p.percent > 0")
	case models.QueryFinished:
		where = append(where, "b.is_finished = 1")
	case models.QueryFavorite:
		where = append(where, "b.is_favorite = 1")
	case models.QueryCollection:
		where = append(where, "b.collection_id = ?")
		binds = append(binds, deref(query.Value))
	case models.QueryTag:
		where = append(where, "b.id IN (SELECT book_id FROM book_tags WHERE tag_id = ?)")
		binds = append(binds, deref(query.Value))
	case models.QueryFormat:
		where = append(where, "b.format = ?")
		binds = append(binds, deref(query.Text))
	}

	// Title / author filtering is a plain substring match: the grid filters as
	// the user types, and full-text search over chapter bodies is a separate,
	// heavier query (SearchLibrary).
	// Title / author filtering is a plain substring match against the
	// lowercased title_lower / author_lower columns (v2), so the per-keystroke
	// filter pays a byte comparison per row instead of a unicode_lower scalar
	// call.
	if query.Text != nil && strings.TrimSpace(*query.Text) != "" && query.Kind != models.QueryFormat {
		where = append(where, "(b.title_lower LIKE ? OR b.author_lower LIKE ?)")
		pattern := "%" + strings.ToLower(strings.TrimSpace(*query.Text)) + "%"
		binds = append(binds, pattern, pattern)
	}

	order := "COALESCE(b.last_read_at, b.added_at) DESC, b.id DESC"
	switch sortBy {
	case models.SortAdded:
		order = "b.added_at DESC, b.id DESC"
	case models.SortTitle:
		order = "b.title COLLATE NOCASE ASC, b.id ASC"
	case models.SortAuthor:
		order = "COALESCE(b.author,'') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC"
	case models.SortProgress:
		order = "p.percent DESC, COALESCE(b.last_read_at, b.added_at) DESC"
	}

	sqlStr := fmt.Sprintf(`
		SELECT b.id, b.title, b.author, b.language, b.publisher, b.format, b.file_name,
		       b.file_size, b.collection_id, b.cover IS NOT NULL, b.chapter_count,
		       b.char_count, b.page_count, b.added_at, b.last_read_at,
		       b.is_finished, b.is_favorite, COALESCE(p.percent, 0)
		FROM books b
		LEFT JOIN reading_progress p ON p.book_id = b.id
		WHERE %s
		ORDER BY %s
		LIMIT ? OFFSET ?`, strings.Join(where, " AND "), order)
	binds = append(binds, limit, offset)

	rows, err := q.QueryContext(ctx, sqlStr, binds...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()

	out := []models.Book{}
	for rows.Next() {
		var b models.Book
		if err := rows.Scan(&b.ID, &b.Title, &b.Author, &b.Language, &b.Publisher, &b.Format,
			&b.FileName, &b.FileSize, &b.CollectionID, &b.HasCover, &b.ChapterCount,
			&b.CharCount, &b.PageCount, &b.AddedAt, &b.LastReadAt,
			&b.IsFinished, &b.IsFavorite, &b.Percent); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return attachTags(ctx, q, out)
}

// attachTags fills in the Tags of every book in one extra query rather than one
// per row.
func attachTags(ctx context.Context, q Querier, list []models.Book) ([]models.Book, error) {
	if len(list) == 0 {
		return list, nil
	}
	ids := make([]string, 0, len(list))
	index := make(map[int64]int, len(list))
	for i, b := range list {
		ids = append(ids, fmt.Sprint(b.ID))
		index[b.ID] = i
		list[i].Tags = []models.Tag{}
	}
	rows, err := q.QueryContext(ctx, fmt.Sprintf(
		`SELECT bt.book_id, t.id, t.name, t.color, t.position
		 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
		 WHERE bt.book_id IN (%s)
		 ORDER BY t.position, t.id`, strings.Join(ids, ",")))
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	for rows.Next() {
		var bookID int64
		var t models.Tag
		if err := rows.Scan(&bookID, &t.ID, &t.Name, &t.Color, &t.Position); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		if i, ok := index[bookID]; ok {
			list[i].Tags = append(list[i].Tags, t)
		}
	}
	return list, rows.Err()
}

// GetBook loads everything the reader needs to open a book: its metadata, its
// table of contents and where reading stopped.
func GetBook(ctx context.Context, q Querier, id int64) (*models.BookDetail, error) {
	var d models.BookDetail
	err := q.QueryRowContext(ctx, `
		SELECT b.id, b.title, b.author, b.language, b.publisher, b.format, b.file_name,
		       b.file_size, b.collection_id, b.cover IS NOT NULL, b.chapter_count,
		       b.char_count, b.page_count, b.added_at, b.last_read_at,
		       b.is_finished, b.is_favorite, COALESCE(p.percent, 0),
		       b.description, b.identifier, b.published_at,
		       COALESCE(p.chapter_index, 0), COALESCE(p.chapter_ratio, 0),
		       COALESCE(p.page, 1), COALESCE(p.updated_at, '')
		FROM books b
		LEFT JOIN reading_progress p ON p.book_id = b.id
		WHERE b.id = ?1`, id).
		Scan(&d.ID, &d.Title, &d.Author, &d.Language, &d.Publisher, &d.Format, &d.FileName,
			&d.FileSize, &d.CollectionID, &d.HasCover, &d.ChapterCount,
			&d.CharCount, &d.PageCount, &d.AddedAt, &d.LastReadAt,
			&d.IsFinished, &d.IsFavorite, &d.Percent,
			&d.Description, &d.Identifier, &d.PublishedAt,
			&d.Progress.ChapterIndex, &d.Progress.ChapterRatio,
			&d.Progress.Page, &d.Progress.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.Code("bookNotFound")
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	d.Progress.Percent = d.Percent

	chapters, err := ListChapters(ctx, q, id)
	if err != nil {
		return nil, err
	}
	d.Chapters = chapters

	tagged, err := attachTags(ctx, q, []models.Book{d.Book})
	if err != nil {
		return nil, err
	}
	d.Book = tagged[0]
	return &d, nil
}

// ListChapters returns a book's table of contents, without chapter bodies.
func ListChapters(ctx context.Context, q Querier, bookID int64) ([]models.Chapter, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT idx, title, level, href, char_count FROM chapters WHERE book_id = ?1 ORDER BY idx`, bookID)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []models.Chapter{}
	for rows.Next() {
		var c models.Chapter
		var href sql.Null[string]
		if err := rows.Scan(&c.Index, &c.Title, &c.Level, &href, &c.CharCount); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		c.Href = nullPtr(href)
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetChapter loads one chapter's body.
func GetChapter(ctx context.Context, q Querier, bookID, index int64) (*models.ChapterContent, error) {
	var c models.ChapterContent
	c.BookID = bookID
	var summary sql.Null[string]
	err := q.QueryRowContext(ctx,
		`SELECT idx, title, html, char_count, ai_summary FROM chapters WHERE book_id = ?1 AND idx = ?2`,
		bookID, index).Scan(&c.Index, &c.Title, &c.HTML, &c.CharCount, &summary)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.Code("chapterNotFound")
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	c.AiSummary = nullPtr(summary)
	return &c, nil
}

// ChapterText returns a chapter's plain text, which the AI features summarize
// and translate over.
func ChapterText(ctx context.Context, q Querier, bookID, index int64) (string, error) {
	var text string
	err := q.QueryRowContext(ctx,
		`SELECT text FROM chapters WHERE book_id = ?1 AND idx = ?2`, bookID, index).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return "", apperr.Code("chapterNotFound")
	}
	if err != nil {
		return "", apperr.Wrap("db", err)
	}
	return text, nil
}

// ChapterTitleText returns a chapter's title and plain text in one query, for
// callers that summarize over the text and never need its HTML.
func ChapterTitleText(ctx context.Context, q Querier, bookID, index int64) (title, text string, err error) {
	err = q.QueryRowContext(ctx,
		`SELECT title, text FROM chapters WHERE book_id = ?1 AND idx = ?2`, bookID, index).
		Scan(&title, &text)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", apperr.Code("chapterNotFound")
	}
	if err != nil {
		return "", "", apperr.Wrap("db", err)
	}
	return title, text, nil
}

// ResourceBytes returns one stored book resource (an image a chapter refers to
// through data-res).
func ResourceBytes(ctx context.Context, q Querier, bookID int64, path string) ([]byte, string, error) {
	var data []byte
	var mime string
	err := q.QueryRowContext(ctx,
		`SELECT data, mime FROM book_resources WHERE book_id = ?1 AND path = ?2`, bookID, path).
		Scan(&data, &mime)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", apperr.Code("resourceNotFound")
	}
	if err != nil {
		return nil, "", apperr.Wrap("db", err)
	}
	return data, mime, nil
}

// CoverBytes returns a book's cover image.
func CoverBytes(ctx context.Context, q Querier, bookID int64) ([]byte, string, error) {
	var data []byte
	var mime *string
	err := q.QueryRowContext(ctx, `SELECT cover, cover_mime FROM books WHERE id = ?1`, bookID).
		Scan(&data, &mime)
	if errors.Is(err, sql.ErrNoRows) || len(data) == 0 {
		return nil, "", apperr.Code("coverNotFound")
	}
	if err != nil {
		return nil, "", apperr.Wrap("db", err)
	}
	return data, deref(mime), nil
}

// SourceBytes returns the original file bytes kept for formats the frontend
// renders itself (PDF).
func SourceBytes(ctx context.Context, q Querier, bookID int64) ([]byte, error) {
	var data []byte
	err := q.QueryRowContext(ctx, `SELECT source_blob FROM books WHERE id = ?1`, bookID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) || len(data) == 0 {
		return nil, apperr.Code("sourceNotFound")
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return data, nil
}

// IndexPdfPages makes a PDF findable.
//
// A PDF's pages are drawing instructions, so nothing about them reaches the
// full-text index at import — searching the library for a phrase that is in one
// simply found nothing, with no way to tell that from the phrase not being
// there. The frontend can read the text behind the pages (pdf.js does it for
// the in-document search), so it hands them over and they are indexed here as
// the book's chapters: one row per page, no markup, the page number as its
// index.
//
// books.chapter_count is deliberately left alone. A PDF has no chapters, and
// that column is what tells SetProgress to measure a PDF's progress by page
// rather than by chapter weight — writing a count here would silently change
// how far through the book every PDF reader appears to be.
func IndexPdfPages(ctx context.Context, d *DB, bookID int64, pages []string) error {
	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Wrap("db", err)
	}
	defer tx.Rollback()

	// Replace wholesale: re-indexing a book that was indexed by an older
	// extraction must not leave the old rows beside the new ones. The FTS rows
	// go with them, by trigger.
	if _, err := tx.ExecContext(ctx, `DELETE FROM chapters WHERE book_id = ?1`, bookID); err != nil {
		return apperr.Wrap("db", err)
	}
	for i, text := range pages {
		body := strings.TrimSpace(text)
		if body == "" {
			continue // a page of pictures indexes nothing
		}
		res, err := tx.ExecContext(ctx, `
			INSERT INTO chapters (book_id, idx, title, level, href, html, text, char_count)
			VALUES (?1, ?2, '', 0, '', '', ?3, ?4)`,
			bookID, i, body, len([]rune(body)))
		if err != nil {
			return apperr.Wrap("db", err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			return apperr.Wrap("db", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO chapters_fts(rowid, title, body) VALUES (?1, '', ?2)`,
			id, searchText(body)); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// HasIndexedPages reports whether a book already has its text indexed, so a
// PDF is read for its text once rather than on every open.
func HasIndexedPages(ctx context.Context, q Querier, bookID int64) (bool, error) {
	var n int64
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM chapters WHERE book_id = ?1`, bookID).Scan(&n); err != nil {
		return false, apperr.Wrap("db", err)
	}
	return n > 0, nil
}

// SetProgress records where reading stopped and recomputes whole-book percent.
//
// For chaptered books percent weighs each chapter by its length, so a long
// chapter does not advance the bar as fast as a short one. For PDF, whose
// chapters are not extracted, it is simply the page position.
func SetProgress(ctx context.Context, q Querier, bookID, chapterIndex int64, ratio float64, page int64) error {
	if ratio < 0 {
		ratio = 0
	} else if ratio > 1 {
		ratio = 1
	}
	// Total and prefix character counts come from one pass over the book's
	// chapters instead of four repeated subqueries: SetProgress runs on every
	// scroll settle, and on a long book the old form scanned the chapters table
	// three times per save. The current chapter's count is a UNIQUE(book_id,
	// idx) point lookup, so it stays out of the scan.
	_, err := q.ExecContext(ctx, `
		WITH book_info AS (
			SELECT page_count, chapter_count FROM books WHERE id = ?1
		),
		chars AS (
			SELECT
				COALESCE(SUM(char_count), 0) AS total,
				COALESCE(SUM(CASE WHEN idx < ?2 THEN char_count ELSE 0 END), 0) AS prefix
			FROM chapters WHERE book_id = ?1
		)
		INSERT INTO reading_progress (book_id, chapter_index, chapter_ratio, page, percent, updated_at)
		VALUES (
			?1, ?2, ?3, ?4,
			CASE
				WHEN (SELECT page_count FROM book_info) > 0
				     AND (SELECT chapter_count FROM book_info) = 0
				THEN MIN(1.0, MAX(0.0, CAST(?4 AS REAL) / (SELECT page_count FROM book_info)))
				WHEN (SELECT total FROM chars) > 0
				THEN MIN(1.0, MAX(0.0,
					((SELECT prefix FROM chars)
					 + ?3 * (SELECT COALESCE(char_count, 0) FROM chapters WHERE book_id = ?1 AND idx = ?2))
					/ (SELECT CAST(total AS REAL) FROM chars)))
				ELSE 0
			END,
			datetime('now')
		)
		ON CONFLICT(book_id) DO UPDATE SET
			chapter_index = excluded.chapter_index,
			chapter_ratio = excluded.chapter_ratio,
			page          = excluded.page,
			percent       = excluded.percent,
			updated_at    = excluded.updated_at`,
		bookID, chapterIndex, ratio, page)
	if err != nil {
		return apperr.Wrap("db", err)
	}
	if _, err := q.ExecContext(ctx, `UPDATE books SET last_read_at = datetime('now') WHERE id = ?1`, bookID); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// GetProgress returns a book's saved reading position.
func GetProgress(ctx context.Context, q Querier, bookID int64) (models.Progress, error) {
	var p models.Progress
	err := q.QueryRowContext(ctx,
		`SELECT chapter_index, chapter_ratio, page, percent, updated_at
		 FROM reading_progress WHERE book_id = ?1`, bookID).
		Scan(&p.ChapterIndex, &p.ChapterRatio, &p.Page, &p.Percent, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Progress{Page: 1}, nil
	}
	if err != nil {
		return p, apperr.Wrap("db", err)
	}
	return p, nil
}

// SetBookFlag toggles one of the book's boolean states ("finished" or
// "favorite"). Marking a book finished also pins its progress bar to full, so
// the library never shows a finished book at 87%.
func SetBookFlag(ctx context.Context, q Querier, bookID int64, flag string, on bool) error {
	column := ""
	switch flag {
	case "finished":
		column = "is_finished"
	case "favorite":
		column = "is_favorite"
	default:
		return apperr.Codef("invalidInput", "unknown book flag %q", flag)
	}
	if _, err := q.ExecContext(ctx,
		fmt.Sprintf(`UPDATE books SET %s = ?2 WHERE id = ?1`, column), bookID, on); err != nil {
		return apperr.Wrap("db", err)
	}
	if flag == "finished" && on {
		if _, err := q.ExecContext(ctx,
			`UPDATE reading_progress SET percent = 1.0 WHERE book_id = ?1`, bookID); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	return nil
}

// SetBookCollection moves a book onto a shelf, or off every shelf when
// collectionID is nil.
func SetBookCollection(ctx context.Context, q Querier, bookID int64, collectionID *int64) error {
	if _, err := q.ExecContext(ctx, `UPDATE books SET collection_id = ?2 WHERE id = ?1`, bookID, collectionID); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// UpdateBookMeta corrects the title and author, which for a text file or an
// untagged PDF is often whatever the file name happened to be.
func UpdateBookMeta(ctx context.Context, q Querier, bookID int64, title, author string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return apperr.Code("emptyTitle")
	}
	tl, al := searchTextFor(title, strings.TrimSpace(author))
	if _, err := q.ExecContext(ctx,
		`UPDATE books SET title = ?2, author = ?3, title_lower = ?4, author_lower = ?5 WHERE id = ?1`,
		bookID, title, nz(strOrNil(strings.TrimSpace(author))), tl, al); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// SetPDFMetadata records what pdf.js learned when it first opened a PDF: the
// real page count, and a cover rendered from page one. The Go side cannot get
// either without a PDF rasterizer, so the frontend backfills them.
func SetPDFMetadata(ctx context.Context, q Querier, bookID int64, pageCount int64, title, author string, cover []byte, coverMime string) error {
	if pageCount > 0 {
		if _, err := q.ExecContext(ctx, `UPDATE books SET page_count = ?2 WHERE id = ?1`, bookID, pageCount); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	if len(cover) > 0 {
		if _, err := q.ExecContext(ctx,
			`UPDATE books SET cover = ?2, cover_mime = ?3 WHERE id = ?1 AND cover IS NULL`,
			bookID, cover, coverMime); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	// Only fill in metadata the file itself did not carry: a title the user has
	// since corrected must not be overwritten by the PDF's own /Info.
	// The conditional title / author updates must keep the lowercased filter
	// columns in step with the column they change; unicode_lower here is the
	// same strings.ToLower the Go write paths use, so the stored values stay
	// byte-identical to searchTextFor.
	if t := strings.TrimSpace(title); t != "" {
		if _, err := q.ExecContext(ctx,
			`UPDATE books SET title = ?2, title_lower = unicode_lower(?2)
			 WHERE id = ?1 AND title = file_name`, bookID, t); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	if a := strings.TrimSpace(author); a != "" {
		if _, err := q.ExecContext(ctx,
			`UPDATE books SET author = ?2, author_lower = unicode_lower(?2)
			 WHERE id = ?1 AND (author IS NULL OR author = '')`, bookID, a); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	return nil
}

// DeleteBook removes a book and everything hanging off it. Chapters, resources,
// highlights, bookmarks, progress and tag links all cascade; the FTS rows go
// with the chapters through a trigger.
func DeleteBook(ctx context.Context, q Querier, bookID int64) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM books WHERE id = ?1`, bookID); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// LibraryCounts are the numbers beside the sidebar's smart shelves.
type LibraryCounts struct {
	All        int64 `json:"all"`
	Reading    int64 `json:"reading"`
	Finished   int64 `json:"finished"`
	Favorite   int64 `json:"favorite"`
	Highlights int64 `json:"highlights"`
}

// CountLibrary returns the sidebar counts in one round trip.
func CountLibrary(ctx context.Context, q Querier) (LibraryCounts, error) {
	var c LibraryCounts
	err := q.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(*) FROM books),
			(SELECT COUNT(*) FROM books b JOIN reading_progress p ON p.book_id = b.id
			 WHERE b.is_finished = 0 AND p.percent > 0),
			(SELECT COUNT(*) FROM books WHERE is_finished = 1),
			(SELECT COUNT(*) FROM books WHERE is_favorite = 1),
			(SELECT COUNT(*) FROM highlights)`).
		Scan(&c.All, &c.Reading, &c.Finished, &c.Favorite, &c.Highlights)
	if err != nil {
		return c, apperr.Wrap("db", err)
	}
	return c, nil
}

// SearchLibrary runs full-text search across every chapter of every book,
// returning the best-ranked passages with the query highlighted.
func SearchLibrary(ctx context.Context, q Querier, text string, bookID *int64, limit int64) ([]models.SearchHit, error) {
	match := ftsQuery(text)
	if match == `""` {
		return []models.SearchHit{}, nil
	}
	where := "chapters_fts MATCH ?1"
	binds := []any{match, limit}
	if bookID != nil {
		where += " AND c.book_id = ?3"
		binds = append(binds, *bookID)
	}
	rows, err := q.QueryContext(ctx, fmt.Sprintf(`
		SELECT c.book_id, b.title, c.idx, c.title,
		       snippet(chapters_fts, 1, '<mark>', '</mark>', '…', 24)
		FROM chapters_fts
		JOIN chapters c ON c.id = chapters_fts.rowid
		JOIN books b    ON b.id = c.book_id
		WHERE %s
		ORDER BY chapters_fts.rank
		LIMIT ?2`, where), binds...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()

	out := []models.SearchHit{}
	for rows.Next() {
		var h models.SearchHit
		if err := rows.Scan(&h.BookID, &h.BookTitle, &h.ChapterIndex, &h.ChapterTitle, &h.Snippet); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		// The indexed body has CJK split character by character; undo that in
		// the snippet so the passage reads normally.
		h.Snippet = unsplitCJK(h.Snippet)
		out = append(out, h)
	}
	return out, rows.Err()
}

// cjkSep is what searchText puts between two CJK characters to make them
// separate FTS tokens: U+2063 INVISIBLE SEPARATOR. A plain space would work as
// a token boundary too, but it would then be indistinguishable from the spaces
// the book itself contains, and stripping it back out of a snippet would eat
// the author's own spacing. This character never occurs in real prose, so
// removing every one of them restores the passage exactly.
const cjkSep = '\u2063'

// searchText prepares text for the FTS index by separating adjacent CJK
// characters.
//
// unicode61 splits on punctuation and spaces, which Chinese, Japanese and
// Korean text does not use between words: a whole paragraph of Han indexes as a
// single token, and only an exact match of that entire paragraph would find it.
// Indexing each character as its own token — and querying the same way, as a
// phrase — turns FTS5 into a working CJK substring search without a dictionary
// or an ICU build.
func searchText(s string) string {
	var b strings.Builder
	b.Grow(len(s) + len(s)/2)
	var prev rune
	prevCJK := false
	for _, r := range s {
		cjk := isCJK(r)
		// A boundary needs a separator whenever either side is CJK: between two
		// CJK characters, and where CJK meets Latin or punctuation.
		if (cjk || prevCJK) && prev != 0 {
			b.WriteRune(cjkSep)
		}
		b.WriteRune(r)
		prev, prevCJK = r, cjk
	}
	return b.String()
}

// unsplitCJK reverses searchText for display, removing the separators FTS5
// hands back inside a snippet.
func unsplitCJK(s string) string {
	return strings.ReplaceAll(s, string(cjkSep), "")
}

// searchTextFor builds the lowercased title/author pair stored in
// books.title_lower / author_lower. ListBooks's substring filter compares
// against these byte for byte, which reproduces the old per-row
// `unicode_lower(title) LIKE ? OR unicode_lower(author) LIKE ?` matching —
// Go's strings.ToLower, once at write time, instead of a scalar-function call
// across the driver boundary for every row of every keystroke.
func searchTextFor(title, author string) (titleLower, authorLower string) {
	return strings.ToLower(title), strings.ToLower(author)
}

// ftsQuery turns raw user text into a safe FTS5 MATCH expression. Latin words
// become prefix terms; a run of CJK becomes a quoted phrase of its individual
// characters, which matches the way searchText indexed it.
func ftsQuery(input string) string {
	var terms []string
	var cjk []rune
	flushCJK := func() {
		if len(cjk) == 0 {
			return
		}
		spaced := make([]string, len(cjk))
		for i, r := range cjk {
			spaced[i] = string(r)
		}
		terms = append(terms, `"`+strings.Join(spaced, " ")+`"`)
		cjk = nil
	}

	var word []rune
	flushWord := func() {
		if len(word) == 0 {
			return
		}
		terms = append(terms, `"`+string(word)+`"*`)
		word = nil
	}

	for _, r := range input {
		switch {
		case isCJK(r):
			flushWord()
			cjk = append(cjk, r)
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			flushCJK()
			word = append(word, r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()

	if len(terms) == 0 {
		return `""`
	}
	return strings.Join(terms, " ")
}

// isCJK reports whether r is a character from a script written without spaces
// between words.
func isCJK(r rune) bool {
	switch {
	case r >= 0x4E00 && r <= 0x9FFF, // CJK Unified Ideographs
		r >= 0x3400 && r <= 0x4DBF, // Extension A
		r >= 0xF900 && r <= 0xFAFF, // Compatibility Ideographs
		r >= 0x3040 && r <= 0x30FF, // Hiragana + Katakana
		r >= 0xAC00 && r <= 0xD7AF: // Hangul syllables
		return true
	}
	return false
}

// ListBookmarks returns a book's bookmarks in reading order.
func ListBookmarks(ctx context.Context, q Querier, bookID int64) ([]models.Bookmark, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT id, book_id, chapter_index, chapter_ratio, page, label, created_at
		 FROM bookmarks WHERE book_id = ?1 ORDER BY chapter_index, chapter_ratio, id`, bookID)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []models.Bookmark{}
	for rows.Next() {
		var b models.Bookmark
		var page sql.Null[int64]
		if err := rows.Scan(&b.ID, &b.BookID, &b.ChapterIndex, &b.ChapterRatio, &page, &b.Label, &b.CreatedAt); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		b.Page = nullPtr(page)
		out = append(out, b)
	}
	return out, rows.Err()
}

// InsertBookmark saves a position and returns the new bookmark's id.
func InsertBookmark(ctx context.Context, q Querier, bookID, chapterIndex int64, ratio float64, page *int64, label string) (int64, error) {
	res, err := q.ExecContext(ctx,
		`INSERT INTO bookmarks (book_id, chapter_index, chapter_ratio, page, label)
		 VALUES (?1, ?2, ?3, ?4, ?5)`,
		bookID, chapterIndex, ratio, nz(page), strings.TrimSpace(label))
	if err != nil {
		return 0, apperr.Wrap("db", err)
	}
	return res.LastInsertId()
}

// DeleteBookmark removes a bookmark.
func DeleteBookmark(ctx context.Context, q Querier, id int64) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM bookmarks WHERE id = ?1`, id); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// SetChapterAISummary caches a completed AI summary on a chapter.
func SetChapterAISummary(ctx context.Context, q Querier, bookID, index int64, summary string) error {
	if _, err := q.ExecContext(ctx,
		`UPDATE chapters SET ai_summary = ?3 WHERE book_id = ?1 AND idx = ?2`,
		bookID, index, summary); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// RAGHit is one chapter retrieved as context for an AI question: enough to cite
// it, plus a bounded excerpt to put in the prompt.
type RAGHit struct {
	BookID       int64  `json:"bookId"`
	BookTitle    string `json:"bookTitle"`
	ChapterIndex int64  `json:"chapterIndex"`
	ChapterTitle string `json:"chapterTitle"`
	// Excerpt is the chapter's cached AI summary when it has one, otherwise the
	// opening of its text, capped at excerptChars.
	Excerpt string `json:"excerpt"`
}

// SearchChaptersForRAG retrieves the chapters most relevant to a question, as
// context for AIService.Ask. Terms are OR-joined: recall matters more than
// precision when the hits are only being fed to a model.
func SearchChaptersForRAG(ctx context.Context, q Querier, question string, bookID *int64, limit, excerptChars int64) ([]RAGHit, error) {
	match := ftsQuery(question)
	if match == `""` {
		return []RAGHit{}, nil
	}
	// ftsQuery AND-joins terms for explicit search; retrieval wants OR.
	match = strings.ReplaceAll(match, `" "`, `" OR "`)

	where := "chapters_fts MATCH ?2"
	binds := []any{excerptChars, match, limit}
	if bookID != nil {
		where += " AND c.book_id = ?4"
		binds = append(binds, *bookID)
	}
	rows, err := q.QueryContext(ctx, fmt.Sprintf(`
		SELECT c.book_id, b.title, c.idx, c.title,
		       COALESCE(NULLIF(c.ai_summary, ''), SUBSTR(c.text, 1, ?1))
		FROM chapters_fts
		JOIN chapters c ON c.id = chapters_fts.rowid
		JOIN books b    ON b.id = c.book_id
		WHERE %s
		ORDER BY chapters_fts.rank
		LIMIT ?3`, where), binds...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return scanRAGHits(rows)
}

// RecentChaptersForRAG is the fallback context when a question carries no
// searchable terms ("what should I read next?"): the chapters of the books most
// recently opened.
func RecentChaptersForRAG(ctx context.Context, q Querier, bookID *int64, limit, excerptChars int64) ([]RAGHit, error) {
	where := "1=1"
	binds := []any{excerptChars, limit}
	if bookID != nil {
		where = "c.book_id = ?3"
		binds = append(binds, *bookID)
	}
	rows, err := q.QueryContext(ctx, fmt.Sprintf(`
		SELECT c.book_id, b.title, c.idx, c.title,
		       COALESCE(NULLIF(c.ai_summary, ''), SUBSTR(c.text, 1, ?1))
		FROM chapters c
		JOIN books b ON b.id = c.book_id
		WHERE %s
		ORDER BY COALESCE(b.last_read_at, b.added_at) DESC, c.idx
		LIMIT ?2`, where), binds...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return scanRAGHits(rows)
}

func scanRAGHits(rows *sql.Rows) ([]RAGHit, error) {
	defer rows.Close()
	out := []RAGHit{}
	for rows.Next() {
		var h RAGHit
		if err := rows.Scan(&h.BookID, &h.BookTitle, &h.ChapterIndex, &h.ChapterTitle, &h.Excerpt); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// GetChapterTranslation returns a cached translation, if one exists for this
// chapter in this language from this engine.
func GetChapterTranslation(ctx context.Context, q Querier, bookID, index int64, lang, engine string) (*models.ChapterTranslation, error) {
	var t models.ChapterTranslation
	var title sql.Null[string]
	err := q.QueryRowContext(ctx,
		`SELECT title, html FROM chapter_translations
		 WHERE book_id = ?1 AND chapter_index = ?2 AND lang = ?3 AND engine = ?4`,
		bookID, index, lang, engine).Scan(&title, &t.HTML)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	t.Title = nullPtr(title)
	t.Lang, t.Engine = lang, engine
	return &t, nil
}

// UpsertChapterTranslation caches a completed translation.
func UpsertChapterTranslation(ctx context.Context, q Querier, bookID, index int64, lang, engine string, title *string, html string) error {
	if _, err := q.ExecContext(ctx,
		`INSERT INTO chapter_translations (book_id, chapter_index, lang, engine, title, html)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		 ON CONFLICT(book_id, chapter_index, lang, engine)
		 DO UPDATE SET title = excluded.title, html = excluded.html, created_at = datetime('now')`,
		bookID, index, lang, engine, nz(title), html); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}
