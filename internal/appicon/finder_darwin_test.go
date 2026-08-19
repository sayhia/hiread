//go:build darwin

package appicon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildIcns(t *testing.T) {
	b, err := buildIcns(nightPNG)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 1000 {
		t.Fatalf("icns too small: %d", len(b))
	}
}

func TestWriteBundleIconReplacesIcns(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "hiread.app")
	res := filepath.Join(app, "Contents", "Resources")
	if err := os.MkdirAll(res, 0o755); err != nil {
		t.Fatal(err)
	}
	icns, err := buildIcns(dawnPNG)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeBundleIcon(app, icns); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(res, "icons.icns"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(icns) {
		t.Fatalf("wrote %d, want %d", len(got), len(icns))
	}
}
