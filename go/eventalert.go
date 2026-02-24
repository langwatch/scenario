package scenario

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// createCoordinationFile creates a coordination file in the system's temp directory
// to prevent duplicate messages across processes in the same batch run.
// Returns true if this process should show the message (first to create the file).
func createCoordinationFile(fileType string) bool {
	batchID := getCachedBatchRunID()
	if batchID == "" {
		return true
	}
	filePath := filepath.Join(os.TempDir(), fmt.Sprintf("scenario-%s-%s", fileType, batchID))
	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		// File already exists or filesystem is read-only
		return false
	}
	f.Close()
	return true
}

func isGreetingDisabled() bool {
	return os.Getenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO") != ""
}

// showGreeting prints the initial banner when scenario tests start.
// Only shows once per batch run across processes. Only shows the "set API key"
// message when no API key is configured.
func showGreeting(apiKey string) {
	if isGreetingDisabled() {
		return
	}

	if !createCoordinationFile("greeting") {
		return
	}

	if apiKey == "" {
		separator := "────────────────────────────────────────────────────────────"
		fmt.Println()
		fmt.Println(separator)
		fmt.Println("🎭  Running Scenario Tests")
		fmt.Println(separator)
		fmt.Println("➡️  LangWatch API key not configured")
		fmt.Println("   Simulations will only output final results")
		fmt.Println()
		fmt.Println("💡 To visualize conversations in real time:")
		fmt.Println("   • Set LANGWATCH_API_KEY environment variable")
		fmt.Println()
		fmt.Println(separator)
		fmt.Println()
	}
}

// showWatchMessage prints the live follow URL and opens it in the browser.
// Only shows once per scenarioSetId per batch run across processes.
func showWatchMessage(setURL, scenarioSetID string) {
	if isGreetingDisabled() {
		return
	}

	if !createCoordinationFile("watch-" + scenarioSetID) {
		return
	}

	if setURL == "" {
		return
	}

	batchRunID := getCachedBatchRunID()
	batchURL := fmt.Sprintf("%s/%s", setURL, batchRunID)

	separator := "────────────────────────────────────────────────────────────"
	fmt.Println()
	fmt.Println(separator)
	fmt.Println("🎭  Running Scenario Tests")
	fmt.Println(separator)
	fmt.Printf("Follow it live: %s\n", batchURL)
	fmt.Println(separator)
	fmt.Println()

	if os.Getenv("SCENARIO_HEADLESS") == "" {
		openBrowser(batchURL)
	}
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
