package apihttp

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDoIgnoresAHugeContentLength(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: 1 << 50, // would be a petabyte up front
			Body:          io.NopCloser(strings.NewReader("ok")),
		}, nil
	})}
	req, _ := http.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	b, err := Do(client, req, "test call")
	if err != nil || string(b) != "ok" {
		t.Fatalf("got %q, %v", b, err)
	}
}

func TestDoReportsStatusErrors(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusTeapot, Body: io.NopCloser(strings.NewReader(" short and stout "))}, nil
	})}
	req, _ := http.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	_, err := Do(client, req, "test call")
	se, ok := err.(*StatusError)
	if !ok || se.StatusCode != http.StatusTeapot || se.Body != "short and stout" {
		t.Fatalf("err = %#v", err)
	}
}
