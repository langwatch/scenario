package audio

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// The golden fixtures in testdata were produced by running the JavaScript
// SDK's own functions (twilio-shared.ts, twilio-speech-gate.ts, stt/wav.ts)
// on testdata/input_24k.pcm. Matching their hashes proves the Go port is
// sample-for-sample identical, not merely close.

func loadGolden(t *testing.T) (map[string]any, []byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g map[string]any
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	in, err := os.ReadFile("testdata/input_24k.pcm")
	if err != nil {
		t.Fatal(err)
	}
	return g, in
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestMatchesJavaScriptGolden(t *testing.T) {
	g, in := loadGolden(t)
	allPCM := make([]byte, 0, 1<<17)
	for v := -32768; v <= 32767; v++ {
		allPCM = AppendSample(allPCM, int16(v))
	}
	allBytes := make([]byte, 256)
	for i := range allBytes {
		allBytes[i] = byte(i)
	}
	d8 := Resample(in, 24000, 8000)
	d16 := Resample(in, 24000, 16000)
	got := map[string][]byte{
		"resample_24k_8k":     d8,
		"resample_8k_24k":     Resample(d8, 8000, 24000),
		"resample_24k_16k":    d16,
		"resample_16k_24k":    Resample(d16, 16000, 24000),
		"resample_44100_24k":  Resample(in, 44100, 24000),
		"resample_24k_44100":  Resample(in, 24000, 44100),
		"resample_24k_48k":    Resample(in, 24000, 48000),
		"resample_odd_7":      Resample(in[:14], 24000, 8000),
		"mulaw_encode_all":    AppendMulaw(nil, allPCM),
		"mulaw_decode_all":    AppendMulawDecoded(nil, allBytes),
		"mulaw8k_from_24k":    AppendMulaw8k(nil, in),
		"pcm24k_from_mulaw8k": AppendPCM24kFromMulaw8k(nil, AppendMulaw8k(nil, in)),
		"wav":                 AppendWAV(nil, in),
	}
	for name, b := range got {
		if want := g[name].(string); sum(b) != want {
			t.Errorf("%s: sha256 %s, JavaScript produced %s", name, sum(b), want)
		}
	}
	if want := g["rms"].(float64); RMS(in) != want {
		t.Errorf("RMS = %v, JavaScript produced %v", RMS(in), want)
	}
}

func TestSlowMulawMatchesTables(t *testing.T) {
	for v := -32768; v <= 32767; v++ {
		if MulawEncode(int16(v)) != mulawEncodeSlow(int16(v)) {
			t.Fatalf("encode table differs at %d", v)
		}
	}
	for b := range 256 {
		if MulawDecode(uint8(b)) != mulawDecodeSlow(uint8(b)) {
			t.Fatalf("decode table differs at %d", b)
		}
	}
}
