package db

import "database/sql"

// nz returns nil when p is nil, otherwise *p. Use it to bind an optional Go
// pointer as a SQL argument: a nil pointer becomes SQL NULL, a set pointer its
// value. (Passing a typed nil pointer directly does not bind as NULL.)
func nz[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// nullPtr converts a scanned sql.Null[T] into a *T: nil when the column was
// NULL, otherwise a pointer to the value. Pairs with the *T nullable fields on
// the model structs (which marshal nil to JSON null).
func nullPtr[T any](n sql.Null[T]) *T {
	if !n.Valid {
		return nil
	}
	v := n.V
	return &v
}

// deref returns the zero value when p is nil, otherwise *p.
func deref[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}

// strOrNil returns nil for an empty string, otherwise a pointer to it. Mirrors
// the Rust `.filter(|s| !s.is_empty())` guards on optional text.
func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
