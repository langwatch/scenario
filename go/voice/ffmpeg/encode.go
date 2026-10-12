package ffmpeg

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Save writes canonical PCM16 to path in format ("wav", "mp3", "ogg" or
// "flac"). WAV is written natively; the other formats need ffmpeg.
func Save(ctx context.Context, pcm []byte, path, format string) error {
	format = strings.ToLower(format)
	switch format {
	case "wav", "mp3", "ogg", "flac":
	default:
		return fmt.Errorf("save format %q not supported; allowed: flac, mp3, ogg, wav", format)
	}
	if format == "wav" {
		f, err := os.Create(path)
		if err != nil {
			return err
		}
		if err := audio.WriteWAV(f, pcm); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	}
	wav := audio.AppendWAV(nil, pcm)
	if _, err := run(ctx, wav, "-f", "wav", "-i", "pipe:0", "-f", format, path); err != nil {
		return fmt.Errorf("transcode to %q: %w", format, err)
	}
	return nil
}
