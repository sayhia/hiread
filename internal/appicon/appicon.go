// Package appicon holds the official Hiread marks and applies the chosen
// one to the running process so the Dock / taskbar follows the appearance
// setting without a rebuild.
package appicon

import (
	_ "embed"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// SettingKey is the backend settings row the frontend mirrors into.
const SettingKey = "app_icon"

//go:embed night.png
var nightPNG []byte

//go:embed dawn.png
var dawnPNG []byte

//go:embed gold.png
var goldPNG []byte

//go:embed platinum.png
var platinumPNG []byte

// Masked copies for SetIcon. The embedded files stay full-bleed so they
// can also feed `wails3 generate icons` (the system mask on a bundled
// .icns must not be pre-applied). Runtime SetIcon skips that mask.
var (
	nightDock      = withDockMask(nightPNG)
	dawnDock       = withDockMask(dawnPNG)
	goldDock       = withDockMask(goldPNG)
	platinumDock   = withDockMask(platinumPNG)
	nightFinder    = withFinderMask(nightPNG)
	dawnFinder     = withFinderMask(dawnPNG)
	goldFinder     = withFinderMask(goldPNG)
	platinumFinder = withFinderMask(platinumPNG)
)

var variants = map[string]struct {
	src, dock, finder []byte
}{
	"night":    {nightPNG, nightDock, nightFinder},
	"dawn":     {dawnPNG, dawnDock, dawnFinder},
	"gold":     {goldPNG, goldDock, goldFinder},
	"platinum": {platinumPNG, platinumDock, platinumFinder},
}

// Normalize maps an arbitrary stored value onto a known variant. Anything
// unknown (including empty / corrupt) is night, the packaged default.
func Normalize(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if _, ok := variants[v]; ok {
		return v
	}
	return "night"
}

func sourcePNG(variant string) []byte { return variants[Normalize(variant)].src }

// Bytes returns the Dock-ready PNG for variant (superellipse plate,
// transparent corners). Unknown names fall back to night.
func Bytes(variant string) []byte { return variants[Normalize(variant)].dock }

func finderBytes(variant string) []byte { return variants[Normalize(variant)].finder }

// Apply paints the running app's Dock icon and the Finder / Desktop icon
// on the .app (and any Hiread.app sitting on the Desktop). Safe to call
// before Run — SetIcon ignores a nil impl.
func Apply(variant string) {
	v := Normalize(variant)
	if b := Bytes(v); len(b) > 0 {
		if app := application.Get(); app != nil {
			app.SetIcon(b)
		}
	}
	applyFinderIcon(v)
}
