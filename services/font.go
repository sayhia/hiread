package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"hiread/internal/apperr"
	"hiread/internal/appstate"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/fonts"
)

// maxFontBytes caps a single download. CJK fonts run ~20 MB; 80 MiB leaves room
// for the largest legitimate face while stopping a runaway or hostile response
// from filling the disk.
const maxFontBytes = 80 * 1024 * 1024

// FontService exposes the font catalog and the download/install/remove commands
// for the font-switching feature. Downloaded files land in <dataDir>/fonts and
// are served to the webview by fonts.AssetMiddleware at /userfonts/<file>.
type FontService struct {
	app *appstate.State
}

// ListInstalled returns the fonts the user has downloaded into the app data dir.
func (s *FontService) ListInstalled() ([]db.InstalledFont, error) {
	return db.ListInstalledFonts(bg(), s.app.DB.R)
}

// AddCustomFont downloads an arbitrary open-source font by URL (e.g. a GitHub
// release asset), letting users add fonts beyond the curated catalog. The id is
// derived from the URL so re-adding the same URL updates in place.
func (s *FontService) AddCustomFont(ctx context.Context, url, family, axis, streamID string) error {
	url = strings.TrimSpace(url)
	if !strings.HasPrefix(url, "https://") {
		return apperr.Code("fontBadURL")
	}
	// An empty family is fine: fetch auto-detects it from the downloaded file
	// (and re-prompts via "fontNeedsFamily" only when detection can't, e.g. woff2).
	family = strings.TrimSpace(family)
	if axis != "ui" && axis != "reader" {
		axis = "both"
	}
	sum := sha256.Sum256([]byte(url))
	id := "custom-" + hex.EncodeToString(sum[:])[:10]
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(url), "."))
	switch ext {
	case "woff2", "woff", "ttf", "otf":
	default:
		ext = "ttf"
	}
	return s.fetch(ctx, db.InstalledFont{
		ID: id, Family: family, Label: family, Category: "sans",
		Axis: axis, License: "custom", Source: url, Ext: ext,
	}, url, streamID)
}

// DeleteFont removes a downloaded font's record and file.
func (s *FontService) DeleteFont(id string) error {
	file, err := db.DeleteInstalledFont(bg(), s.app.DB.W, id)
	if err != nil {
		return err
	}
	if base := fonts.SafeBasename(file); base != "" {
		_ = os.Remove(filepath.Join(s.app.DataDir(), "fonts", base))
	}
	return nil
}

// fetch streams `url` to <dataDir>/fonts/<id>.<ext>, reporting progress, then
// records the font as installed. It writes to a temp file and renames on success
// so a cancelled or failed download never leaves a half-written face in place.
func (s *FontService) fetch(ctx context.Context, meta db.InstalledFont, url, streamID string) error {
	base := fonts.SafeBasename(meta.ID)
	if base == "" {
		return apperr.Code("fontNotFound")
	}
	meta.File = base + "." + meta.Ext

	dir := filepath.Join(s.app.DataDir(), "fonts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return apperr.Wrap("fs", err)
	}

	seq := events.NewSequencer("font:" + streamID)
	emit := func(received, total int64, done bool, errMsg string) {
		seq.Emit(map[string]any{
			"id": meta.ID, "received": received, "total": total, "done": done, "error": errMsg,
		})
	}
	fail := func(err error) error {
		emit(0, 0, false, err.Error())
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fail(apperr.Wrap("network", err))
	}
	resp, err := s.app.HTTP().Do(req)
	if err != nil {
		return fail(apperr.Wrap("network", err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fail(apperr.Codef("fontDownload", "download failed: HTTP %d", resp.StatusCode))
	}

	tmp, err := os.CreateTemp(dir, ".dl-*")
	if err != nil {
		return fail(apperr.Wrap("fs", err))
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed away

	total := resp.ContentLength
	buf := make([]byte, 64*1024)
	var received int64
	for {
		if ctx.Err() != nil {
			tmp.Close()
			return nil // cancelled (panel closed) — leave nothing installed
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				tmp.Close()
				return fail(apperr.Wrap("fs", werr))
			}
			received += int64(n)
			if received > maxFontBytes {
				tmp.Close()
				return fail(apperr.Code("fontTooLarge"))
			}
			emit(received, total, false, "")
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			return fail(apperr.Wrap("network", rerr))
		}
	}
	if err := tmp.Close(); err != nil {
		return fail(apperr.Wrap("fs", err))
	}
	dest := filepath.Join(dir, meta.File)
	if err := os.Rename(tmpName, dest); err != nil {
		return fail(apperr.Wrap("fs", err))
	}

	// Auto-detect the real font-family when the caller didn't supply one, so the
	// @font-face name matches the face and it actually renders. Detection fails
	// for woff/woff2 (compressed); the UI then re-prompts for a manual name.
	if meta.Family == "" {
		fam, derr := fonts.FamilyName(dest)
		if derr != nil || strings.TrimSpace(fam) == "" {
			_ = os.Remove(dest)
			return fail(apperr.Code("fontNeedsFamily"))
		}
		meta.Family = fam
	}
	if meta.Label == "" {
		meta.Label = meta.Family
	}

	meta.Bytes = received
	if err := db.UpsertInstalledFont(ctx, s.app.DB.W, meta); err != nil {
		return fail(err)
	}
	emit(received, total, true, "")
	return nil
}
