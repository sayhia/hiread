package db

// migrations is the append-only list of schema migrations. The slice index + 1
// is the schema version. Never edit a shipped migration — add a new one at the
// end.
//
// v1 is a single statement because hiread's library schema was designed whole:
// the app's RSS ancestry left no databases in the field to migrate from, so
// there was nothing to preserve and every table here starts from its final
// shape.
var migrations = []string{
	// v1 — the library: books and their chapters, the resources chapters
	// reference, where the reader left off, and the annotations laid over them.
	`
	CREATE TABLE collections (
		id       INTEGER PRIMARY KEY,
		name     TEXT NOT NULL,
		position INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE books (
		id            INTEGER PRIMARY KEY,
		title         TEXT NOT NULL,
		author        TEXT,
		language      TEXT,
		publisher     TEXT,
		description   TEXT,
		-- identifier is the ISBN / UUID / ASIN the file claims, kept for
		-- reference; file_hash is what actually detects a re-import.
		identifier    TEXT,
		published_at  TEXT,
		format        TEXT NOT NULL,
		file_name     TEXT NOT NULL,
		file_size     INTEGER NOT NULL DEFAULT 0,
		file_hash     TEXT NOT NULL,
		collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
		cover         BLOB,
		cover_mime    TEXT,
		chapter_count INTEGER NOT NULL DEFAULT 0,
		char_count    INTEGER NOT NULL DEFAULT 0,
		-- page_count and source_blob are for PDF, which the frontend renders
		-- from the original bytes rather than from extracted chapters.
		page_count    INTEGER NOT NULL DEFAULT 0,
		source_blob   BLOB,
		added_at      TEXT NOT NULL DEFAULT (datetime('now')),
		last_read_at  TEXT,
		is_finished   INTEGER NOT NULL DEFAULT 0,
		is_favorite   INTEGER NOT NULL DEFAULT 0
	);

	-- Importing the same file twice is a mistake, not an intent.
	CREATE UNIQUE INDEX idx_books_hash ON books(file_hash);
	CREATE INDEX idx_books_collection ON books(collection_id);
	CREATE INDEX idx_books_added ON books(added_at DESC);
	CREATE INDEX idx_books_last_read ON books(last_read_at DESC);

	CREATE TABLE chapters (
		id         INTEGER PRIMARY KEY,
		book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		idx        INTEGER NOT NULL,
		title      TEXT NOT NULL,
		level      INTEGER NOT NULL DEFAULT 0,
		href       TEXT,
		html       TEXT NOT NULL,
		text       TEXT NOT NULL,
		char_count INTEGER NOT NULL DEFAULT 0,
		-- A completed AI summary is cached here so reopening a chapter does not
		-- pay for the same completion twice.
		ai_summary TEXT,
		UNIQUE(book_id, idx)
	);

	-- Translated chapters, keyed by target language and engine. A chapter is
	-- long and translation is billed per token, so a re-read must never
	-- re-translate.
	CREATE TABLE chapter_translations (
		book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		chapter_index INTEGER NOT NULL,
		lang          TEXT    NOT NULL,
		engine        TEXT    NOT NULL,
		title         TEXT,
		html          TEXT    NOT NULL,
		created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (book_id, chapter_index, lang, engine)
	);

	CREATE TABLE book_resources (
		id      INTEGER PRIMARY KEY,
		book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		path    TEXT NOT NULL,
		mime    TEXT NOT NULL,
		data    BLOB NOT NULL,
		UNIQUE(book_id, path)
	);

	-- One row per book, written on every reader scroll settle. chapter_ratio
	-- is 0..1 within the chapter; percent is 0..1 through the whole book, kept
	-- denormalized so the library grid can show progress without reading
	-- chapter sizes.
	CREATE TABLE reading_progress (
		book_id       INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
		chapter_index INTEGER NOT NULL DEFAULT 0,
		chapter_ratio REAL    NOT NULL DEFAULT 0,
		page          INTEGER NOT NULL DEFAULT 1,
		percent       REAL    NOT NULL DEFAULT 0,
		updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE bookmarks (
		id            INTEGER PRIMARY KEY,
		book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		chapter_index INTEGER NOT NULL DEFAULT 0,
		chapter_ratio REAL    NOT NULL DEFAULT 0,
		page          INTEGER,
		label         TEXT    NOT NULL DEFAULT '',
		created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX idx_bookmarks_book ON bookmarks(book_id, chapter_index);

	-- A highlight is pinned to a span of a chapter's rendered plain text.
	-- text_offset plus prefix / suffix form a resilient anchor: the offset is
	-- tried first, the surrounding context second.
	CREATE TABLE highlights (
		id            INTEGER PRIMARY KEY,
		book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		chapter_index INTEGER NOT NULL DEFAULT 0,
		quote         TEXT    NOT NULL,
		prefix        TEXT    NOT NULL DEFAULT '',
		suffix        TEXT    NOT NULL DEFAULT '',
		text_offset   INTEGER NOT NULL DEFAULT 0,
		color         TEXT    NOT NULL DEFAULT 'yellow',
		note          TEXT    NOT NULL DEFAULT '',
		created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
	);
	CREATE INDEX idx_highlights_book ON highlights(book_id, chapter_index);

	CREATE TABLE tags (
		id       INTEGER PRIMARY KEY,
		name     TEXT NOT NULL UNIQUE,
		color    TEXT NOT NULL DEFAULT 'clay',
		position INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE book_tags (
		book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
		PRIMARY KEY (book_id, tag_id)
	);
	CREATE INDEX idx_book_tags_tag ON book_tags(tag_id);

	CREATE TABLE settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE installed_fonts (
		id           TEXT PRIMARY KEY,
		family       TEXT NOT NULL,
		label        TEXT NOT NULL,
		category     TEXT NOT NULL DEFAULT 'sans',
		cjk          INTEGER NOT NULL DEFAULT 0,
		axis         TEXT NOT NULL DEFAULT 'both',
		license      TEXT NOT NULL DEFAULT '',
		source       TEXT NOT NULL DEFAULT '',
		file         TEXT NOT NULL,
		ext          TEXT NOT NULL DEFAULT 'woff2',
		bytes        INTEGER NOT NULL DEFAULT 0,
		installed_at TEXT NOT NULL DEFAULT (datetime('now'))
	);

	-- Full-text search over chapters. The indexed columns are written by the
	-- Go layer (see searchText) with CJK runs split into single characters,
	-- because unicode61 treats an unbroken run of Han as one enormous token
	-- and would otherwise only ever match a whole chapter's worth of text.
	CREATE VIRTUAL TABLE chapters_fts USING fts5(
		title, body, tokenize = 'porter unicode61'
	);

	CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN
		DELETE FROM chapters_fts WHERE rowid = old.id;
	END;
	`,

	// v2 — denormalized title/author search column.
	//
	// ListBooks matches title / author with a leading-wildcard LIKE, which no
	// index can serve, so the filter used to call the unicode_lower scalar (a
	// Go function across the driver boundary) once per row on every keystroke.
	// search_text was meant to store the lowercased title+author so the filter
	// could be a plain byte comparison, backfilled on open for pre-v2 rows.
	//
	// NOTE: this migration shipped in an intermediate build and is therefore
	// frozen exactly as it ran there. Its single concatenated column turned out
	// wrong — SQLite LIKE stops at an embedded NUL, so no separator could keep
	// a title ending from being cut off or fusing onto an author beginning.
	// v3 replaces search_text with per-field columns; never edit v2.
	`
	ALTER TABLE books ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
	CREATE INDEX idx_books_finished ON books(is_finished);
	CREATE INDEX idx_books_favorite ON books(is_favorite);
	`,

	// v3 — per-field lowercased columns, replacing v2's search_text.
	//
	// Storing the lowercased title and author in their own columns reproduces
	// the old per-row `unicode_lower(title) LIKE ? OR unicode_lower(author)
	// LIKE ?` matching — the same strings.ToLower folding, once at write time
	// (ImportBook / UpdateBookMeta / SetPDFMetadata), with the filter a plain
	// byte comparison per row. search_text is dropped; the is_finished /
	// is_favorite indexes came in v2 and stay. backfillSearchText fills the new
	// columns on open.
	`
	ALTER TABLE books ADD COLUMN title_lower  TEXT NOT NULL DEFAULT '';
	ALTER TABLE books ADD COLUMN author_lower TEXT NOT NULL DEFAULT '';
	ALTER TABLE books DROP COLUMN search_text;
	`,
}
