// hiread — a local-first ebook reader. Wails3 application entry point: resolves
// the data directory, opens the database, wires the shared state, registers the
// bound services, and creates the main window.
package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"hiread/internal/appicon"
	"hiread/internal/appstate"
	"hiread/internal/books"
	"hiread/internal/db"
	"hiread/internal/events"
	"hiread/internal/fonts"
	"hiread/services"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Frontend events the backend emits. Registering them lets the binding
	// generator produce a strongly typed TS API. Per-request streaming events
	// (AI tokens, translation progress) are emitted under dynamic names and are
	// not registered here.
	application.RegisterEvent[any]("library-changed")
	application.RegisterEvent[any]("tray-open-settings")
	application.RegisterEvent[any]("tray-add-books")
	application.RegisterEvent[any]("books-imported")
}

// dataDir resolves (and creates) the per-user application data directory. On
// macOS this is ~/Library/Application Support/Hiread.
func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	dir := filepath.Join(base, "Hiread")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func main() {
	state, err := appstate.New(dataDir())
	if err != nil {
		log.Fatalf("hiread: open database: %v", err)
	}
	defer state.Close()

	svc := services.New(state)

	// Opening a book file with hiread — from the Finder, from a second launch,
	// or from the command line — imports it into the library. Anything that is
	// not a book file is ignored rather than reported: the OS also passes
	// process arguments through here.
	var mainWindow *application.WebviewWindow
	handleOpenFiles := func(args []string) {
		var paths []string
		for _, a := range args {
			info, err := os.Stat(a)
			if err == nil && info.IsDir() {
				paths = append(paths, a)
				continue
			}
			if isBookFile(a) {
				paths = append(paths, a)
			}
		}
		if len(paths) == 0 {
			return
		}
		go func() {
			results, err := svc.Library.ImportFiles(paths)
			if err != nil {
				log.Printf("hiread: import %v: %v", paths, err)
			}
			if len(results) > 0 {
				events.Emit("books-imported", results)
			}
			if mainWindow != nil {
				mainWindow.Show()
				mainWindow.Focus()
			}
		}()
	}

	iconName := startupIconName(state)
	app := application.New(application.Options{
		Name:        "Hiread",
		Description: "A fast, native ebook reader for the desktop.",
		Icon:        appicon.Bytes(iconName),
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "ai.hiread.reader",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				handleOpenFiles(data.Args)
			},
		},
		Services: []application.Service{
			application.NewService(svc.Library),
			application.NewService(svc.Collection),
			application.NewService(svc.Tag),
			application.NewService(svc.Setting),
			application.NewService(svc.Highlight),
			application.NewService(svc.Storage),
			application.NewService(svc.System),
			application.NewService(svc.AI),
			application.NewService(svc.Font),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			// Serve downloaded fonts from <dataDir>/fonts at /userfonts/* (the
			// font-switching feature); all other requests fall through to the
			// embedded dist handler.
			Middleware: fonts.AssetMiddleware(state.DataDir()),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	// Options.Icon feeds the about box; SetIcon is what the Dock actually
	// shows. The PNG is already a superellipse — NSApp will not round it.
	appicon.Apply(iconName)

	// Build the HTTP client from persisted network settings. hiread reaches the
	// network only for AI, translation and font downloads — a library needs
	// nothing fetched to be read.
	_ = svc.Setting.ApplyNetworkSettings()

	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Hiread",
		Width:  1200,
		Height: 800,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: startupBackground(state),
		URL:              "/",
	})

	// Let the frontend repaint the native backing when the theme changes.
	services.SetMainWindow(mainWindow)

	// ── macOS menu-bar tray ──
	tray := app.SystemTray.New()
	tray.SetLabel("📖")
	tray.SetTooltip("Hiread")
	tray.SetMenu(buildTrayMenu(app, state, mainWindow))
	// Re-localize the native tray when the UI language changes: the frontend
	// calls SystemService.RefreshTray right after persisting "language", which
	// invokes this to rebuild the menu in the new locale. (SetMenu dispatches to
	// the main thread itself, so calling it from the service goroutine is safe.)
	services.SetTrayRefresh(func() {
		tray.SetMenu(buildTrayMenu(app, state, mainWindow))
	})

	// A cold-start launch carrying book paths (opening a file with hiread from
	// the Finder, or `hiread book.epub` from a shell).
	handleOpenFiles(os.Args[1:])

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// isBookFile reports whether a launch argument looks like a book hiread can
// open. Only the extension is checked here — the parser sniffs the real format
// once the bytes are read.
func isBookFile(path string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	if ext == "" {
		return false
	}
	for _, known := range books.Extensions() {
		if ext == known {
			return true
		}
	}
	return false
}

