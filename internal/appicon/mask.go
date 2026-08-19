package appicon

import (
	"bytes"
	"image"
	"image/png"
	"math"
)

// Apple's Big Sur+ template is a superellipse (~n=5), not a circular
// rounded-rect. setApplicationIconImage: paints this bitmap as-is — the
// Dock will not apply a second mask, and it will not inset the plate the
// way a bundled .icns is drawn. A full-bleed squircle therefore looks
// larger than every other app. Keep the plate in the centre ~80%.
const (
	squircleN = 5.0
	dockInset = 0.10
)

func withDockMask(src []byte) []byte { return maskPlate(src, dockInset) }

// withFinderMask kept for tests that compare a full plate against the
// Dock inset. Finder itself now uses Bytes() (same inset as the Dock).
func withFinderMask(src []byte) []byte { return maskPlate(src, 0) }

func maskPlate(src []byte, insetFrac float64) []byte {
	img, err := png.Decode(bytes.NewReader(src))
	if err != nil {
		return src
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w < 8 || h < 8 {
		return src
	}
	srcW := float64(w)
	srcH := float64(h)
	insetX := srcW * insetFrac
	insetY := srcH * insetFrac
	innerW := srcW - 2*insetX
	innerH := srcH - 2*insetY
	out := image.NewNRGBA(b)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cov := squircleCoverage(float64(x), float64(y), srcW, srcH, insetX, insetY, innerW, innerH)
			if cov == 0 {
				continue
			}
			// Scale the full artwork into the inset plate — do not crop it.
			sx := (float64(x)-insetX)/innerW*srcW + float64(b.Min.X)
			sy := (float64(y)-insetY)/innerH*srcH + float64(b.Min.Y)
			r, g, bl, a := sample(img, sx, sy)
			pr := uint8(r >> 8)
			pg := uint8(g >> 8)
			pb := uint8(bl >> 8)
			pa := uint8((float64(a>>8) * cov) + 0.5)
			if cov > 0.2 && cov < 0.92 {
				pr = darken(pr, 0.18)
				pg = darken(pg, 0.18)
				pb = darken(pb, 0.18)
			}
			i := out.PixOffset(b.Min.X+x, b.Min.Y+y)
			out.Pix[i+0] = pr
			out.Pix[i+1] = pg
			out.Pix[i+2] = pb
			out.Pix[i+3] = pa
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return src
	}
	return buf.Bytes()
}

func sample(img image.Image, x, y float64) (r, g, b, a uint32) {
	bds := img.Bounds()
	ix := int(math.Floor(x + 0.5))
	iy := int(math.Floor(y + 0.5))
	if ix < bds.Min.X {
		ix = bds.Min.X
	}
	if iy < bds.Min.Y {
		iy = bds.Min.Y
	}
	if ix >= bds.Max.X {
		ix = bds.Max.X - 1
	}
	if iy >= bds.Max.Y {
		iy = bds.Max.Y - 1
	}
	return img.At(ix, iy).RGBA()
}

func darken(c uint8, amt float64) uint8 {
	v := float64(c) * (1 - amt)
	if v < 0 {
		return 0
	}
	return uint8(v + 0.5)
}

// squircleCoverage is 1 inside the inset plate, 0 outside, with a 2×2
// supersample so the edge is not stair-stepped at Dock sizes.
func squircleCoverage(x, y, w, h, insetX, insetY, innerW, innerH float64) float64 {
	var sum float64
	for dy := 0.25; dy < 1; dy += 0.5 {
		for dx := 0.25; dx < 1; dx += 0.5 {
			if insideSquircle(x+dx, y+dy, insetX, insetY, innerW, innerH) {
				sum++
			}
		}
	}
	return sum / 4
}

func insideSquircle(x, y, insetX, insetY, innerW, innerH float64) bool {
	if innerW <= 0 || innerH <= 0 {
		return false
	}
	nx := (x-insetX)/innerW*2 - 1
	ny := (y-insetY)/innerH*2 - 1
	return math.Pow(math.Abs(nx), squircleN)+math.Pow(math.Abs(ny), squircleN) <= 1
}
