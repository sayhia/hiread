// Package db is hiread's SQLite data layer. One file holds feeds, articles, the
// FTS5 index and settings. All SQL lives in this package; services call typed
// functions, never raw SQL.
//
// The modernc.org/sqlite database/sql driver is used here: the writer pool is
// capped at a single connection so writes serialize automatically, while a
// separate reader pool runs concurrent queries under WAL.
package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"strings"
	"sync"

	sqlite "modernc.org/sqlite"
)

// Querier is satisfied by *sql.DB, *sql.Tx and *sql.Conn, so query functions
// work against either a pool or an open transaction.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// DB bundles the serialized writer pool and the concurrent reader pool. Both
// point at the same database file; under WAL the readers never block on the
// writer.
type DB struct {
	W    *sql.DB // writer — capped at one connection
	R    *sql.DB // readers — concurrent, query_only
	path string
}

// registerOnce guards the driver-global scalar-function registration.
var registerOnce sync.Once

// registerFunctions installs hiread's custom SQL scalar functions on the driver.
//
// SQLite's built-in LOWER() only case-folds ASCII (no Unicode without the ICU
// extension, which the bundled build omits). Go's strings.ToLower is fully
// Unicode-aware. Anywhere a query must match the case-folding the Go code does
// — notably preview_rule, which has to agree with rule_matches's ToLower so the
// rule preview counts exactly the articles live ingestion would act on —
// unicode_lower provides it. modernc registers scalar functions globally on the
// driver, so this runs once for every connection (writer and each reader).
func registerFunctions() {
	registerOnce.Do(func() {
		sqlite.MustRegisterDeterministicScalarFunction(
			"unicode_lower",
			1,
			func(ctx *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
				// A NULL argument folds to NULL; callers COALESCE beforehand,
				// but staying total here keeps the function safe to use bare.
				if args[0] == nil {
					return nil, nil
				}
				switch v := args[0].(type) {
				case string:
					return strings.ToLower(v), nil
				case []byte:
					return strings.ToLower(string(v)), nil
				default:
					return args[0], nil
				}
			},
		)
	})
}

// Open opens (creating if needed) the database at path, runs migrations to the
// latest version, and returns a ready DB with both pools wired. The writer sets
// WAL mode (persisted in the database header, so readers inherit it).
func Open(path string) (*DB, error) {
	registerFunctions()

	// Writer: WAL + foreign keys + NORMAL sync + a busy timeout. Capped at one
	// open connection so writes serialize.
	writerDSN := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)",
		path,
	)
	w, err := sql.Open("sqlite", writerDSN)
	if err != nil {
		return nil, fmt.Errorf("open writer: %w", err)
	}
	w.SetMaxOpenConns(1)

	// Readers: query_only is a safety net against an accidental write on a
	// pooled reader. Under WAL these run concurrently with the writer.
	readerDSN := fmt.Sprintf(
		"file:%s?_pragma=busy_timeout(5000)&_pragma=query_only(true)",
		path,
	)
	r, err := sql.Open("sqlite", readerDSN)
	if err != nil {
		_ = w.Close()
		return nil, fmt.Errorf("open readers: %w", err)
	}
	r.SetMaxOpenConns(readPoolSize)

	d := &DB{W: w, R: r, path: path}
	if err := d.migrate(context.Background()); err != nil {
		_ = d.Close()
		return nil, err
	}
	if err := d.backfillSearchText(context.Background()); err != nil {
		_ = d.Close()
		return nil, err
	}
	return d, nil
}

// readPoolSize is the number of concurrent read-only connections for UI queries.
const readPoolSize = 4

// Close releases both connection pools.
func (d *DB) Close() error {
	var first error
	if d.R != nil {
		if err := d.R.Close(); err != nil {
			first = err
		}
	}
	if d.W != nil {
		if err := d.W.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// backfillSearchText fills books.title_lower / author_lower for rows written
// before the v3 migration added the columns. It runs once after migrate on
// open: new and edited rows are kept in step by the write paths themselves
// (ImportBook, UpdateBookMeta, SetPDFMetadata). The two columns are always
// written together, so a non-empty title_lower marks a row as already
// backfilled — the select keys on title_lower alone, which makes the pass
// one-shot instead of re-selecting author-less rows on every open. A row whose
// title is genuinely empty stays selected and is harmlessly rewritten.
func (d *DB) backfillSearchText(ctx context.Context) error {
	rows, err := d.R.QueryContext(ctx,
		`SELECT id, title, COALESCE(author, '') FROM books WHERE title_lower = ''`)
	if err != nil {
		return fmt.Errorf("backfill search_text: %w", err)
	}
	defer rows.Close()
	var pending []struct {
		id     int64
		title  string
		author string
	}
	for rows.Next() {
		var r struct {
			id     int64
			title  string
			author string
		}
		if err := rows.Scan(&r.id, &r.title, &r.author); err != nil {
			return fmt.Errorf("backfill search_text: %w", err)
		}
		pending = append(pending, r)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("backfill search_text: %w", err)
	}
	for _, r := range pending {
		tl, al := searchTextFor(r.title, r.author)
		if _, err := d.W.ExecContext(ctx,
			`UPDATE books SET title_lower = ?2, author_lower = ?3 WHERE id = ?1`,
			r.id, tl, al); err != nil {
			return fmt.Errorf("backfill search_text: %w", err)
		}
	}
	return nil
}

// migrate applies every pending migration in order, tracking progress in the
// SQLite user_version pragma. Migrations are append-only: never edit a shipped
// migration — add a new one.
func (d *DB) migrate(ctx context.Context) error {
	conn, err := d.W.Conn(ctx)
	if err != nil {
		return fmt.Errorf("migrate: acquire conn: %w", err)
	}
	defer conn.Close()

	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("migrate: read user_version: %w", err)
	}
	if version >= len(migrations) {
		return nil
	}
	for i := version; i < len(migrations); i++ {
		if _, err := conn.ExecContext(ctx, migrations[i]); err != nil {
			return fmt.Errorf("migrate: apply v%d: %w", i+1, err)
		}
	}
	// PRAGMA user_version does not accept a bound parameter.
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", len(migrations))); err != nil {
		return fmt.Errorf("migrate: set user_version: %w", err)
	}
	return nil
}
