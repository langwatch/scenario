package voice

import (
	"io"
	"log/slog"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/ffmpeg"
)

const (
	// playbackQueueChunks bounds the audio waiting for the player. ffmpeg
	// takes it at real time, so a full queue means the player has fallen
	// far behind (or stalled); later chunks are dropped, not waited for.
	playbackQueueChunks = 1024
	// playbackCloseTimeout bounds how long Close waits for the player to
	// finish the queued audio before killing it.
	playbackCloseTimeout = 3 * time.Second
)

// PlaybackSink streams conversation audio to the local speakers through an
// ffmpeg subprocess. It is best effort: without ffmpeg or an audio device
// (headless CI) it warns once and drops the audio.
//
// SendChunk never blocks: chunks go to a queue a writer goroutine feeds to
// ffmpeg's stdin, which ffmpeg drains only as fast as it plays.
type PlaybackSink struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	queue   chan []byte
	done    chan struct{}
	active  bool
	warned  bool
	dropped bool
	log     *slog.Logger
	// command builds the subprocess; tests replace it.
	command func(bin string, args ...string) *exec.Cmd
	// closeTimeout is playbackCloseTimeout; tests shorten it.
	closeTimeout time.Duration
}

// NewPlaybackSink returns a closed sink; Open starts playback.
func NewPlaybackSink(log *slog.Logger) *PlaybackSink {
	if log == nil {
		log = slog.Default()
	}
	return &PlaybackSink{log: log, command: exec.Command, closeTimeout: playbackCloseTimeout}
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
	queue := make(chan []byte, playbackQueueChunks)
	p.cmd, p.queue, p.active, p.done = cmd, queue, true, done
	go p.feed(stdin, queue)
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

// feed writes queued audio to the player until the queue is closed, then
// closes stdin so ffmpeg finishes. After a failed write it discards the rest.
func (p *PlaybackSink) feed(stdin io.WriteCloser, queue <-chan []byte) {
	failed := false
	for b := range queue {
		if failed {
			continue
		}
		if _, err := stdin.Write(b); err != nil {
			failed = true
			p.mu.Lock()
			p.active = false
			p.mu.Unlock()
		}
	}
	_ = stdin.Close()
}

// SendChunk queues a chunk for playback without waiting for the player. A
// chunk that finds the queue full is dropped.
func (p *PlaybackSink) SendChunk(c AudioChunk) {
	if len(c.Data) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.active || p.queue == nil {
		return
	}
	select {
	case p.queue <- append([]byte(nil), c.Data...):
	default:
		if !p.dropped {
			p.dropped = true
			p.log.Debug("[scenario] audioPlayback: player fell behind, dropping audio")
		}
	}
}

// Close stops playback after the queued audio, waiting at most a few
// seconds for the player before killing it.
func (p *PlaybackSink) Close() {
	p.mu.Lock()
	cmd, queue, done := p.cmd, p.queue, p.done
	p.active, p.queue, p.cmd, p.done = false, nil, nil, nil
	p.mu.Unlock()
	if queue != nil {
		close(queue)
	}
	if done == nil {
		return
	}
	t := time.NewTimer(p.closeTimeout)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		// A wedged player: killing it also fails a write blocked on its
		// stdin (Wait closes the pipe), so the feeder ends too.
		_ = cmd.Process.Kill()
		<-done
	}
}
