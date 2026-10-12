package voice_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/voicetest"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

var (
	spans = tracetest.NewInMemoryExporter()
	quiet = slog.New(slog.DiscardHandler)
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(spans))))
	os.Exit(m.Run())
}

// fastAgent wraps a fake transport with short turn timings.
func fastAgent(t voice.Transport, opts ...voice.AgentOption) *voice.Agent {
	a := voice.NewAgent(t, opts...)
	a.ResponseTimeout = 2e9
	a.ResponseTailSilence = 50e6
	a.TranscriptGraceWait = 0
	return a
}

// runScenario runs a voice scenario with the voicetest clock and a silent
// STT, failing the test on a run error.
func runScenario(t *testing.T, agents []scenario.AgentAdapter, script []scenario.ScriptStep, cfg voice.Config) *scenario.ScenarioResult {
	t.Helper()
	res, err := tryScenario(agents, script, cfg)
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	return res
}

func tryScenario(agents []scenario.AgentAdapter, script []scenario.ScriptStep, cfg voice.Config) (*scenario.ScenarioResult, error) {
	if cfg.STT == nil {
		cfg.STT = &voicetest.STT{}
	}
	if cfg.Logger == nil {
		cfg.Logger = quiet
	}
	return scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "voice test",
		Description: "a voice scenario",
		Agents:      agents,
		Script:      script,
	}, voice.WithConfig(cfg), scenario.WithQuiet())
}

func newBufLogger(w io.Writer) *slog.Logger { return slog.New(slog.NewTextHandler(w, nil)) }
