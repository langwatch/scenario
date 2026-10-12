package effects

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// Ported from javascript/src/voice/effects/__tests__/effects.test.ts.

// sineWave is 0.5 s of a 440 Hz tone at amplitude 16000, 24 kHz.
func sineWave() []byte {
	var out []byte
	for i := range 12000 {
		out = audio.AppendSample(out, int16(jsmath.Round(16000*math.Sin(2*math.Pi*440*(float64(i)/24000)))))
	}
	return out
}

// burstySpeech is 2 s of 100 ms 220 Hz bursts separated by 100 ms of
// digital silence, like clean TTS.
func burstySpeech() []byte {
	var out []byte
	for i := range 48000 {
		s := int16(0)
		if (i/2400)%2 == 0 {
			s = int16(jsmath.Round(16000 * math.Sin(2*math.Pi*220*(float64(i)/24000))))
		}
		out = audio.AppendSample(out, s)
	}
	return out
}

func anySampleDiffers(a, b []byte) bool {
	for i := range min(len(a), len(b)) / 2 {
		if audio.Sample(a, i) != audio.Sample(b, i) {
			return true
		}
	}
	return false
}

// mixEnergy is the L1 energy of wet - dry: how much the effect added.
func mixEnergy(dry, wet []byte) int {
	sum := 0
	for i := range min(len(dry), len(wet)) / 2 {
		d := int(audio.Sample(wet, i)) - int(audio.Sample(dry, i))
		sum += max(d, -d)
	}
	return sum
}

// noiseFloorRMS is the 10th-percentile 20 ms frame RMS, the measure the
// demos use to prove ambience was mixed in.
func noiseFloorRMS(pcm []byte) float64 {
	const frame = 480
	var rms []float64
	for i := 0; i+2*frame <= len(pcm); i += 2 * frame {
		rms = append(rms, audio.RMS(pcm[i:i+2*frame]))
	}
	if len(rms) == 0 {
		return 0
	}
	slices.Sort(rms)
	return rms[len(rms)/10]
}

var presets = []string{Cafe, Street, Office, Airport}

func TestEachPresetMeasurablyChangesDryAudio(t *testing.T) {
	dry := sineWave()
	for _, p := range presets {
		wet := Must(BackgroundNoise(p, 0.4))(nil, dry)
		if len(wet) != len(dry) {
			t.Errorf("%s: length %d, want %d", p, len(wet), len(dry))
		}
		if mixEnergy(dry, wet) == 0 || !anySampleDiffers(dry, wet) {
			t.Errorf("%s: noise mix added no energy — asset is silent", p)
		}
	}
}

func TestNoiseEnergyScalesWithVolume(t *testing.T) {
	dry := sineWave()
	quiet := mixEnergy(dry, Must(BackgroundNoise(Street, 0.2))(nil, dry))
	loud := mixEnergy(dry, Must(BackgroundNoise(Street, 0.6))(nil, dry))
	if loud <= quiet {
		t.Errorf("loud %d <= quiet %d", loud, quiet)
	}
}

func TestPresetsAreDistinct(t *testing.T) {
	dry := sineWave()
	wet := map[string][]byte{}
	for _, p := range presets {
		wet[p] = Must(BackgroundNoise(p, 0.4))(nil, dry)
	}
	for i, a := range presets {
		for _, b := range presets[i+1:] {
			if !anySampleDiffers(wet[a], wet[b]) {
				t.Errorf("%s and %s produced identical output", a, b)
			}
		}
	}
}

func TestEveryBundledAssetLoads(t *testing.T) {
	silent := make([]byte, 48000)
	fxs := map[string]Effect{"babble": MultipleVoices(0.5)}
	for _, p := range presets {
		fxs[p] = Must(BackgroundNoise(p, 0.5))
	}
	for name, fx := range fxs {
		if mixEnergy(silent, fx(nil, silent)) == 0 {
			t.Errorf("%s: mixing onto silence produced no energy", name)
		}
	}
}

func TestNoiseLoopsToCoverLongTurn(t *testing.T) {
	var dry []byte
	for range 24000 * 5 {
		dry = audio.AppendSample(dry, 6000)
	}
	wet := Must(BackgroundNoise(Airport, 0.5))(nil, dry)
	if mixEnergy(dry[2*24000*4:], wet[2*24000*4:]) == 0 {
		t.Error("no noise energy in the 5th second — the asset did not loop")
	}
}

func TestNoiseFloorCalibration(t *testing.T) {
	clean := burstySpeech()
	if f := noiseFloorRMS(clean); f >= 1 {
		t.Fatalf("clean noise floor %v, want < 1", f)
	}
	mixed := Must(BackgroundNoise(Cafe, 0.4))(nil, clean)
	if f := noiseFloorRMS(mixed); f <= 60 {
		t.Errorf("mixed noise floor %.1f did not clear the demos' > 60 discriminator", f)
	}
	if noiseFloorRMS(MultipleVoices(0.4)(nil, clean)) <= noiseFloorRMS(clean) {
		t.Error("babble did not lift the noise floor")
	}
}

func TestEffectChainAppliesEveryEffect(t *testing.T) {
	in := sineWave()
	chain := Chain(Must(BackgroundNoise(Cafe, 0.3)), PhoneQuality(), Must(PacketLoss(0.05, 20)))
	if out := chain(nil, in); len(out) == 0 {
		t.Fatal("chain produced no audio")
	}
	deterministic := Apply(in, Must(BackgroundNoise(Cafe, 0.3)), PhoneQuality())
	if !anySampleDiffers(in, deterministic) {
		t.Error("noise + phone quality left the audio unchanged")
	}
	stepwise := PhoneQuality()(nil, Must(BackgroundNoise(Cafe, 0.3))(nil, in))
	if !bytes.Equal(deterministic, stepwise) {
		t.Error("Apply differs from applying effects one at a time")
	}
}

