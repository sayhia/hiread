//go:build darwin

package appicon

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework Foundation
#include <stdlib.h>
#import <AppKit/AppKit.h>

// Load from a file on the AppKit thread. The earlier NSData path wrote a
// 0-byte Icon\r; initWithContentsOfFile is what Finder itself uses.
static int setFinderIconAt(const char *path, const char *pngPath) {
	__block int ok = 0;
	void (^work)(void) = ^{
		@autoreleasepool {
			NSImage *img = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:pngPath]];
			if (img == nil) {
				return;
			}
			ok = [[NSWorkspace sharedWorkspace] setIcon:img
				forFile:[NSString stringWithUTF8String:path]
				options:NSExclude10_4ElementsIconCreationOption] ? 1 : 0;
		}
	};
	if ([NSThread isMainThread]) {
		work();
	} else {
		dispatch_sync(dispatch_get_main_queue(), work);
	}
	return ok;
}
*/
import "C"

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

var (
	icnsCache sync.Map // variant -> []byte
	installMu sync.Mutex
	iconSizes = []struct {
		name string
		px   int
	}{
		{"icon_16x16.png", 16},
		{"icon_16x16@2x.png", 32},
		{"icon_32x32.png", 32},
		{"icon_32x32@2x.png", 64},
		{"icon_128x128.png", 128},
		{"icon_128x128@2x.png", 256},
		{"icon_256x256.png", 256},
		{"icon_256x256@2x.png", 512},
		{"icon_512x512.png", 512},
		{"icon_512x512@2x.png", 1024},
	}
)

func init() {
	go func() {
		for _, id := range []string{"night", "dawn", "gold", "platinum"} {
			_, _ = pngFile(id)
			_, _ = icnsFor(id)
		}
	}()
}

// applyFinderIcon paints Finder / Desktop / Applications immediately via
// NSWorkspace setIcon (same instant path as pasting an icon in Get Info),
// then persists the bundled icns in the background.
func applyFinderIcon(variant string) {
	v := Normalize(variant)
	if err := paintFinderIcon(v); err != nil {
		log.Printf("hiread: finder icon: %v", err)
	}
	go func() {
		installMu.Lock()
		defer installMu.Unlock()
		if err := persistIcns(v); err != nil {
			log.Printf("hiread: persist icns: %v", err)
		}
	}()
}

var pngOnce sync.Map // variant -> temp png path

func pngFile(variant string) (string, error) {
	v := Normalize(variant)
	if p, ok := pngOnce.Load(v); ok {
		return p.(string), nil
	}
	// Same inset plate as the Dock icon — a full-bleed squircle fills the
	// Finder well and looks larger than neighbouring apps.
	p := filepath.Join(os.TempDir(), "hiread-finder-v2-"+v+".png")
	if err := os.WriteFile(p, Bytes(v), 0o644); err != nil {
		return "", err
	}
	pngOnce.Store(v, p)
	return p, nil
}

func paintFinderIcon(variant string) error {
	pngPath, err := pngFile(variant)
	if err != nil {
		return err
	}
	targets := finderTargets()
	if len(targets) == 0 {
		return fmt.Errorf("no .app targets")
	}
	var last error
	for _, app := range targets {
		if !setFileIcon(app, pngPath) {
			last = fmt.Errorf("setIcon failed for %s", app)
			log.Printf("hiread: %v", last)
		}
	}
	return last
}

func setFileIcon(app, pngPath string) bool {
	cApp := C.CString(app)
	cPng := C.CString(pngPath)
	defer C.free(unsafe.Pointer(cApp))
	defer C.free(unsafe.Pointer(cPng))
	return C.setFinderIconAt(cApp, cPng) == 1
}

func icnsFor(variant string) ([]byte, error) {
	v := Normalize(variant)
	if cached, ok := icnsCache.Load(v); ok {
		return cached.([]byte), nil
	}
	b, err := buildIcns(sourcePNG(v))
	if err != nil {
		return nil, err
	}
	icnsCache.Store(v, b)
	return b, nil
}

func buildIcns(png []byte) ([]byte, error) {
	dir, err := os.MkdirTemp("", "hiread-icon-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	src := filepath.Join(dir, "src.png")
	if err := os.WriteFile(src, png, 0o644); err != nil {
		return nil, err
	}
	set := filepath.Join(dir, "icon.iconset")
	if err := os.Mkdir(set, 0o755); err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	errCh := make(chan error, len(iconSizes))
	for _, s := range iconSizes {
		wg.Add(1)
		go func(s struct {
			name string
			px   int
		}) {
			defer wg.Done()
			out := filepath.Join(set, s.name)
			cmd := exec.Command("/usr/bin/sips", "-z", strconv.Itoa(s.px), strconv.Itoa(s.px), src, "--out", out)
			if b, err := cmd.CombinedOutput(); err != nil {
				errCh <- fmt.Errorf("sips %s: %w: %s", s.name, err, b)
			}
		}(s)
	}
	wg.Wait()
	close(errCh)
	if err := <-errCh; err != nil {
		return nil, err
	}
	icns := filepath.Join(dir, "icons.icns")
	cmd := exec.Command("/usr/bin/iconutil", "-c", "icns", set, "-o", icns)
	if b, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("iconutil: %w: %s", err, b)
	}
	return os.ReadFile(icns)
}

func persistIcns(variant string) error {
	icns, err := icnsFor(variant)
	if err != nil {
		return err
	}
	var last error
	for _, app := range finderTargets() {
		if err := writeBundleIcon(app, icns); err != nil {
			last = err
		}
	}
	return last
}

func writeBundleIcon(app string, icns []byte) error {
	res := filepath.Join(app, "Contents", "Resources")
	if err := os.MkdirAll(res, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(res, "icons.icns"), icns, 0o644); err != nil {
		return err
	}
	plist := filepath.Join(app, "Contents", "Info.plist")
	build := fmt.Sprintf("0.1.2.%d", time.Now().Unix())
	_ = exec.Command("/usr/bin/plutil", "-replace", "CFBundleVersion", "-string", build, plist).Run()
	now := time.Now()
	_ = os.Chtimes(app, now, now)
	_ = os.Chtimes(filepath.Join(res, "icons.icns"), now, now)
	return nil
}

func finderTargets() []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			p = resolved
		}
		if _, ok := seen[p]; ok {
			return
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}

	add(runningBundle())

	home, err := os.UserHomeDir()
	if err != nil {
		return out
	}
	for _, dir := range []string{
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "Applications"),
		"/Applications",
		// iCloud Desktop (some Macs show this as “桌面”)
		filepath.Join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Desktop"),
	} {
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range ents {
			name := e.Name()
			if !strings.HasSuffix(strings.ToLower(name), ".app") {
				continue
			}
			if !strings.Contains(strings.ToLower(name), "hiread") {
				continue
			}
			add(filepath.Join(dir, name))
		}
	}
	return out
}

// runningBundle walks from the executable up to Hiread.app.
func runningBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	macos := filepath.Dir(exe)
	if filepath.Base(macos) != "MacOS" {
		return ""
	}
	contents := filepath.Dir(macos)
	if filepath.Base(contents) != "Contents" {
		return ""
	}
	app := filepath.Dir(contents)
	if !strings.HasSuffix(strings.ToLower(app), ".app") {
		return ""
	}
	return app
}
