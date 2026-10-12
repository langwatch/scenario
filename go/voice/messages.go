package voice

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"

	scenario "github.com/langwatch/scenario/go"
)

// MediaTypePCM16 is the media type of the canonical in-message audio part:
// raw PCM16, 24 kHz, mono.
const MediaTypePCM16 = scenario.MediaTypePCM16

// AudioMessage builds the canonical audio message: an audio/pcm16 file part,
// preceded by a text part carrying the transcript when the chunk has one.
// Audio travels in any role.
func AudioMessage(chunk AudioChunk, role scenario.Role) scenario.Message {
	parts := make([]scenario.Part, 0, 2)
	if chunk.Transcript != "" {
		parts = append(parts, scenario.TextPart(chunk.Transcript))
	}
	parts = append(parts, scenario.AudioPart(MediaTypePCM16, chunk.Data))
	return scenario.Message{Role: role, Parts: parts}
}

// ExtractAudio returns the first audio chunk of a message, with the
// transcript of the text part before it. It recognises the canonical audio
// file part and, at the adapter edge, the legacy OpenAI input_audio / audio
// custom parts. A WAV-wrapped payload is unwrapped to raw PCM16. ok is false
// when the message carries no audio, or audio that is not whole PCM16
// samples.
func ExtractAudio(m scenario.Message) (chunk AudioChunk, ok bool) {
	transcript := ""
	for _, p := range m.Parts {
		switch {
		case p.Type == scenario.PartText:
			if p.Text != "" {
				transcript = p.Text
			}
		case p.IsAudio():
			if p.URL != "" && p.Data == nil {
				continue
			}
			return newChunk(unwrapWAV(p.Data), transcript)
		case len(p.Raw) > 0 && (p.Type == "input_audio" || p.Type == "audio"):
			if data, tx, found := legacyAudio(p.Raw); found {
				if tx == "" {
					tx = transcript
				}
				return newChunk(unwrapWAV(data), tx)
			}
		}
	}
	return AudioChunk{}, false
}

func newChunk(data []byte, transcript string) (AudioChunk, bool) {
	c, err := NewAudioChunk(data, transcript)
	return c, err == nil
}

// legacyAudio decodes an OpenAI-convention {"type":"input_audio",
// "input_audio":{"data":…,"transcript":…}} part.
func legacyAudio(raw json.RawMessage) (data []byte, transcript string, ok bool) {
	var v struct {
		InputAudio *legacyPayload `json:"input_audio"`
		Audio      *legacyPayload `json:"audio"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return nil, "", false
	}
	payload := v.InputAudio
	if payload == nil {
		payload = v.Audio
	}
	if payload == nil || payload.Data == "" {
		return nil, "", false
	}
	b, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		return nil, "", false
	}
	return b, payload.Transcript, true
}

type legacyPayload struct {
	Data       string `json:"data"`
	Transcript string `json:"transcript"`
}

// unwrapWAV strips a RIFF/WAVE container down to its data chunk, so a legacy
// WAV payload decodes to raw PCM16. Raw payloads pass through.
func unwrapWAV(b []byte) []byte {
	if len(b) < 12 || !bytes.Equal(b[:4], []byte("RIFF")) {
		return b
	}
	for i := 12; i+8 <= len(b); i++ {
		if bytes.Equal(b[i:i+4], []byte("data")) {
			size := int(binary.LittleEndian.Uint32(b[i+4:]))
			start := i + 8
			return b[start:min(start+size, len(b))]
		}
	}
	if len(b) > 44 {
		return b[44:]
	}
	return nil
}

// MessageHasAudio reports whether the message carries extractable audio.
func MessageHasAudio(m scenario.Message) bool {
	_, ok := ExtractAudio(m)
	return ok
}

// ExtractTranscript returns the text of the message's first text part.
func ExtractTranscript(m scenario.Message) (string, bool) {
	for _, p := range m.Parts {
		if p.Type == scenario.PartText {
			return p.Text, true
		}
	}
	return "", false
}

// isAudioPart reports whether p carries audio in any recognised shape.
func isAudioPart(p scenario.Part) bool {
	return p.IsAudio() || p.Type == "input_audio" || p.Type == "audio"
}

// hasNonEmptyText reports whether a message has a non-blank text part.
func hasNonEmptyText(m scenario.Message) bool {
	for _, p := range m.Parts {
		if p.Type == scenario.PartText && strings.TrimSpace(p.Text) != "" {
			return true
		}
	}
	return false
}
