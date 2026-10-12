package effects

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/rand/v2"
	"os"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
)

// testdata/golden.json holds sha256 hashes of the JavaScript SDK's effects
// (javascript/src/voice/effects) applied to testdata/input_24k.pcm. A match
// proves the Go effect is sample-for-sample identical to JavaScript.

// lcgSource replays the generator the fixture script installed as
// Math.random: a 64-bit LCG whose top 53 bits, over 2^53, are each draw.
// math/rand/v2's Float64 keeps the low 53 bits of Uint64, so Uint64 hands
// over the top 53 bits already shifted down.
type lcgSource struct{ s uint64 }

func (l *lcgSource) Uint64() uint64 {
	l.s = l.s*6364136223846793005 + 1442695040888963407
	return l.s >> 11
}

func lcg(seed uint64) Option { return WithRand(rand.New(&lcgSource{s: seed})) }

func goldenInput(t testing.TB) []byte {
	t.Helper()
	in, err := os.ReadFile("testdata/input_24k.pcm")
	if err != nil {
		t.Fatal(err)
	}
	return in
}

func TestEffectsMatchJavaScriptGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	in := goldenInput(t)
	bg := func(preset string, v float64) Effect { return Must(BackgroundNoise(preset, v)) }
	cases := map[string]Effect{
		"background_cafe_03":    bg(Cafe, 0.3),
		"background_street_04":  bg(Street, 0.4),
		"background_office_03":  bg(Office, 0.3),
		"background_airport_05": bg(Airport, 0.5),
		"multiple_voices":       MultipleVoices(DefaultNoiseVolume),
		"low_volume":            Must(LowVolume(DefaultLowVolume)),
		"high_volume":           Must(HighVolume(DefaultHighVolume)),
		"high_volume_clip":      Must(HighVolume(3)),
		"speaking_fast":         Must(SpeakingFast(DefaultSpeakingFast)),
		"speaking_slow":         Must(SpeakingSlow(DefaultSpeakingSlow)),
		"low_quality":           LowQuality(DefaultLowQualityRate),
		"low_quality_16k":       LowQuality(16000),
		"echo":                  Echo(DefaultEchoDelay, DefaultEchoDecay),
		"echo_100_07":           Echo(100, 0.7),
		"static":                Static(DefaultStaticIntensity, lcg(42)),
		"packet_loss":           Must(PacketLoss(0.3, 20, lcg(7))),
		"breaking_up":           BreakingUp(lcg(9)),
	}
	for name, fx := range cases {
		out := fx(nil, in)
		h := sha256.Sum256(out)
		if got := hex.EncodeToString(h[:]); got != golden[name] {
			t.Errorf("%s: output differs from JavaScript (sha256 %s, want %s)", name, got, golden[name])
		}
	}
}

// Robotic depends on math.Sin, and PhoneQuality on FFT summation order,
// both of which may differ from V8 in the last bit. Allow ±1 LSB on rare
// rounding ties, and require nearly every sample to match exactly.
func TestTranscendentalEffectsMatchJavaScript(t *testing.T) {
	in := goldenInput(t)
	for name, fx := range map[string]Effect{"robotic": Robotic(), "phone_quality": PhoneQuality()} {
		want, err := os.ReadFile("testdata/" + name + ".pcm")
		if err != nil {
			t.Fatal(err)
		}
		got := fx(nil, in)
		if len(got) != len(want) {
			t.Fatalf("%s: %d bytes, want %d", name, len(got), len(want))
		}
		mismatched := 0
		for i := range len(got) / 2 {
			d := int(audio.Sample(got, i)) - int(audio.Sample(want, i))
			if d < -1 || d > 1 {
				t.Fatalf("%s: sample %d differs by %d", name, i, d)
			}
			if d != 0 {
				mismatched++
			}
		}
		if mismatched > len(got)/2/1000 {
			t.Errorf("%s: %d samples off by one LSB", name, mismatched)
		}
	}
}
