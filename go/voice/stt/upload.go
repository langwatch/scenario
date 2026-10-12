package stt

import (
	"bytes"
	"mime/multipart"
	"net/textproto"

	"github.com/langwatch/scenario/go/voice/audio"
)

// wavUpload builds a multipart/form-data body carrying pcm as "audio.wav"
// in field fileField, plus the given text fields. The WAV is streamed into
// the body buffer, which is sized up front, so the audio is copied once.
func wavUpload(fileField string, pcm []byte, fields ...[2]string) (*bytes.Buffer, string, error) {
	body := bytes.NewBuffer(make([]byte, 0, len(pcm)+audio.WAVHeaderSize+512))
	w := multipart.NewWriter(body)
	for _, f := range fields {
		if err := w.WriteField(f[0], f[1]); err != nil {
			return nil, "", err
		}
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="`+fileField+`"; filename="audio.wav"`)
	h.Set("Content-Type", "audio/wav")
	part, err := w.CreatePart(h)
	if err != nil {
		return nil, "", err
	}
	if err := audio.WriteWAV(part, pcm); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return body, w.FormDataContentType(), nil
}
