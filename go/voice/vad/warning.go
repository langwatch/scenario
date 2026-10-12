package vad

import (
	"fmt"
	"log"
	"sync"
)

// warned records which adapters have already been told the SDK-side
// fallback is in use. It is process-wide by design, as in the Python and
// JavaScript SDKs: the warning is about the adapter, not about one run.
var warned sync.Map // adapter name -> struct{}

// FallbackWarning is the text logged when an adapter without native VAD
// falls back to the SDK [Detector].
func FallbackWarning(adapterName string) string {
	return fmt.Sprintf("[scenario.voice] Adapter '%s' has no native VAD — using SDK-side VAD fallback. "+
		"Accuracy may differ from native VAD.", adapterName)
}

// WarnFallbackOnce emits [FallbackWarning] for adapterName at most once per
// process, through warn (log.Print when nil). It reports whether this call
// emitted it.
func WarnFallbackOnce(adapterName string, warn func(string)) bool {
	if _, loaded := warned.LoadOrStore(adapterName, struct{}{}); loaded {
		return false
	}
	if warn == nil {
		warn = func(s string) { log.Print(s) }
	}
	warn(FallbackWarning(adapterName))
	return true
}

// ResetFallbackWarnings forgets which adapters were warned, so tests can
// assert the one-shot behaviour reproducibly.
func ResetFallbackWarnings() { warned.Clear() }