func TestEveryBuiltInEffectReturnsAudio(t *testing.T) {
	in := sineWave()
	custom, _ := Custom(func(b []byte) []byte { return b })
	all := []Effect{
		Must(BackgroundNoise(Cafe, DefaultNoiseVolume)), PhoneQuality(), LowQuality(DefaultLowQualityRate),
		Must(PacketLoss(DefaultPacketLoss, DefaultPacketLossWindow)), Static(DefaultStaticIntensity),
		Echo(DefaultEchoDelay, DefaultEchoDecay), Must(SpeakingFast(DefaultSpeakingFast)),
		Must(SpeakingSlow(DefaultSpeakingSlow)), Must(LowVolume(DefaultLowVolume)),
		Must(HighVolume(DefaultHighVolume)), Robotic(), BreakingUp(), MultipleVoices(DefaultNoiseVolume), custom,
	}
	for i, fx := range all {
		if out := fx(nil, in); len(out) == 0 {
			t.Errorf("effect %d returned no audio", i)
		}
	}
}

func TestEffectsDoNotModifyInput(t *testing.T) {
	in := sineWave()
	orig := bytes.Clone(in)
	for _, fx := range []Effect{Must(PacketLoss(1, 20)), BreakingUp(WithSeed(1)), PhoneQuality(), Echo(10, 0.5)} {
		fx(nil, in)
	}
	if !bytes.Equal(in, orig) {
		t.Error("an effect modified its input")
	}
}

func TestCustomWrapsUserFunction(t *testing.T) {
	in := sineWave()
	called := false
	fx, err := Custom(func(b []byte) []byte {
		called = true
		out := make([]byte, len(b))
		for i := range b {
			out[i] = b[i] + 1
		}
		return out
	})
	if err != nil {
		t.Fatal(err)
	}
	out := fx(nil, in)
	if !called || !anySampleDiffers(in, out) {
		t.Error("custom function was not applied")
	}
	if _, err := Custom(nil); err == nil {
		t.Error("Custom(nil) did not fail")
	}
}

func TestOnTurnVolumesScaleMonotonically(t *testing.T) {
	in := sineWave()
	var energy []int
	for n := 1; n <= 3; n++ {
		out := Must(BackgroundNoise(Cafe, 0.1*float64(n)))(nil, in)
		if len(out) != len(in) {
			t.Fatalf("turn %d: length changed", n)
		}
		energy = append(energy, mixEnergy(in, out))
	}
	if energy[1] <= energy[0] || energy[2] <= energy[1] {
		t.Errorf("energy not monotone in volume: %v", energy)
	}
}

func TestArgumentValidation(t *testing.T) {
	if _, err := BackgroundNoise("disco", 0.3); err == nil {
		t.Error("unknown preset accepted")
	}
	if _, err := LowVolume(0); err == nil {
		t.Error("LowVolume(0) accepted")
	}
	if _, err := HighVolume(0.5); err == nil {
		t.Error("HighVolume(0.5) accepted")
	}
	if _, err := SpeakingFast(1); err == nil {
		t.Error("SpeakingFast(1) accepted")
	}
	if _, err := SpeakingSlow(1); err == nil {
		t.Error("SpeakingSlow(1) accepted")
	}
	if _, err := PacketLoss(1.5, 20); err == nil {
		t.Error("PacketLoss(1.5) accepted")
	}
}

func TestCustomWAVPathIsLoadedAndConverted(t *testing.T) {
	// A 12 kHz stereo WAV, which must be mixed to mono and resampled to 24 kHz.
	var pcm []byte
	for i := range 1200 {
		pcm = audio.AppendSample(pcm, int16(i))
		pcm = audio.AppendSample(pcm, int16(i+2))
	}
	f := audio.Format{SampleRate: 12000, Channels: 2, BitsPerSample: 16}
	path := filepath.Join(t.TempDir(), "noise.wav")
	if err := os.WriteFile(path, append(audio.AppendWAVHeader(nil, f, len(pcm)), pcm...), 0o600); err != nil {
		t.Fatal(err)
	}
	fx, err := BackgroundNoise(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	out := fx(nil, make([]byte, 4800*2))
	if audio.Sample(out, 0) != 1 || audio.Sample(out, 4799) != 1200 {
		t.Errorf("converted noise starts %d ends %d", audio.Sample(out, 0), audio.Sample(out, 4799))
	}
	if _, err := MultipleVoicesFrom(filepath.Join(t.TempDir(), "missing.wav"), 0.3); err == nil {
		t.Error("missing file accepted")
	}
}

func TestSeededEffectsAreReproducible(t *testing.T) {
	in := sineWave()
	a := Static(0.1, WithSeed(5))(nil, in)
	b := Static(0.1, WithSeed(5))(nil, in)
	if !bytes.Equal(a, b) {
		t.Error("same seed gave different static")
	}
}

func TestEmptyInputPassesThrough(t *testing.T) {
	for _, fx := range []Effect{PhoneQuality(), Robotic(), Echo(200, 0.5), Static(0.1), Must(SpeakingFast(2))} {
		if out := fx(nil, nil); len(out) != 0 {
			t.Errorf("empty input produced %d bytes", len(out))
		}
	}
}
