package db

import (
	"context"

	"hiread/internal/apperr"
)

// InstalledFont is one downloaded font tracked in the installed_fonts table.
// Files live in <dataDir>/fonts and are served to the webview at
// /userfonts/<file>; the frontend registers an @font-face per row on startup.
type InstalledFont struct {
	ID       string `json:"id"`
	Family   string `json:"family"`
	Label    string `json:"label"`
	Category string `json:"category"`
	CJK      bool   `json:"cjk"`
	Axis     string `json:"axis"`
	License  string `json:"license"`
	Source   string `json:"source"`
	File     string `json:"file"`
	Ext      string `json:"ext"`
	Bytes    int64  `json:"bytes"`
}

// ListInstalledFonts returns all downloaded fonts, oldest first.
func ListInstalledFonts(ctx context.Context, q Querier) ([]InstalledFont, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT id, family, label, category, cjk, axis, license, source, file, ext, bytes
		 FROM installed_fonts ORDER BY installed_at, id`)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	out := []InstalledFont{}
	for rows.Next() {
		var f InstalledFont
		if err := rows.Scan(&f.ID, &f.Family, &f.Label, &f.Category, &f.CJK,
			&f.Axis, &f.License, &f.Source, &f.File, &f.Ext, &f.Bytes); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// UpsertInstalledFont records (or refreshes) a downloaded font.
func UpsertInstalledFont(ctx context.Context, q Querier, f InstalledFont) error {
	_, err := q.ExecContext(ctx,
		`INSERT INTO installed_fonts
			(id, family, label, category, cjk, axis, license, source, file, ext, bytes)
		 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
		 ON CONFLICT(id) DO UPDATE SET
			family=excluded.family, label=excluded.label, category=excluded.category,
			cjk=excluded.cjk, axis=excluded.axis, license=excluded.license,
			source=excluded.source, file=excluded.file, ext=excluded.ext, bytes=excluded.bytes`,
		f.ID, f.Family, f.Label, f.Category, f.CJK, f.Axis, f.License, f.Source, f.File, f.Ext, f.Bytes)
	if err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// DeleteInstalledFont removes a font row and returns its on-disk file name so
// the caller can delete the file. Returns "" if the id was not installed.
func DeleteInstalledFont(ctx context.Context, q Querier, id string) (string, error) {
	var file string
	err := q.QueryRowContext(ctx, "SELECT file FROM installed_fonts WHERE id = ?1", id).Scan(&file)
	if err != nil {
		// Not found is not an error — nothing to delete.
		return "", nil
	}
	if _, err := q.ExecContext(ctx, "DELETE FROM installed_fonts WHERE id = ?1", id); err != nil {
		return "", apperr.Wrap("db", err)
	}
	return file, nil
}
