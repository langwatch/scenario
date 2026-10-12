package livetest

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"regexp"
	"strings"
)

// RedSquarePNG is a 64x64 solid red PNG: small enough to be cheap, and
// with one unambiguous answer to "what color is it?".
func RedSquarePNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	red := color.RGBA{R: 220, A: 255}
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, red)
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

var nonWord = regexp.MustCompile(`[^a-z0-9\s]+`)

// Words lowercases text, strips punctuation and splits it into words.
func Words(text string) []string {
	return strings.Fields(nonWord.ReplaceAllString(strings.ToLower(text), " "))
}

// WordOverlap is the fraction of the words of want found in got: 1 for a
// clean speech round trip, near 0 for garbled audio.
func WordOverlap(want, got string) float64 {
	in := Words(want)
	if len(in) == 0 {
		return 0
	}
	seen := map[string]bool{}
	for _, w := range Words(got) {
		seen[w] = true
	}
	hits := 0
	for _, w := range in {
		if seen[w] {
			hits++
		}
	}
	return float64(hits) / float64(len(in))
}
