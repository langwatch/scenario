package twilio

// Ported from twilio-server.test.ts: the TwiML voice endpoint and its
// signature gate, over the real local server.

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

func TestVoiceEndpointServesEscapedConnectStream(t *testing.T) {
	a := makeAdapter(t, newSpyREST(), func(o *Options) { o.PublicBaseURL = "https://example.test/voice?room=a&peer=b" })
	connected(t, a)
	resp, body := postVoice(t, a, url.Values{"From": {"+14155557777"}, "To": {"+14155551234"}, "CallSid": {"CAabc"}}, "")
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "application/xml") {
		t.Fatalf("%d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	for _, want := range []string{"<Connect><Stream url=", "wss://example.test", "/twilio/stream", "</Connect>", "&amp;peer=b"} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q: %s", want, body)
		}
	}
	if regexp.MustCompile(`url="[^"]*&[^a]`).MatchString(body) {
		t.Errorf("bare & in the url attribute: %s", body)
	}
}

func TestVoiceEndpointRejectsAMissingSignature(t *testing.T) {
	a := makeAdapter(t, newSpyREST(), func(o *Options) { o.SkipSignatureValidation = false })
	connected(t, a)
	resp, _ := postVoice(t, a, url.Values{"From": {"+14155557777"}, "CallSid": {"CAabc"}}, "")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if n := state(a, func(a *Adapter) int { return a.rejected }); n != 1 {
		t.Fatalf("rejected %d", n)
	}
}

func TestVoiceEndpointRoutesAndLimits(t *testing.T) {
	a := connected(t, makeAdapter(t, newSpyREST()))
	base, _ := a.LocalBaseURL()
	resp, err := http.Get(base + "/this-path-404s")
	if err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET: %v %v", resp, err)
	}
	resp.Body.Close()
	big := strings.NewReader("From=" + strings.Repeat("x", maxWebhookBody+1))
	resp, err = http.Post(base+"/twilio/voice", "application/x-www-form-urlencoded", big)
	if err != nil || resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized POST: %v %v", resp, err)
	}
	resp.Body.Close()
}
