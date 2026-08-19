// Package fonts holds the asset middleware that serves downloaded fonts and a
// small validation helper. There is no built-in catalog: every downloadable
// font is added by the user via a direct URL (services/font.go AddCustomFont),
// stored under <dataDir>/fonts, and served at /userfonts/<file>.
package fonts

import "strings"

// SafeBasename validates a font id so it can be used as an on-disk file name and
// in a /userfonts/ URL — letters, digits, dot, dash, underscore only. Returns ""
// for anything else, so an id can't escape the fonts directory.
func SafeBasename(id string) string {
	if id == "" || len(id) > 80 {
		return ""
	}
	for _, r := range id {
		ok := r == '-' || r == '_' || r == '.' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !ok {
			return ""
		}
	}
	if strings.Contains(id, "..") {
		return ""
	}
	return id
}
