package voice

import (
	"io"
	"log/slog"
	"os/exec"
	"runtime"
	"strconv"
	"sync"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/ffmpeg"
)

// PlaybackSink streams conversation audio to the local speakers through an
// ffmpeg subprocess. It is best effort: without ffmpeg or an audio device
// (headless CI) it warns once and drops the audio.
type PlaybackSink struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	done   chan struct{}
	active bool
	warned bool
	log    *slog.Logger
	// command builds the subprocess; tests replace it.
	command func(bin string, args ...string) *exec.Cmd
}

// NewPlaybackSink returns a closed sink; Open starts playback.
func NewPlaybackSink(log *slog.Logger) *PlaybackSink {
	if log == nil {
		log = slog.Default()
	}
	return &PlaybackSink{log: log, command: exec.Command}
}

func playbackOutputArgs() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"-f", "audiotoolbox", "-"}
	case "windows":
		return []string{"-f", "dshow", "audio=default"}
	}
	return []string{"-f", "alsa", "default"}
}

// Open starts the ffmpeg player.
func (p *PlaybackSink) Open() {
	p.mu.Lock()
	defer p.mu.Unlock()
	bin, err := ffmpeg.Path()
	if err != nil {
		p.warnLocked("failed to start ffmpeg subprocess — audio will not be played locally. (" + err.Error() + ")")
		return
	}
	args := append([]string{"-loglevel", "error", "-f", "s16le", "-ac", "1",
		"-ar", strconv.Itoa(audio.SampleRate), "-i", "pipe:0"}, playbackOutputArgs()...)
	cmd := p.command(bin, args...)
	stdin, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		p.warnLocked("failed to spawn ffmpeg — audio will not be played locally. (" + err.Error() + ")")
		return
	}
	done := make(chan struct{})
	p.cmd, p.stdin, p.active, p.done = cmd, stdin, true, done
	go func() {
		defer close(done)
		err := cmd.Wait()
		p.mu.Lock()
		defer p.mu.Unlock()
		if err != nil && p.active {
			p.warnLocked("ffmpeg exited (" + err.Error() + ") — no audio device available. Audio will not be played locally.")
		}
		p.active = false
	}()
}

func (p *PlaybackSink) warnLocked(msg string) {
	if p.warned {
		return
	}
	p.warned = true
	p.log.Warn("[scenario] audioPlayback: " + msg + " This is normal on headless CI.")
}

// Active reports whether audio is being played.
func (p *PlaybackSink) Active() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}

// SendChunk queues a chunk for playback.
func (p *PlaybackSink) SendChunk(c AudioChunk) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.active || p.stdin == nil {
		return
	}
	if _, err := p.stdin.Write(c.Data); err != nil {
		p.active = false
	}
}

// Close stops playback after the queued audio.
func (p *PlaybackSink) Close() {
	p.mu.Lock()
	stdin, done := p.stdin, p.done
	p.active, p.stdin, p.cmd, p.done = false, nil, nil, nil
	p.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if done != nil {
		<-done
	}
}
