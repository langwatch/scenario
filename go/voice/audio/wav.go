package audio

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"slices"
)

// WAVHeaderSize is the size of the canonical 44-byte RIFF/WAVE PCM header.
const WAVHeaderSize = 44

// Format describes linear PCM audio.
type Format struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// Canonical is the canonical internal format: PCM16, 24 kHz, mono.
var Canonical = Format{SampleRate: SampleRate, Channels: Channels, BitsPerSample: 8 * SampleWidth}

func (f Format) blockAlign() int { return f.Channels * f.BitsPerSample / 8 }

// AppendWAVHeader appends a 44-byte PCM WAV header describing dataLen bytes
// of audio in format f.
func AppendWAVHeader(dst []byte, f Format, dataLen int) []byte {
	le := binary.LittleEndian
	dst = append(dst, "RIFF"...)
	dst = le.AppendUint32(dst, uint32(36+dataLen))
	dst = append(dst, "WAVEfmt "...)
	dst = le.AppendUint32(dst, 16) // fmt chunk size
	dst = le.AppendUint16(dst, 1)  // linear PCM
	dst = le.AppendUint16(dst, uint16(f.Channels))
	dst = le.AppendUint32(dst, uint32(f.SampleRate))
	dst = le.AppendUint32(dst, uint32(f.SampleRate*f.blockAlign()))
	dst = le.AppendUint16(dst, uint16(f.blockAlign()))
	dst = le.AppendUint16(dst, uint16(f.BitsPerSample))
	dst = append(dst, "data"...)
	return le.AppendUint32(dst, uint32(dataLen))
}

// AppendWAV appends canonical PCM16 wrapped in a WAV container to dst. It is
// the Go form of the JavaScript SDK's pcm16ToWav, used at the STT upload
// edge.
func AppendWAV(dst, pcm []byte) []byte {
	dst = AppendWAVHeader(slices.Grow(dst, WAVHeaderSize+len(pcm)), Canonical, len(pcm))
	return append(dst, pcm...)
}

// WriteWAV streams canonical PCM16 as a WAV file to w, without first
// concatenating header and audio into one buffer.
func WriteWAV(w io.Writer, pcm []byte) error {
	var hdr [WAVHeaderSize]byte
	if _, err := w.Write(AppendWAVHeader(hdr[:0], Canonical, len(pcm))); err != nil {
		return err
	}
	_, err := w.Write(pcm)
	return err
}

// WAV is a parsed WAV file. Data aliases the parsed buffer; nothing is copied.
type WAV struct {
	Format Format
	// Data is the raw sample bytes of the data chunk.
	Data []byte
}

// ErrNotWAV reports input without a RIFF/WAVE signature.
var ErrNotWAV = errors.New("audio: not a RIFF/WAVE file")

// ParseWAV parses a RIFF/WAVE buffer. It walks the chunk list the way the
// JavaScript SDK does (odd chunk sizes are padded, a data chunk running past
// the end of the buffer is truncated) and returns the format and a view of
// the sample data. It does not convert anything. A fmt chunk with a zero
// sample rate, channel count or sample width is an error, so callers can
// divide by them.
func ParseWAV(b []byte) (WAV, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return WAV{}, ErrNotWAV
	}
	le := binary.LittleEndian
	var w WAV
	haveFmt, haveData := false, false
	for off := 12; off+8 <= len(b); {
		id := string(b[off : off+4])
		size := int(le.Uint32(b[off+4:]))
		body := b[off+8:]
		switch id {
		case "fmt ":
			if len(body) < 16 {
				return WAV{}, fmt.Errorf("audio: truncated WAV fmt chunk")
			}
			w.Format = Format{
				Channels:      int(le.Uint16(body[2:])),
				SampleRate:    int(le.Uint32(body[4:])),
				BitsPerSample: int(le.Uint16(body[14:])),
			}
			haveFmt = true
		case "data":
			w.Data = body[:min(size, len(body))]
			haveData = true
		}
		if size > len(body) {
			break
		}
		off += 8 + size + size%2
	}
	if !haveFmt {
		return WAV{}, fmt.Errorf("audio: WAV has no fmt chunk")
	}
	if f := w.Format; f.SampleRate <= 0 || f.Channels <= 0 || f.BitsPerSample <= 0 {
		return WAV{}, fmt.Errorf("audio: invalid WAV format (%d Hz, %d channels, %d bits)", f.SampleRate, f.Channels, f.BitsPerSample)
	}
	if !haveData {
		return WAV{}, fmt.Errorf("audio: WAV has no data chunk")
	}
	return w, nil
}
