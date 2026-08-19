package fonts

import (
	"os"
	"strings"

	"golang.org/x/image/font/sfnt"
)

// FamilyName reads the typographic family name from a font file's `name` table.
//
// This matters because an @font-face only renders if its font-family exactly
// matches the face's internal name — so we read the real name rather than make
// the user type it (and risk a silent no-render). Works for ttf/otf (and the
// first face of a ttc); woff/woff2 are compressed and unsupported here, so the
// caller falls back to a user-supplied name for those.
func FamilyName(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	f, err := sfnt.Parse(data)
	if err != nil {
		// Try a font collection (.ttc) before giving up.
		c, cerr := sfnt.ParseCollection(data)
		if cerr != nil || c.NumFonts() == 0 {
			return "", err
		}
		if f, err = c.Font(0); err != nil {
			return "", err
		}
	}
	var buf sfnt.Buffer
	name, err := f.Name(&buf, sfnt.NameIDTypographicFamily)
	if err != nil || strings.TrimSpace(name) == "" {
		// Fall back to the legacy family name (ID 1) when the typographic one
		// (ID 16) is absent.
		name, err = f.Name(&buf, sfnt.NameIDFamily)
		if err != nil {
			return "", err
		}
	}
	return strings.TrimSpace(name), nil
}
