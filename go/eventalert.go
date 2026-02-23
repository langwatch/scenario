package scenario

import (
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"sync"
)

var (
	greetingOnce sync.Once
	watchOnce    sync.Once
)

// showGreeting prints the initial banner when scenario tests start.
// It is only shown once per process.
func showGreeting(endpoint, apiKey string) {
	greetingOnce.Do(func() {
		if apiKey != "" && endpoint != "" {
			fmt.Println()
			fmt.Printf("  🧪 Running Scenario Tests — Follow results at %s\n", endpoint)
			fmt.Println()
		} else {
			fmt.Println()
			fmt.Println("  🧪 Running Scenario Tests")
			fmt.Println()
			fmt.Println("  💡 Set LANGWATCH_API_KEY to follow results live on LangWatch")
			fmt.Println()
		}
	})
}

// showWatchMessage prints the live follow URL and opens it in the browser.
// It is only shown once per batch run.
func showWatchMessage(setURL, batchRunID string) {
	watchOnce.Do(func() {
		if setURL == "" {
			return
		}

		liveURL := setURL
		if batchRunID != "" {
			liveURL = fmt.Sprintf("%s?batchRunId=%s", setURL, url.QueryEscape(batchRunID))
		}

		fmt.Printf("  👉 Follow it live: %s\n", liveURL)
		fmt.Println()

		openBrowser(liveURL)
	})
}

// openBrowser opens the given URL in the default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return
	}
	_ = cmd.Start()
}