// startupIconName is the persisted mark so a chosen palette is already on
// the Dock before the webview paints. Unknown values fall back to night.
func startupIconName(state *appstate.State) string {
	v, _ := db.GetSetting(context.Background(), state.DB.R, appicon.SettingKey)
	if v == nil {
		return "night"
	}
	return appicon.Normalize(*v)
}

// startupBackground picks the native window backing for the first frame from
// the mirrored appearance settings ("theme" is the *resolved* light/dark;
// "dark_shade" its dark sub-level), so a dark-theme launch never flashes the
// light paper before the webview paints. Colours mirror styles.css --paper
// (light #E8E6E1; dark #0C121C / #080D14 / #000000). After launch the
// frontend keeps the backing in sync via SystemService.SetWindowBackground.
func startupBackground(state *appstate.State) application.RGBA {
	ctx := context.Background()
	if v, err := db.GetSetting(ctx, state.DB.R, "theme"); err == nil && v != nil && *v == "dark" {
		shade, _ := db.GetSetting(ctx, state.DB.R, "dark_shade")
		switch {
		case shade != nil && *shade == "black":
			return application.NewRGB(0, 0, 0)
		case shade != nil && *shade == "dimmer":
			return application.NewRGB(8, 13, 20)
		default:
			return application.NewRGB(12, 18, 28)
		}
	}
	return application.NewRGB(232, 230, 225)
}

// trayStrings holds the menu-bar tray labels per UI language. The tray is a
// native menu built in Go, so the webview's vue-i18n never reaches it — these
// mirror the frontend locale wording. Unknown languages fall back to English.
var trayStrings = map[string]struct {
	status   string // printf template with two %d: books in library, books in progress
	addBooks string
	settings string
	quit     string
}{
	"en": {"%d books · %d in progress", "Add books…", "Settings…", "Quit Hiread"},
	"zh": {"%d 本书 · %d 本在读", "添加书籍…", "设置…", "退出 Hiread"},
	"ja": {"%d 冊 · 読書中 %d 冊", "本を追加…", "設定…", "Hiread を終了"},
}

// trayLang resolves the tray language: the primary subtag of the persisted
// "language" setting (zh / en / ja), defaulting to English.
func trayLang(state *appstate.State) string {
	v, _ := db.GetSetting(context.Background(), state.DB.R, "language")
	if v == nil {
		return "en"
	}
	lang := strings.ToLower(strings.TrimSpace(*v))
	if i := strings.IndexAny(lang, "-_"); i >= 0 {
		lang = lang[:i]
	}
	if _, ok := trayStrings[lang]; !ok {
		return "en"
	}
	return lang
}

// buildTrayMenu constructs the menu-bar tray menu: a library status line plus
// quick actions (add books, open settings, quit), localized to the current UI
// language.
func buildTrayMenu(app *application.App, state *appstate.State, win *application.WebviewWindow) *application.Menu {
	tr := trayStrings[trayLang(state)]
	m := app.NewMenu()
	counts, _ := db.CountLibrary(context.Background(), state.DB.R)
	m.Add(fmt.Sprintf(tr.status, counts.All, counts.Reading)).SetEnabled(false)
	m.AddSeparator()
	// Both actions raise the window first: the file picker and the settings
	// dialog are both rendered by the webview, and a tray click can arrive
	// while the app is hidden.
	m.Add(tr.addBooks).OnClick(func(*application.Context) {
		showWindow(win)
		// The payload is REQUIRED even though the frontend ignores it: a
		// RegisterEvent[any] event emitted with nil data trips a nil-pointer
		// panic in Wails' validateCustomEvent (reflect.TypeOf(nil).Implements),
		// which events.Emit silently recovers — so the event is dropped and
		// nothing happens. Any non-nil value sidesteps the bug.
		events.Emit("tray-add-books", true)
	})
	m.Add(tr.settings).OnClick(func(*application.Context) {
		showWindow(win)
		events.Emit("tray-open-settings", true)
	})
	m.AddSeparator()
	m.Add(tr.quit).OnClick(func(*application.Context) {
		app.Quit()
	})
	return m
}

func showWindow(win *application.WebviewWindow) {
	if win != nil {
		win.Show()
		win.Focus()
	}
}
