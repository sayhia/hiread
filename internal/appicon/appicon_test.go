package appicon

import (
	"bytes"
	"image/png"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"":           "night",
		"night":      "night",
		"NIGHT":      "night",
		"dawn":       "dawn",
		" Dawn ":     "dawn",
		"DAWN":       "dawn",
		"gold":       "gold",
		"platinum":   "platinum",
		" PLATINUM ": "platinum",
		"dusk":       "night",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBytes(t *testing.T) {
	night := Bytes("night")
	dawn := Bytes("dawn")
	if len(night) < 1000 {
		t.Fatalf("night.png too small: %d", len(night))
	}
	if len(dawn) < 1000 {
		t.Fatalf("dawn.png too small: %d", len(dawn))
	}
	if len(night) == len(dawn) && string(night[:64]) == string(dawn[:64]) {
		t.Fatal("night and dawn PNGs look identical")
	}
	if got := Bytes("nope"); len(got) != len(night) {
		t.Fatal("unknown variant should fall back to night")
	}
	for _, id := range []string{"gold", "platinum"} {
		if len(Bytes(id)) < 1000 {
			t.Fatalf("%s.png too small", id)
		}
	}
}

func TestBytesHasTransparentCorners(t *testing.T) {
	img, err := png.Decode(bytes.NewReader(Bytes("night")))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	_, _, _, a0 := img.At(b.Min.X, b.Min.Y).RGBA()
	if a0 != 0 {
		t.Fatalf("corner should be transparent, got alpha %d", a0)
	}
	// The Dock plate is inset ~10% — an edge-centre pixel must stay empty
	// or the icon fills the well and reads larger than other apps.
	midY := b.Min.Y + b.Dy()/2
	_, _, _, ae := img.At(b.Min.X+2, midY).RGBA()
	if ae != 0 {
		t.Fatalf("left edge should be transparent, got alpha %d", ae)
	}
	inset := int(float64(b.Dx()) * dockInset * 0.4)
	_, _, _, ai := img.At(b.Min.X+inset, midY).RGBA()
	if ai != 0 {
		t.Fatalf("inset margin should be transparent, got alpha %d at x=%d", ai, inset)
	}
	cx, cy := b.Min.X+b.Dx()/2, b.Min.Y+b.Dy()/2
	_, _, _, ac := img.At(cx, cy).RGBA()
	if ac < 0x8000 {
		t.Fatalf("center should be opaque, got alpha %d", ac)
	}
}

func TestFinderPlateFillsMoreThanDock(t *testing.T) {
	// Desktop icons are not inset the way the Dock image is — otherwise
	// they look like a small tile on a big empty square.
	dock, err := png.Decode(bytes.NewReader(Bytes("night")))
	if err != nil {
		t.Fatal(err)
	}
	find, err := png.Decode(bytes.NewReader(finderBytes("night")))
	if err != nil {
		t.Fatal(err)
	}
	b := dock.Bounds()
	x := b.Min.X + int(float64(b.Dx())*0.05)
	y := b.Min.Y + b.Dy()/2
	_, _, _, ad := dock.At(x, y).RGBA()
	_, _, _, af := find.At(x, y).RGBA()
	if af < 0x8000 {
		t.Fatalf("finder plate should be opaque at 5%% inset, alpha %d", af)
	}
	if ad != 0 {
		t.Fatalf("dock plate should still be empty at 5%% inset, alpha %d", ad)
	}
}
