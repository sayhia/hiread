package db

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"hiread/internal/apperr"
)

// GetSetting returns a setting's value, or nil when the key is absent.
func GetSetting(ctx context.Context, q Querier, key string) (*string, error) {
	var v string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?1", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return &v, nil
}

// GetSettings returns the values of the given keys in one round trip, so a
// caller resolving several knobs pays one query instead of one per key. Keys
// absent from the table are omitted from the map.
func GetSettings(ctx context.Context, q Querier, keys []string) (map[string]string, error) {
	if len(keys) == 0 {
		return map[string]string{}, nil
	}
	ph := make([]string, len(keys))
	args := make([]any, len(keys))
	for i, k := range keys {
		ph[i] = "?"
		args[i] = k
	}
	out := map[string]string{}
	rows, err := q.QueryContext(ctx,
		"SELECT key, value FROM settings WHERE key IN ("+strings.Join(ph, ",")+")", args...)
	if err != nil {
		return nil, apperr.Wrap("db", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, apperr.Wrap("db", err)
		}
		out[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Wrap("db", err)
	}
	return out, nil
}

// SetSetting upserts a setting value.
func SetSetting(ctx context.Context, q Querier, key, value string) error {
	if _, err := q.ExecContext(ctx,
		`INSERT INTO settings(key, value) VALUES (?1, ?2)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value); err != nil {
		return apperr.Wrap("db", err)
	}
	return nil
}

// SettingInt reads a setting and parses it as an int64, falling back to
// fallback when the key is missing, unreadable, or fails to parse.
func SettingInt(ctx context.Context, q Querier, key string, fallback int64) int64 {
	v, err := GetSetting(ctx, q, key)
	if err != nil || v == nil {
		return fallback
	}
	n, err := strconv.ParseInt(*v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

// SettingFlag reads a setting as a boolean flag — "1" and "true" are true,
// anything else (including a missing key) falls back to fallback.
func SettingFlag(ctx context.Context, q Querier, key string, fallback bool) bool {
	v, err := GetSetting(ctx, q, key)
	if err != nil || v == nil {
		return fallback
	}
	return *v == "1" || *v == "true"
}
