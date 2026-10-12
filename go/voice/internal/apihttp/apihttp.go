// Package apihttp holds the small HTTP plumbing shared by the speech
// provider clients: sending a request, reading the body, and turning a
// non-2xx response into an error that names the call and quotes the body.
package apihttp

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	// maxErrorBody caps how much of an error response is quoted.
	maxErrorBody = 2048
	// maxPrealloc caps the buffer sized up front from Content-Length, so a
	// bogus header cannot demand a huge allocation; a longer body still
	// reads, growing as it arrives.
	maxPrealloc = 64 << 20
)

// StatusError is a non-2xx response from a provider API.
type StatusError struct {
	// Op names the call, for example "OpenAI transcription".
	Op string
	// StatusCode is the HTTP status.
	StatusCode int
	// Body is the start of the response body.
	Body string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s failed: HTTP %d: %s", e.Op, e.StatusCode, e.Body)
}

// Do sends req and returns the response body of a 2xx response. Any other
// status is a *StatusError.
func Do(client *http.Client, req *http.Request, op string) ([]byte, error) {
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, &StatusError{Op: op, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	// Size the buffer from Content-Length (plus bytes.MinRead, which
	// ReadFrom keeps free) so a known-length body is read without regrowing.
	buf := bytes.NewBuffer(make([]byte, 0, min(max(resp.ContentLength, 0), maxPrealloc)+bytes.MinRead))
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return nil, fmt.Errorf("%s: reading response: %w", op, err)
	}
	return buf.Bytes(), nil
}

// JoinURL joins a base URL and a path with exactly one slash.
func JoinURL(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}
