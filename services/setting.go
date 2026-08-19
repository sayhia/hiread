package services

import (
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"hiread/internal/apperr"
	"hiread/internal/appicon"
	"hiread/internal/appstate"
	"hiread/internal/db"
)

// SettingService exposes the key/value settings store the frontend mirrors its
// preferences into.
type SettingService struct {
	app *appstate.State
}

// ApplyNetworkSettings rebuilds the HTTP client from the persisted proxy /
// timeout settings so the change takes effect without an app restart.
func (s *SettingService) ApplyNetworkSettings() error {
	ctx := bg()
	timeout := db.SettingInt(ctx, s.app.DB.R, "net_timeout_sec", 30)
	proxy := "system"
	if v, _ := db.GetSetting(ctx, s.app.DB.R, "net_proxy"); v != nil {
		proxy = *v
	}
	s.app.SetHTTP(appstate.BuildClient(timeout, proxy))
	return nil
}

// GetSetting returns a setting's value, or null when the key is absent.
func (s *SettingService) GetSetting(key string) (*string, error) {
	return db.GetSetting(bg(), s.app.DB.R, key)
}

// SetSetting upserts a setting value. Changing the app icon also repaints
// the running process so the Dock follows without a restart.
func (s *SettingService) SetSetting(key, value string) error {
	if err := db.SetSetting(bg(), s.app.DB.W, key, value); err != nil {
		return err
	}
	if key == appicon.SettingKey {
		appicon.Apply(value)
	}
	return nil
}

// ExportReading writes the reader's typography and layout preferences to a
// file the reader chooses.
//
// It goes through Go rather than through the webview because the WKWebView has
// no download handler: an `<a download>` in this app saves nothing at all, and
// says nothing about it either — the same reason the highlight export is
// written here. An empty path means the reader cancelled, which is not an
// error.
func (s *SettingService) ExportReading(content string) (string, error) {
	path, err := application.Get().Dialog.SaveFile().
		SetFilename("hiread-reading.json").
		AddFilter("JSON", "*.json").
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return "", apperr.Wrap("readingExport", err)
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", apperr.Wrap("readingExport", err)
	}
	return path, nil
}

// ImportReading reads a settings file back. The frontend decides what to do
// with what is in it — this only hands over the text, because what a reading
// setting *is* is described there and nowhere here.
func (s *SettingService) ImportReading() (string, error) {
	paths, err := application.Get().Dialog.OpenFile().
		AddFilter("JSON", "*.json").
		PromptForSingleSelection()
	if err != nil {
		return "", apperr.Wrap("readingImport", err)
	}
	if paths == "" {
		return "", nil
	}
	// A settings file is small; anything the size of a book here is not one.
	const maxSize = 1 << 20
	info, err := os.Stat(paths)
	if err != nil {
		return "", apperr.Wrap("readingImport", err)
	}
	if info.Size() > maxSize {
		return "", apperr.Codef("readingImport", "file is too large to be a settings file")
	}
	data, err := os.ReadFile(paths)
	if err != nil {
		return "", apperr.Wrap("readingImport", err)
	}
	return string(data), nil
}
