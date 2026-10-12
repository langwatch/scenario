package scenario

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
)

// registerFake registers a provider under name that builds fakeLLMs and
// records the options of every build.
func registerFake(t *testing.T, name string) (builds *atomic.Int32, last *atomic.Pointer[ProviderOptions]) {
	t.Helper()
	builds, last = &atomic.Int32{}, &atomic.Pointer[ProviderOptions]{}
	RegisterProvider(name, func(o ProviderOptions) (LLM, error) {
		builds.Add(1)
		last.Store(&o)
		return &fakeLLM{answer: func(int, InferenceParams) (*InferenceResult, error) { return textAnswer("hi"), nil }}, nil
	})
	t.Cleanup(func() { RegisterProvider(name, nil) })
	return builds, last
}

func TestSplitModel(t *testing.T) {
	for _, tc := range []struct{ in, provider, name string }{
		{"openai/gpt-4.1-mini", "openai", "gpt-4.1-mini"},
		{"OpenRouter/anthropic/claude-sonnet-4.5", "openrouter", "anthropic/claude-sonnet-4.5"},
		{"gpt-4.1", "", "gpt-4.1"},
		{"", "", ""},
	} {
		p, n := SplitModel(tc.in)
		if p != tc.provider || n != tc.name {
			t.Errorf("SplitModel(%q) = %q, %q; want %q, %q", tc.in, p, n, tc.provider, tc.name)
		}
	}
}

func TestResolveBuildsOnceAndStripsProvider(t *testing.T) {
	builds, last := registerFake(t, "fake-resolve")
	cfg := ModelConfig{Model: "fake-resolve/model-a", APIKey: "k", Headers: map[string]string{"X": "1"}}
	first, err := cfg.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if first.Model != "model-a" || first.LLM == nil {
		t.Fatalf("resolved %+v", first)
	}
	if o := last.Load(); o.Provider != "fake-resolve" || o.APIKey != "k" || o.Headers["X"] != "1" {
		t.Fatalf("factory options %+v", o)
	}
	second, err := ModelConfig{Model: "fake-resolve/model-b", APIKey: "k", Headers: map[string]string{"X": "1"}}.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if second.LLM != first.LLM || builds.Load() != 1 {
		t.Fatalf("same options should share one LLM, builds=%d", builds.Load())
	}
	if _, err := (ModelConfig{Model: "fake-resolve/model-a", APIKey: "other"}).Resolve(); err != nil {
		t.Fatal(err)
	}
	if builds.Load() != 2 {
		t.Fatalf("another key needs its own LLM, builds=%d", builds.Load())
	}
}

func TestResolveKeepsExplicitLLM(t *testing.T) {
	llm := &fakeLLM{}
	got, err := ModelConfig{LLM: llm, Model: "openai/gpt-4o"}.Resolve()
	if err != nil || got.LLM != llm || got.Model != "openai/gpt-4o" {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestResolveErrors(t *testing.T) {
	if _, err := (ModelConfig{}).Resolve(); !errors.Is(err, ErrNoModel) {
		t.Fatalf("empty config: %v", err)
	}
	if _, err := (ModelConfig{Model: "gpt-4o"}).Resolve(); !errors.Is(err, ErrNoModel) {
		t.Fatalf("bare model: %v", err)
	}
	if _, err := (ModelConfig{Model: "not-registered/x"}).Resolve(); !errors.Is(err, ErrNoModel) {
		t.Fatalf("unregistered provider: %v", err)
	}
	RegisterProvider("fake-failing", func(ProviderOptions) (LLM, error) { return nil, errors.New("no key") })
	t.Cleanup(func() { RegisterProvider("fake-failing", nil) })
	if _, err := (ModelConfig{Model: "fake-failing/x"}).Resolve(); err == nil || errors.Is(err, ErrNoModel) {
		t.Fatalf("factory error should surface: %v", err)
	}
}

func TestRegisteredProvidersAndRemoval(t *testing.T) {
	registerFake(t, "Fake-Names")
	if !slices.Contains(RegisteredProviders(), "fake-names") {
		t.Fatalf("names are case-insensitive: %v", RegisteredProviders())
	}
	RegisterProvider("fake-names", nil)
	if slices.Contains(RegisteredProviders(), "fake-names") {
		t.Fatal("nil factory should remove the provider")
	}
}

func TestWithDefaults(t *testing.T) {
	registerFake(t, "fake-a")
	registerFake(t, "fake-b")
	defaultLLM := &fakeLLM{}
	temp := 0.3

	t.Run("empty model takes the default model and endpoint", func(t *testing.T) {
		got := ModelConfig{}.WithDefaults(ModelConfig{Model: "fake-a/m", APIKey: "k", BaseURL: "u", Temperature: &temp})
		if got.Model != "fake-a/m" || got.APIKey != "k" || got.BaseURL != "u" || got.Temperature != &temp {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("own provider does not inherit the default LLM", func(t *testing.T) {
		got := ModelConfig{Model: "fake-b/m"}.WithDefaults(ModelConfig{LLM: defaultLLM, Model: "x", APIKey: "k"})
		if got.LLM != nil || got.APIKey != "" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("same provider inherits the endpoint", func(t *testing.T) {
		got := ModelConfig{Model: "fake-a/other"}.WithDefaults(ModelConfig{Model: "fake-a/m", BaseURL: "u"})
		if got.BaseURL != "u" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("bare model keeps the default LLM", func(t *testing.T) {
		got := ModelConfig{Model: "gpt-x"}.WithDefaults(ModelConfig{LLM: defaultLLM, Model: "y"})
		if got.LLM != defaultLLM || got.Model != "gpt-x" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("bare model keeps the default provider string", func(t *testing.T) {
		got := ModelConfig{Model: "gpt-x"}.WithDefaults(ModelConfig{Model: "fake-a/m", APIKey: "k"})
		if got.Model != "fake-a/gpt-x" || got.APIKey != "k" {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestUserSimulatorResolvesModelString(t *testing.T) {
	registerFake(t, "fake-sim")
	sim := NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{Model: "fake-sim/small"}})
	ret, err := sim.Call(context.Background(), AgentInput{ScenarioConfig: ScenarioConfig{Description: "d"}})
	if err != nil {
		t.Fatal(err)
	}
	if msgs := ret.Messages(RoleUser); len(msgs) != 1 || msgs[0].Text() != "hi" {
		t.Fatalf("messages %+v", msgs)
	}
}
