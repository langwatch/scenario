// Package examples holds runnable voice scenarios, the Go ports of the
// JavaScript SDK's voice demos (javascript/examples/vitest/tests/voice).
//
// Each example is a test that talks to a live vendor. It skips itself when
// the keys it needs are not set, so `go test ./...` passes without secrets:
//
//	OPENAI_API_KEY=... go test -run TestOpenAIRealtimeAgent -v ./...
//
// Recordings (full.wav, one WAV per segment, manifest.json) are written under
// $SCENARIO_RECORDINGS_DIR, by default the system temp directory.
package examples
