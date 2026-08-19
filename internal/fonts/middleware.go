package fonts

import (
	"net/http"
	"path/filepath"
	"strings"
)

// URLPrefix is the webview path under which downloaded fonts are served. The
// frontend builds @font-face src as `/userfonts/<id>.<ext>`.
const URLPrefix = "/userfonts/"

// AssetMiddleware serves downloaded font files from <dataDir>/fonts at
// /userfonts/<file>, delegating every other request to the embedded asset
// handler. Wraps application.AssetOptions.Handler via AssetOptions.Middleware.
//
// http.FileServer(http.Dir) cleans the path and rejects "..", so a request can't
// escape the fonts directory; the explicit content-type avoids relying on the
// platform mime table (which often lacks woff2).
func AssetMiddleware(dataDir string) func(http.Handler) http.Handler {
	dir := filepath.Join(dataDir, "fonts")
	fileServer := http.StripPrefix(URLPrefix, http.FileServer(http.Dir(dir)))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, URLPrefix) {
				if ct := contentType(r.URL.Path); ct != "" {
					w.Header().Set("Content-Type", ct)
				}
				// Files are content-addressed by id; safe to cache hard.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				fileServer.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func contentType(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	}
	return ""
}
