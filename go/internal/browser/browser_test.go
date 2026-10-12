package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeLangWatch struct {
	*httptest.Server
	mu       sync.Mutex
	requests []map[string]string
	paths    []string
	auth     []string
}

func (f *fakeLangWatch) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func startLangWatch(t *testing.T, delivered bool, status int, delay time.Duration) *fakeLangWatch {
	t.Helper()
	f := &fakeLangWatch{}
	release := make(chan struct{})
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.requests = append(f.requests, body)
		f.paths = append(f.paths, r.URL.Path)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-release:
			}
		}
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"nope"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"delivered": delivered, "url": "http://example.test/batch"})
	}))
	t.Cleanup(func() { close(release); f.Close() })
	return f
}

func location(set string) Location {
	return Location{BatchURL: "https://app.langwatch.test/proj/simulations/checkout-flow/batch-1", BatchRunID: "batch-1", ScenarioSetID: set}
}

// env isolates the browser environment and state directory of one test.
func env(t *testing.T) (dir string, opened *[]string, show func(f *fakeLangWatch, mods ...func(*Options, *Location)) Outcome) {
	t.Helper()
	for _, k := range []string{"SCENARIO_BROWSER", "SCENARIO_BROWSER_REOPEN_SECONDS", "SCENARIO_HEADLESS", "CI"} {
		t.Setenv(k, "")
	}
	dir = t.TempDir()
	t.Setenv("LANGWATCH_STATE_DIR", dir)
	var list []string
	opened = &list
	show = func(f *fakeLangWatch, mods ...func(*Options, *Location)) Outcome {
		o := Options{APIKey: "sk-lw-test", Opener: func(u string) error { list = append(list, u); return nil }}
		if f != nil {
			o.Endpoint = f.URL
		}
		loc := location("checkout-flow")
		for _, m := range mods {
			m(&o, &loc)
		}
		return Show(context.Background(), loc, o)
	}
	return dir, opened, show
}

func TestOpensWithTabKeyFirstTime(t *testing.T) {
	_, opened, show := env(t)
	f := startLangWatch(t, false, 0, 0)
	if got := show(f); got != Opened {
		t.Fatalf("outcome %s", got)
	}
	if len(*opened) != 1 || !strings.Contains((*opened)[0], "scenarioTab="+TabKey()) || !strings.HasPrefix((*opened)[0], location("").BatchURL) {
		t.Fatalf("opened %v", *opened)
	}
	if f.paths[0] != "/api/scenario-events/browser-tab" || f.auth[0] != "Bearer sk-lw-test" {
		t.Errorf("request %s %s", f.paths[0], f.auth[0])
	}
	want := map[string]string{"tabKey": TabKey(), "batchRunId": "batch-1", "scenarioSetId": "checkout-flow"}
	for k, v := range want {
		if f.requests[0][k] != v {
			t.Errorf("body %v", f.requests[0])
		}
	}
}

func TestHandsOffToListeningTab(t *testing.T) {
	_, opened, show := env(t)
	f := startLangWatch(t, true, 0, 0)
	for range 5 {
		if got := show(f); got != HandedOff {
			t.Fatalf("outcome %s", got)
		}
	}
	if len(*opened) != 0 || f.count() != 5 {
		t.Errorf("opened %v requests %d", *opened, f.count())
	}
}

func TestOpensAgainOnceTabIsGone(t *testing.T) {
	_, opened, show := env(t)
	if got := show(startLangWatch(t, true, 0, 0)); got != HandedOff {
		t.Fatalf("outcome %s", got)
	}
	if got := show(startLangWatch(t, false, 0, 0)); got != Opened || len(*opened) != 1 {
		t.Fatalf("outcome %s opened %v", got, *opened)
	}
}

func TestNoTabAnswerOverridesThrottle(t *testing.T) {
	_, opened, show := env(t)
	f := startLangWatch(t, false, 0, 0)
	show(f)
	if got := show(f); got != Opened || len(*opened) != 2 {
		t.Fatalf("outcome %s opened %v", got, *opened)
	}
}

func TestTabKeyIsStableAndShared(t *testing.T) {
	dir, _, _ := env(t)
	key := TabKey()
	if key == "" || TabKey() != key {
		t.Fatal("key must be stable")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "scenario-tab-key"))
	if strings.TrimSpace(string(b)) != key {
		t.Errorf("key file %q", b)
	}
}

func TestReusesKeyWrittenByAnotherSDK(t *testing.T) {
	dir, _, _ := env(t)
	_ = os.WriteFile(filepath.Join(dir, "scenario-tab-key"), []byte("written-by-python"), 0o644)
	if got := TabKey(); got != "written-by-python" {
		t.Errorf("key %q", got)
	}
}

func TestUnusableStateDirOnlyDisablesReuse(t *testing.T) {
	dir, opened, show := env(t)
	blocker := filepath.Join(dir, "not-a-directory")
	_ = os.WriteFile(blocker, nil, 0o644)
	t.Setenv("LANGWATCH_STATE_DIR", filepath.Join(blocker, "state"))
	f := startLangWatch(t, true, 0, 0)
	if got := show(f); got != Opened {
		t.Fatalf("outcome %s", got)
	}
	if f.count() != 0 || len(*opened) != 1 || (*opened)[0] != location("").BatchURL {
		t.Errorf("requests %d opened %v", f.count(), *opened)
	}
}

