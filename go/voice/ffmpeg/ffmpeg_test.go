package ffmpeg

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
)

// fakeFFmpeg installs a shell script as $SCENARIO_FFMPEG that records its
// arguments and stdin and prints four PCM bytes. It returns the directory
// holding args.txt and stdin.bin.
func fakeFFmpeg(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake needs a POSIX shell")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + dir + "/args.txt\ncat > " + dir + "/stdin.bin\nprintf '\\001\\000\\002\\000'\n"
	bin := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(PathEnv, bin)
	return dir
}

func args(t *testing.T, dir string) []string {
	b, err := os.ReadFile(filepath.Join(dir, "args.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(b))
}

func TestPathPrefersEnvironment(t *testing.T) {
	dir := fakeFFmpeg(t)
	if p, err := Path(); err != nil || p != filepath.Join(dir, "ffmpeg") {
		t.Errorf("Path() = %q, %v", p, err)
	}
}

func TestPathReportsMissingBinaryClearly(t *testing.T) {
	t.Setenv(PathEnv, filepath.Join(t.TempDir(), "nope"))
	if _, err := Path(); !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), PathEnv) {
		t.Errorf("err = %v", err)
	}
	t.Setenv(PathEnv, "")
	t.Setenv("PATH", t.TempDir())
	_, err := Path()
	if !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), "install ffmpeg") {
		t.Errorf("err = %v", err)
	}
	if _, err := DecodeBytes(context.Background(), []byte("ID3 not a wav")); !errors.Is(err, ErrNotFound) {
		t.Errorf("DecodeBytes err = %v", err)
	}
}

func TestDecodeFileUsesFFmpegForNonWAV(t *testing.T) {
	dir := fakeFFmpeg(t)
	mp3 := filepath.Join(t.TempDir(), "clip.mp3")
	os.WriteFile(mp3, []byte("ID3"), 0o600)
	pcm, err := DecodeFile(context.Background(), mp3)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pcm, []byte{1, 0, 2, 0}) {
		t.Errorf("pcm %v", pcm)
	}
	want := []string{"-protocol_whitelist", "file,pipe", "-loglevel", "error", "-y", "-i", mp3, "-f", "s16le", "-ac", "1", "-ar", "24000", "pipe:1"}
	if got := args(t, dir); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("args %q", got)
	}
}

func TestDecodeBytesPipesInput(t *testing.T) {
	dir := fakeFFmpeg(t)
	if _, err := DecodeBytes(context.Background(), []byte("OggS....")); err != nil {
		t.Fatal(err)
	}
	if got := args(t, dir); got[6] != "pipe:0" {
		t.Errorf("args %q", got)
	}
	if in, _ := os.ReadFile(filepath.Join(dir, "stdin.bin")); string(in) != "OggS...." {
		t.Errorf("stdin %q", in)
	}
}

func TestDecodeRefusesURLs(t *testing.T) {
	for _, u := range []string{"http://x/a.mp3", "file:///tmp/a.wav", "rtmp+tls://x"} {
		if _, err := DecodeFile(context.Background(), u); err == nil || !strings.Contains(err.Error(), "URL-like") {
			t.Errorf("%s: err = %v", u, err)
		}
	}
	if isURLLike("C:/audio.wav") || isURLLike("clips/a.wav") || isURLLike("1http://x") {
		t.Error("plain path treated as URL")
	}
}

func TestWAVNeedsNoFFmpeg(t *testing.T) {
	t.Setenv(PathEnv, filepath.Join(t.TempDir(), "absent"))
	canonical := audio.AppendWAV(nil, []byte{5, 0, 6, 0})
	if pcm, err := DecodeBytes(context.Background(), canonical); err != nil || !bytes.Equal(pcm, []byte{5, 0, 6, 0}) {
		t.Errorf("canonical WAV: %v %v", pcm, err)
	}
	// 8 kHz stereo: averaged to mono, then resampled to 24 kHz.
	var st []byte
	for range 80 {
		st = audio.AppendSample(audio.AppendSample(st, 100), 300)
	}
	f := audio.Format{SampleRate: 8000, Channels: 2, BitsPerSample: 16}
	path := filepath.Join(t.TempDir(), "st.wav")
	os.WriteFile(path, append(audio.AppendWAVHeader(nil, f, len(st)), st...), 0o600)
	pcm, err := DecodeFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(pcm) != 2*240 || audio.Sample(pcm, 0) != 200 || audio.Sample(pcm, 239) != 200 {
		t.Errorf("%d bytes, first %d", len(pcm), audio.Sample(pcm, 0))
	}
}

func TestSaveWAVAndTranscode(t *testing.T) {
	out := filepath.Join(t.TempDir(), "rec.wav")
	if err := Save(context.Background(), []byte{1, 0}, out, "WAV"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); !bytes.Equal(b, audio.AppendWAV(nil, []byte{1, 0})) {
		t.Error("saved WAV differs")
	}
	if err := Save(context.Background(), nil, out, "aac"); err == nil {
		t.Error("unsupported format accepted")
	}
	dir := fakeFFmpeg(t)
	mp3 := filepath.Join(t.TempDir(), "rec.mp3")
	if err := Save(context.Background(), []byte{1, 0}, mp3, "mp3"); err != nil {
		t.Fatal(err)
	}
	if got := args(t, dir); strings.Join(got[5:], " ") != "-f wav -i pipe:0 -f mp3 "+mp3 {
		t.Errorf("args %q", got)
	}
}

// TestRealFFmpegRoundTrip runs only where a real ffmpeg is installed.
func TestRealFFmpegRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil || os.Getenv(PathEnv) != "" {
		t.Skip("no real ffmpeg on PATH")
	}
	tone := make([]byte, 0, 48000)
	for i := range 24000 {
		tone = audio.AppendSample(tone, int16((i%48)*500-12000))
	}
	path := filepath.Join(t.TempDir(), "tone.flac")
	if err := Save(context.Background(), tone, path, "flac"); err != nil {
		t.Fatal(err)
	}
	pcm, err := DecodeFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pcm, tone) {
		t.Errorf("lossless round trip changed audio (%d vs %d bytes)", len(pcm), len(tone))
	}
}

func TestCancelledRunReportsTheContext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake needs a POSIX shell")
	}
	bin := filepath.Join(t.TempDir(), "ffmpeg")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexec sleep 10\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(PathEnv, bin)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := DecodeBytes(ctx, []byte("OggS....")); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v", err)
	}
}

func TestZeroRateWAVDoesNotReachTheResampler(t *testing.T) {
	fakeFFmpeg(t)
	b := append(audio.AppendWAVHeader(nil, audio.Format{Channels: 1, BitsPerSample: 16}, 4), 1, 0, 2, 0)
	// Not decodable natively: handed to (the fake) ffmpeg instead of dividing by zero.
	if pcm, err := DecodeBytes(context.Background(), b); err != nil || !bytes.Equal(pcm, []byte{1, 0, 2, 0}) {
		t.Errorf("pcm %v, err %v", pcm, err)
	}
}
