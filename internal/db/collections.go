package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"hiread/internal/apperr"
	"hiread/internal/models"
)

// ListCollections returns every shelf ordered for the sidebar, each with the
// number of books on it. The count comes from one LEFT JOIN + GROUP BY instead
// of a correlated subquery per shelf.
func ListCollections(ctx context.Context, q Querier) ([]models.Collection, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT c.id, c.name, c.position, COUNT(b.id)
		 FROM collections c
		 LEFT JOIN books b ON b.collection_id = c.id
		 GROUP BY c.id, c.name, c.position
		 ORDER BY c.position, c.name`)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []models.Collection{}
	for rows.Next() {
		var c models.Collection
		if err := rows.Scan(&c.ID, &c.Name, &c.Position, &c.BookCount); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CreateCollection creates a shelf, or returns the existing one when a shelf
// with the same name (case-insensitively) is already present.
//
// collections.name carries no UNIQUE constraint, so without this guard two
// shelves named "Sci-Fi" — or "Sci-Fi" and "sci-fi" — could coexist. Mirrors
// CreateTag's case-insensitive dedup.
func CreateCollection(ctx context.Context, q Querier, name string) (int64, error) {
	// Trim before the dedup lookup and the insert: a name with surrounding
	// whitespace is a different string from its trimmed twin, so the COLLATE
	// NOCASE lookup would miss the existing shelf and spawn the near-duplicate
	// the dedup exists to prevent.
	name = strings.TrimSpace(name)
	if name == "" {
		return 0, apperr.Code("emptyCollectionName")
	}
	var id int64
	err := q.QueryRowContext(ctx,
		"SELECT id FROM collections WHERE name = ?1 COLLATE NOCASE", name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, apperr.Wrap("db", err)
	}
	res, err := q.ExecContext(ctx,
		"INSERT INTO collections(name, position) VALUES (?1, (SELECT COALESCE(MAX(position),0)+1 FROM collections))",
		name)
	if err != nil {
		return 0, apperr.Wrap("db", err)
	}
	return res.LastInsertId()
}

// RenameCollection renames a shelf, rejecting a name that collides with a
// different shelf (case-insensitively). Renaming a shelf to its own name (or a
// case change of it) is allowed.
func RenameCollection(ctx context.Context, q Querier, id int64, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return apperr.Code("emptyCollectionName")
	}
	var clash int64
	err := q.QueryRowContext(ctx,
		"SELECT id FROM collections WHERE name = ?1 COLLATE NOCASE AND id != ?2",
		name, id).Scan(&clash)
	if err == nil {
		return apperr.Code("collectionNameExists")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return apperr.Wrap("db", err)
	}
	if _, err := q.ExecContext(ctx,
		"UPDATE collections SET name = ?2 WHERE id = ?1", id, name); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// DeleteCollection removes a shelf. The books on it stay in the library with
// collection_id set to NULL (ON DELETE SET NULL) — deleting a shelf must never
// delete books.
func DeleteCollection(ctx context.Context, q Querier, id int64) error {
	if _, err := q.ExecContext(ctx, "DELETE FROM collections WHERE id = ?1", id); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// ReorderCollections applies a new sidebar order, given the shelf ids in the
// order they should appear.
func ReorderCollections(ctx context.Context, d *DB, ids []int64) error {
	tx, err := d.W.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Wrap("db", err)
	}
	defer tx.Rollback()
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx,
			"UPDATE collections SET position = ?2 WHERE id = ?1", id, i); err != nil {
			return apperr.Wrap("db", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}
