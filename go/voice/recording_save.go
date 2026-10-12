package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/ffmpeg"
)

// Duration is the largest segment end time, in seconds.
func (r *VoiceRecording) Duration() float64 {
	d := 0.0
	for _, s := range r.Segments {
		d = max(d, s.EndTime)
	}
	return d
}

// ordered returns the segments sorted by start time.
func (r *VoiceRecording) ordered() []AudioSegment {
	out := slices.Clone(r.Segments)
	slices.SortStableFunc(out, func(a, b AudioSegment) int {
		switch {
		case a.StartTime < b.StartTime:
			return -1
		case a.StartTime > b.StartTime:
			return 1
		}
		return 0
	})
	return out
}

// FullWAV returns the whole conversation, segments in time order, as WAV.
func (r *VoiceRecording) FullWAV() []byte {
	segs := r.ordered()
	total := 0
	for _, s := range segs {
		total += len(s.Audio)
	}
	b := audio.AppendWAVHeader(make([]byte, 0, audio.WAVHeaderSize+total), audio.Canonical, total)
	for _, s := range segs {
		b = append(b, s.Audio...)
	}
	return b
}

// Save writes the conversation to path and returns the absolute path. The
// format is format when given, else the path's extension: wav is written
// natively; mp3, ogg and flac are transcoded through ffmpeg.
func (r *VoiceRecording) Save(ctx context.Context, path, format string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if format == "" {
		format = strings.TrimPrefix(filepath.Ext(abs), ".")
	}
	format = strings.ToLower(format)
	if format == "" {
		format = "wav"
	}
	switch format {
	case "wav":
		return abs, os.WriteFile(abs, r.FullWAV(), 0o644)
	case "mp3", "ogg", "flac":
	default:
		return "", fmt.Errorf("save(format=%q) not supported; allowed: flac, mp3, ogg, wav", format)
	}
	var pcm []byte
	for _, s := range r.ordered() {
		pcm = append(pcm, s.Audio...)
	}
	return abs, ffmpeg.Save(ctx, pcm, abs, format)
}

// SaveSegmentsOptions tune [VoiceRecording.SaveSegments].
type SaveSegmentsOptions struct {
	// NoManifest skips manifest.json.
	NoManifest bool
}

type manifestSegment struct {
	Idx                 int     `json:"idx"`
	File                string  `json:"file"`
	Role                Speaker `json:"role"`
	StartTime           float64 `json:"start_time"`
	EndTime             float64 `json:"end_time"`
	Duration            float64 `json:"duration"`
	Transcript          *string `json:"transcript"`
	TranscriptTruncated bool    `json:"transcript_truncated,omitempty"`
}

type manifestEvent struct {
	Time     float64        `json:"time"`
	Type     VoiceEventType `json:"type"`
	Metadata map[string]any `json:"metadata,omitempty"`
	Latency  *float64       `json:"latency,omitempty"`
}

type manifest struct {
	GeneratedAt  string            `json:"generated_at"`
	Duration     float64           `json:"duration"`
	SegmentCount int               `json:"segment_count"`
	Segments     []manifestSegment `json:"segments"`
	Events       []manifestEvent   `json:"events"`
}

// SaveSegments writes one WAV per segment under dir/segments, the whole
// conversation as dir/full.wav and, unless disabled, a dir/manifest.json
// pairing the files with transcripts and timestamps. Segment files are
// named <index>-<speaker>-<start ms>ms.wav. Existing files are kept. It
// returns the absolute directory.
func (r *VoiceRecording) SaveSegments(dir string, opts SaveSegmentsOptions) (string, error) {
	target, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	segDir := filepath.Join(target, "segments")
	if err := os.MkdirAll(segDir, 0o755); err != nil {
		return "", err
	}
	segs := r.ordered()
	entries := make([]manifestSegment, 0, len(segs))
	var wav []byte
	for i, s := range segs {
		name := fmt.Sprintf("%02d-%s-%04dms.wav", i, s.Speaker, int(s.StartTime*1000))
		wav = audio.AppendWAV(wav[:0], s.Audio)
		if err := os.WriteFile(filepath.Join(segDir, name), wav, 0o644); err != nil {
			return "", err
		}
		e := manifestSegment{
			Idx: i, File: "segments/" + name, Role: s.Speaker,
			StartTime: s.StartTime, EndTime: s.EndTime, Duration: s.EndTime - s.StartTime,
			TranscriptTruncated: s.TranscriptTruncated,
		}
		if s.Transcript != "" {
			tx := s.Transcript
			e.Transcript = &tx
		}
		entries = append(entries, e)
	}
	if err := os.WriteFile(filepath.Join(target, "full.wav"), r.FullWAV(), 0o644); err != nil {
		return "", err
	}
	if opts.NoManifest {
		return target, nil
	}
	timeline := slices.Clone(r.Timeline)
	slices.SortStableFunc(timeline, func(a, b VoiceEvent) int {
		switch {
		case a.Time < b.Time:
			return -1
		case a.Time > b.Time:
			return 1
		}
		return 0
	})
	events := make([]manifestEvent, len(timeline))
	for i, e := range timeline {
		events[i] = manifestEvent{Time: e.Time, Type: e.Type, Metadata: e.Metadata}
		if e.Type == AgentStartSpeaking {
			events[i].Latency = e.Latency
		}
	}
	m := manifest{
		GeneratedAt:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Duration:     r.Duration(),
		SegmentCount: len(segs),
		Segments:     entries,
		Events:       events,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		return "", err
	}
	return target, os.WriteFile(filepath.Join(target, "manifest.json"), bytes.TrimRight(buf.Bytes(), "\n"), 0o644)
}
