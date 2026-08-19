package services

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"hiread/internal/appstate"
)

// SystemService exposes app-level commands not tied to a single domain: the
// native tray, the window chrome, and fullscreen.
type SystemService struct {
	app *appstate.State
}

// trayRefresh rebuilds the native menu-bar tray. main.go owns the tray and the
// menu builder, so it registers this callback via SetTrayRefresh; RefreshTray
// invokes it. The frontend calls RefreshTray right after persisting a new
// "language" setting, so the tray's native labels re-localize without a restart.
var trayRefresh func()

// SetTrayRefresh registers the tray-rebuild callback. Called once from main.go.
func SetTrayRefresh(fn func()) { trayRefresh = fn }

// mainWin is the app's main window; main.go registers it via SetMainWindow so
// SetWindowBackground can repaint the native backing at runtime.
var mainWin *application.WebviewWindow

// SetMainWindow registers the main window handle. Called once from main.go.
func SetMainWindow(w *application.WebviewWindow) { mainWin = w }

// SetWindowBackground paints the native window backing the given colour. The
// frontend mirrors the current theme's paper colour here on every appearance
// change, so the strip a fast macOS resize exposes beyond the webview's last
// frame matches the theme instead of flashing the (formerly hardcoded) light
// paper in dark mode.
func (s *SystemService) SetWindowBackground(r, g, b uint8) {
	if mainWin != nil {
		mainWin.SetBackgroundColour(application.NewRGB(r, g, b))
	}
}

// RefreshTray rebuilds the menu-bar tray, re-reading the UI language so its
// labels match the current locale. No-op until the tray is wired in main.go.
func (s *SystemService) RefreshTray() error {
	if trayRefresh != nil {
		trayRefresh()
	}
	return nil
}

// ToggleFullscreen flips the current window between fullscreen and normal
// state. Real system-level fullscreen: on macOS the traffic-light bar and
// menu bar hide via native NSWindow; on Windows/Linux the frame collapses
// via Wails' fullscreen implementation. Returns the resulting state so the
// UI can sync (a mac user pressing the green traffic-light directly still
// fires this same state, so we treat the API as authoritative).
func (s *SystemService) ToggleFullscreen() (bool, error) {
	w := application.Get().Window.Current()
	if w == nil {
		return false, nil
	}
	if w.IsFullscreen() {
		w.UnFullscreen()
		return false, nil
	}
	w.Fullscreen()
	return true, nil
}

// IsFullscreen reports the current window's fullscreen state so the UI
// can seed itself on mount (or after a native-side toggle).
func (s *SystemService) IsFullscreen() (bool, error) {
	w := application.Get().Window.Current()
	if w == nil {
		return false, nil
	}
	return w.IsFullscreen(), nil
}