func TestThrottleWhenLangWatchCannotAnswer(t *testing.T) {
	_, opened, show := env(t)
	f := startLangWatch(t, false, http.StatusNotFound, 0)
	if got := show(f); got != Opened {
		t.Fatalf("first %s", got)
	}
	for range 2 {
		if got := show(f); got != SuppressedByThrottle {
			t.Fatalf("repeat %s", got)
		}
	}
	if got := show(f, func(_ *Options, l *Location) { l.ScenarioSetID = "onboarding" }); got != Opened {
		t.Errorf("other set %s", got)
	}
	if len(*opened) != 2 {
		t.Errorf("opened %v", *opened)
	}
}

func TestConfiguredThrottleWindow(t *testing.T) {
	_, _, show := env(t)
	t.Setenv("SCENARIO_BROWSER_REOPEN_SECONDS", "0")
	f := startLangWatch(t, false, http.StatusNotFound, 0)
	if first, second := show(f), show(f); first != Opened || second != Opened {
		t.Fatalf("a zero window must never throttle: %s then %s", first, second)
	}
}

func TestHangingLangWatchNeverStallsTheRun(t *testing.T) {
	_, _, show := env(t)
	f := startLangWatch(t, true, 0, 5*time.Second)
	start := time.Now()
	if got := show(f); got != Opened {
		t.Fatalf("outcome %s", got)
	}
	if time.Since(start) > 4500*time.Millisecond {
		t.Errorf("took %v", time.Since(start))
	}
}

func TestUnreachableLangWatchFallsBack(t *testing.T) {
	_, opened, show := env(t)
	got := show(nil, func(o *Options, _ *Location) { o.Endpoint = "http://127.0.0.1:1" })
	if got != Opened || len(*opened) != 1 {
		t.Fatalf("outcome %s opened %v", got, *opened)
	}
}

func TestNoHandoffWithoutCredentials(t *testing.T) {
	_, _, show := env(t)
	f := startLangWatch(t, true, 0, 0)
	if got := show(f, func(o *Options, _ *Location) { o.APIKey = "" }); got != Opened || f.count() != 0 {
		t.Fatalf("outcome %s requests %d", got, f.count())
	}
}

func TestResolvePolicy(t *testing.T) {
	env(t)
	for value, want := range map[string]Policy{"auto": PolicyAuto, "never": PolicyNever, "always": PolicyAlways, "ALWAYS": PolicyAlways, "nonsense": PolicyAuto} {
		t.Setenv("SCENARIO_BROWSER", value)
		if got := ResolvePolicy(false, nil); got != want {
			t.Errorf("%s: %s", value, got)
		}
	}
	t.Setenv("SCENARIO_BROWSER", "")
	if ResolvePolicy(true, nil) != PolicyNever {
		t.Error("headless must suppress")
	}
	t.Setenv("CI", "true")
	if ResolvePolicy(false, nil) != PolicyNever {
		t.Error("CI must suppress")
	}
	t.Setenv("CI", "false")
	if ResolvePolicy(false, nil) != PolicyAuto {
		t.Error("CI=false is not CI")
	}
	t.Setenv("SCENARIO_BROWSER", "always")
	if ResolvePolicy(true, nil) != PolicyAlways {
		t.Error("explicit policy must beat headless")
	}
}

func TestNeverAndAlwaysPolicies(t *testing.T) {
	_, opened, show := env(t)
	f := startLangWatch(t, true, 0, 0)
	t.Setenv("SCENARIO_BROWSER", "never")
	if got := show(f); got != SuppressedByPolicy || f.count() != 0 || len(*opened) != 0 {
		t.Fatalf("never: %s", got)
	}
	t.Setenv("SCENARIO_BROWSER", "always")
	if first, second := show(f), show(f); first != Opened || second != Opened || f.count() != 0 || len(*opened) != 2 {
		t.Fatalf("always: %s then %s, requests %d opened %v", first, second, f.count(), *opened)
	}
	t.Setenv("SCENARIO_BROWSER", "")
	if got := show(f, func(o *Options, _ *Location) { o.Headless = true }); got != SuppressedByPolicy {
		t.Errorf("headless: %s", got)
	}
}

func TestNoStateDirWritesNothingToWorkingDirectory(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "plan9" {
		t.Skip("the home directory does not come from $HOME here")
	}
	_, opened, show := env(t)
	t.Setenv("LANGWATCH_STATE_DIR", "")
	t.Setenv("HOME", "")
	cwd := t.TempDir()
	t.Chdir(cwd)
	f := startLangWatch(t, false, http.StatusNotFound, 0)
	if got := show(f); got != Opened {
		t.Fatalf("outcome %s", got)
	}
	if entries, _ := os.ReadDir(cwd); len(entries) != 0 {
		t.Errorf("working directory holds %v", entries)
	}
	if len(*opened) != 1 {
		t.Errorf("opened %v", *opened)
	}
}
