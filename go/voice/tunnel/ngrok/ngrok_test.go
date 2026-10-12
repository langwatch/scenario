package ngrok

import (
	"context"
	"strings"
	"testing"
)

func TestOpenNeedsAnAuthToken(t *testing.T) {
	t.Setenv("NGROK_AUTHTOKEN", "")
	_, err := Provider{}.Open(context.Background(), 8767)
	if err == nil || !strings.Contains(err.Error(), "NGROK_AUTHTOKEN") {
		t.Fatalf("err = %v", err)
	}
}
