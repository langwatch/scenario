package audio

import (
	"errors"
	"io"
)

// WAVWriter streams PCM audio of unknown total length into a WAV file. It
// writes a placeholder header, passes audio straight through to the
// underlying writer, and patches the RIFF and data sizes on Close, so a long
// recording is never held in memory.
type WAVWriter struct {
	w      io.WriteSeeker
	f      Format
	n      int64
	closed bool
}

// NewWAVWriter writes a placeholder header for format f to w and returns a
// writer for the sample data.
func NewWAVWriter(w io.WriteSeeker, f Format) (*WAVWriter, error) {
	var hdr [WAVHeaderSize]byte
	if _, err := w.Write(AppendWAVHeader(hdr[:0], f, 0)); err != nil {
		return nil, err
	}
	return &WAVWriter{w: w, f: f}, nil
}

// Write appends sample bytes to the data chunk.
func (ww *WAVWriter) Write(p []byte) (int, error) {
	if ww.closed {
		return 0, errors.New("audio: write to closed WAVWriter")
	}
	n, err := ww.w.Write(p)
	ww.n += int64(n)
	return n, err
}

// Close rewrites the header with the final sizes and leaves the underlying
// writer positioned at its end. It does not close the underlying writer.
func (ww *WAVWriter) Close() error {
	if ww.closed {
		return nil
	}
	ww.closed = true
	if _, err := ww.w.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var hdr [WAVHeaderSize]byte
	if _, err := ww.w.Write(AppendWAVHeader(hdr[:0], ww.f, int(ww.n))); err != nil {
		return err
	}
	_, err := ww.w.Seek(0, io.SeekEnd)
	return err
}
