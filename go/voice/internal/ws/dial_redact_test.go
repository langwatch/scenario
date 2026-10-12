package ws

import (
	"context"
	"net"
	"strings"
	"testing"
)

// A failed dial must not print a signed URL's query string: it carries the
// credential (ElevenLabs' conversation_signature) into logs and spans.
func TestDialErrorRedactsTheQueryString(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens: the dial is refused

	for _, raw := range []string{
		"ws://" + addr + "/v1/convai?agent_id=a&conversation_signature=s3cret",
		"ws://user:p4ss@" + addr + "/v1/convai?conversation_signature=s3cret",
		"ws://" + addr + "/%zz?conversation_signature=s3cret", // a parse failure
	} {
		_, _, err := Dial(context.Background(), raw, nil)
		if err == nil {
			t.Fatalf("dial %s succeeded", raw)
		}
		if msg := err.Error(); strings.Contains(msg, "s3cret") || strings.Contains(msg, "p4ss") {
			t.Fatalf("error leaks the credential: %s", msg)
		}
		if !strings.Contains(err.Error(), "[redacted]") {
			t.Fatalf("error does not mark the redaction: %v", err)
		}
	}
}
