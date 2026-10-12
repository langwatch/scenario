// Package livetest holds the helpers of the live test suite: the tests,
// built with -tags integration, that run the SDK against real providers and
// a real LangWatch project. Every test skips, naming the missing variable,
// when its credentials are absent, so the suite is safe to run anywhere.
//
// It is shared by the root module, the provider modules, the voice module
// and the livetest module; it imports nothing but the root package.
package livetest

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// SetID groups every live run in LangWatch.
const SetID = "go-live"

// Require skips the test unless every named environment variable is set,
// naming the ones that are missing.
func Require(t testing.TB, names ...string) {
	t.Helper()
	var missing []string
	for _, n := range names {
		if os.Getenv(n) == "" {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		t.Skipf("missing env: %s", strings.Join(missing, ", "))
	}
}

// RequireAny skips the test unless at least one of the named environment
// variables is set, and returns the value of the first one set.
func RequireAny(t testing.TB, names ...string) string {
	t.Helper()
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	t.Skipf("missing env: one of %s", strings.Join(names, ", "))
	return ""
}

// RequireOptIn skips an expensive test unless name is set to "1".
func RequireOptIn(t testing.TB, name string) {
	t.Helper()
	if os.Getenv(name) != "1" {
		t.Skipf("missing env: %s=1 (expensive test, opt-in only)", name)
	}
}

// Env returns the value of name, or def when it is unset.
func Env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// Context returns a context cancelled after d or when the test ends.
func Context(t testing.TB, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}
