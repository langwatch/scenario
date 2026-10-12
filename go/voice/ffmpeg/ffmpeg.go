// Package ffmpeg finds an ffmpeg binary and uses it to decode and encode the
// audio formats the voice subsystem does not handle natively (mp3, ogg,
// flac, ...). WAV never needs it.
//
// Unlike the JavaScript and Python SDKs, the Go SDK bundles no ffmpeg: it
// uses $SCENARIO_FFMPEG when set, else "ffmpeg" on PATH, and reports a clear
// [ErrNotFound] when neither exists.
package ffmpeg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// PathEnv names an explicit ffmpeg binary, taking precedence over PATH.
const PathEnv = "SCENARIO_FFMPEG"

// ErrNotFound reports that no ffmpeg binary could be located.
var ErrNotFound = errors.New("ffmpeg not found")

// Path locates the ffmpeg binary: $SCENARIO_FFMPEG if set (it must exist),
// else "ffmpeg" on PATH. It looks afresh on every call.
func Path() (string, error) {
	if p := strings.TrimSpace(os.Getenv(PathEnv)); p != "" {
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			return "", fmt.Errorf("%w: %s=%q does not name an ffmpeg binary", ErrNotFound, PathEnv, p)
		}
		return p, nil
	}
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("%w: install ffmpeg (for example `brew install ffmpeg` or `apt-get install ffmpeg`) "+
			"or set %s to its path; it is needed only for non-WAV audio", ErrNotFound, PathEnv)
	}
	return p, nil
}

// baseArgs keep ffmpeg local and quiet: no network protocols (only files and
// pipes), errors only, overwrite outputs.
var baseArgs = [...]string{"-protocol_whitelist", "file,pipe", "-loglevel", "error", "-y"}

// run executes ffmpeg with args after baseArgs, feeding stdin, and returns
// its stdout.
func run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	bin, err := Path()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, bin, append(baseArgs[:], args...)...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		// A cancelled context kills ffmpeg; report why, not the kill.
		if cerr := ctx.Err(); cerr != nil {
			return nil, fmt.Errorf("ffmpeg: %w", cerr)
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("ffmpeg failed: %s", strings.TrimSpace(stderr.String()))
		}
		return nil, fmt.Errorf("ffmpeg subprocess failed: %w", err)
	}
	return stdout.Bytes(), nil
}
