package voice

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sinkWith returns a sink whose player is cmd (ffmpeg's path is faked).
func sinkWith(t *testing.T, log *slog.Logger, cmd func() *exec.Cmd) *PlaybackSink {
	t.Helper()
	t.Setenv("SCENARIO_FFMPEG", os.Args[0])
	p := NewPlaybackSink(log)
	p.command = func(string, ...string) *exec.Cmd { return cmd() }
	return p
}

func TestPlaybackWritesPCMToThePlayer(t *testing.T) {
	out := filepath.Join(t.TempDir(), "played")
	p := sinkWith(t, nil, func() *exec.Cmd { return exec.Command("sh", "-c", "cat > "+out) })
	p.SendChunk(AudioChunk{Data: []byte{9, 9}}) // before Open: no-op
	p.Open()
	if !p.Active() {
		t.Fatal("not active after Open")
	}
	p.SendChunk(AudioChunk{Data: []byte{1, 2, 3, 4}})
	p.Close()
	b, _ := os.ReadFile(out)
	if !bytes.Equal(b, []byte{1, 2, 3, 4}) {
		t.Errorf("played %v", b)
	}
	if p.Active() {
		t.Error("active after Close")
	}
}

func TestPlaybackPlayerExitWarnsOnceAndDeactivates(t *testing.T) {
	var buf bytes.Buffer
	p := sinkWith(t, slog.New(slog.NewTextHandler(&buf, nil)), func() *exec.Cmd { return exec.Command("false") })
	p.Open()
	deadline := time.Now().Add(5 * time.Second)
	for p.Active() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if p.Active() {
		t.Fatal("still active after the player exited")
	}
	p.SendChunk(AudioChunk{Data: []byte{1, 2}})
	p.Close() // returns although the player already exited
	if c := strings.Count(buf.String(), "audioPlayback"); c != 1 {
		t.Errorf("%d warnings: %s", c, buf.String())
	}
}

func TestPlaybackWithoutFFmpegWarns(t *testing.T) {
	t.Setenv("SCENARIO_FFMPEG", filepath.Join(t.TempDir(), "missing"))
	var buf bytes.Buffer
	p := NewPlaybackSink(slog.New(slog.NewTextHandler(&buf, nil)))
	p.Open()
	p.Close()
	if p.Active() || !strings.Contains(buf.String(), "headless CI") {
		t.Errorf("active=%v log=%s", p.Active(), buf.String())
	}
}

func TestCloseNeverOpenedReturns(t *testing.T) {
	NewPlaybackSink(nil).Close()
}

func TestPlaybackSendChunkNeverWaitsForAStalledPlayer(t *testing.T) {
	// The player never reads stdin, as an ffmpeg wedged on its audio device.
	p := sinkWith(t, nil, func() *exec.Cmd { return exec.Command("sleep", "30") })
	p.closeTimeout = 200 * time.Millisecond
	p.Open()
	start := time.Now()
	for range playbackQueueChunks + 100 { // past the pipe buffer and the queue
		p.SendChunk(AudioChunk{Data: make([]byte, 4096)})
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("SendChunk blocked for %v", d)
	}
	start = time.Now()
	p.Close()
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("Close waited %v for a wedged player", d)
	}
	if p.Active() {
		t.Error("active after Close")
	}
}

func TestPlaybackKeepsChunkOrder(t *testing.T) {
	out := filepath.Join(t.TempDir(), "played")
	p := sinkWith(t, nil, func() *exec.Cmd { return exec.Command("sh", "-c", "cat > "+out) })
	p.Open()
	var want []byte
	for i := range 200 {
		b := bytes.Repeat([]byte{byte(i)}, 100)
		want = append(want, b...)
		p.SendChunk(AudioChunk{Data: b})
	}
	p.Close()
	if b, _ := os.ReadFile(out); !bytes.Equal(b, want) {
		t.Errorf("played %d bytes, want %d in order", len(b), len(want))
	}
}
