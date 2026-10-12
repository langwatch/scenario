package scenario

import "testing"

// SCENARIO_HEADLESS=false (or 0) must not turn headless mode on.
func TestHeadlessEnvParsing(t *testing.T) {
	for v, want := range map[string]bool{"true": true, "1": true, "yes": true, "false": false, "FALSE": false, "0": false, "": false} {
		t.Setenv("SCENARIO_HEADLESS", v)
		if headlessFromEnv() != want {
			t.Errorf("SCENARIO_HEADLESS=%q: got %v", v, !want)
		}
	}
}
