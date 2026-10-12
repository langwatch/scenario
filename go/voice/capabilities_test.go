package voice

import (
	"errors"
	"strings"
	"testing"
)

func TestUnsupportedCapabilityErrorNamesAdapterAndCapability(t *testing.T) {
	var err error = &UnsupportedCapabilityError{Adapter: "PipecatAgentAdapter", Capability: "dtmf", Hint: "Use a telephony adapter."}
	var uc *UnsupportedCapabilityError
	if !errors.As(err, &uc) {
		t.Fatal("not an UnsupportedCapabilityError")
	}
	msg := err.Error()
	for _, want := range []string{"'PipecatAgentAdapter'", "'dtmf'", "capability-matrix", "Use a telephony adapter."} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
}

func TestCapabilitiesDefaultToNothing(t *testing.T) {
	var c Capabilities
	if c.StreamingTranscripts || c.NativeVAD || c.DTMF || c.Interruption || c.InputFormats != nil {
		t.Error("zero Capabilities advertises something")
	}
}

func TestAudioChunkAliases(t *testing.T) {
	c := SilentChunk(0.25)
	if c.Seconds() != 0.25 || PCM16SampleRate != 24000 {
		t.Errorf("seconds %v rate %d", c.Seconds(), PCM16SampleRate)
	}
	if _, err := NewAudioChunk([]byte{1}, ""); err == nil {
		t.Error("odd-length chunk accepted")
	}
}
