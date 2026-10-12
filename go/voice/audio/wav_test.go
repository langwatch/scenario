package audio

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWAVRoundTrip(t *testing.T) {
	pcm := []byte{1, 0, 2, 0, 0xff, 0x7f}
	w, err := ParseWAV(AppendWAV(nil, pcm))
	if err != nil {
		t.Fatal(err)
	}
	if w.Format != Canonical {
		t.Errorf("format = %+v", w.Format)
	}
	if !bytes.Equal(w.Data, pcm) {
		t.Errorf("data = %v", w.Data)
	}
}

func TestWriteWAVMatchesAppendWAV(t *testing.T) {
	pcm := make([]byte, 480)
	var buf bytes.Buffer
	if err := WriteWAV(&buf, pcm); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf.Bytes(), AppendWAV(nil, pcm)) {
		t.Error("WriteWAV and AppendWAV disagree")
	}
}

func TestWAVWriterPatchesSizes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.wav")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	ww, err := NewWAVWriter(f, Canonical)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := ww.Write(make([]byte, 960)); err != nil {
			t.Fatal(err)
		}
	}
	if err := ww.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, AppendWAV(nil, make([]byte, 2880))) {
		t.Error("streamed WAV differs from one-shot WAV")
	}
}

func TestParseWAVSkipsUnknownAndOddChunks(t *testing.T) {
	hdr := AppendWAVHeader(nil, Format{SampleRate: 8000, Channels: 2, BitsPerSample: 16}, 4)
	// Insert an odd-sized LIST chunk (padded) between fmt and data.
	b := append([]byte(nil), hdr[:36]...)
	b = append(b, "LIST"...)
	b = append(b, 3, 0, 0, 0, 'a', 'b', 'c', 0)
	b = append(b, hdr[36:]...)
	b = append(b, 1, 2, 3, 4)
	w, err := ParseWAV(b)
	if err != nil {
		t.Fatal(err)
	}
	if w.Format.SampleRate != 8000 || w.Format.Channels != 2 || !bytes.Equal(w.Data, []byte{1, 2, 3, 4}) {
		t.Errorf("parsed %+v", w)
	}
}

func TestParseWAVTruncatesOverlongData(t *testing.T) {
	b := append(AppendWAVHeader(nil, Canonical, 100), 1, 2)
	w, err := ParseWAV(b)
	if err != nil || len(w.Data) != 2 {
		t.Fatalf("data %v err %v", w.Data, err)
	}
}

func TestParseWAVRejectsNonWAV(t *testing.T) {
	if _, err := ParseWAV([]byte("not a wav file at all")); !errors.Is(err, ErrNotWAV) {
		t.Errorf("err = %v", err)
	}
}
