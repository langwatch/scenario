package scenario

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
)

// alertLogger prints the console banners about event reporting: the
// greeting when no API key is set, and the "follow it live" link once per
// scenario set. Coordination files in the temp directory keep parallel test
// processes of one batch from printing them twice.
type alertLogger struct {
	out        io.Writer
	batchRunID string
	disabled   bool
	headless   bool
	opener     BatchRunOpener
}

func newAlertLogger(batchRunID string, s *Settings) *alertLogger {
	return &alertLogger{
		out:        os.Stdout,
		batchRunID: batchRunID,
		disabled:   os.Getenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO") != "",
		headless:   s.Headless,
		opener:     s.BatchRunOpener,
	}
}

const separator = "────────────────────────────────────────────────────────────"

// claim creates the coordination file for kind and reports whether this
// process is the first to do so.
func (a *alertLogger) claim(kind string) bool {
	path := filepath.Join(os.TempDir(), "scenario-"+kind+"-"+a.batchRunID)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return false
	}
	_, _ = f.WriteString(strconv.Itoa(os.Getpid()))
	_ = f.Close()
	return true
}

// greeting prints the reporting status banner when no API key is set.
func (a *alertLogger) greeting(apiKey string) {
	if a.disabled || !a.claim("greeting") || apiKey != "" {
		return
	}
	fmt.Fprintf(a.out, "\n%s\n🎭  Running Scenario Tests\n%s\n", separator, separator)
	fmt.Fprintln(a.out, "➡️  LangWatch API key not configured")
	fmt.Fprintln(a.out, "   Simulations will only output final results")
	fmt.Fprintln(a.out, "")
	fmt.Fprintln(a.out, "💡 To visualize conversations in real time:")
	fmt.Fprintln(a.out, "   • Set LANGWATCH_API_KEY environment variable")
	fmt.Fprintln(a.out, "   • Or pass LangWatch config to scenario.Run")
	fmt.Fprintln(a.out, "")
	fmt.Fprintf(a.out, "%s\n\n", separator)
}

// watchMessage prints the live link of the batch, once per scenario set,
// and opens it unless headless.
func (a *alertLogger) watchMessage(ctx context.Context, setID, setURL string, lw LangWatchConfig) {
	if a.disabled || !a.claim("watch-"+setID) {
		return
	}
	batchURL := setURL + "/" + a.batchRunID
	fmt.Fprintf(a.out, "\n%s\n🎭  Running Scenario Tests\n%s\n", separator, separator)
	fmt.Fprintf(a.out, "Follow it live: %s\n", batchURL)
	if !a.headless {
		opener := a.opener
		if opener == nil {
			opener = openInBrowser
		}
		if opener(ctx, BatchRunInfo{BatchURL: batchURL, BatchRunID: a.batchRunID, ScenarioSetID: setID, LangWatch: lw}) {
			fmt.Fprintln(a.out, "↻ Sent to the LangWatch tab you already have open")
		}
	}
	fmt.Fprintf(a.out, "%s\n\n", separator)
}

// openInBrowser is the default BatchRunOpener.
func openInBrowser(_ context.Context, info BatchRunInfo) bool {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", info.BatchURL)
	case "linux":
		cmd = exec.Command("xdg-open", info.BatchURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", info.BatchURL)
	default:
		return false
	}
	if cmd.Start() == nil {
		go func() { _ = cmd.Wait() }()
	}
	return false
}
