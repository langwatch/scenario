package claudecode

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// TestRealCLISessionContinuation is a dev-only smoke check against a real
// claude binary (and its credentials); set RUN_CLAUDE_CODE_E2E=1 to run it.
func TestRealCLISessionContinuation(t *testing.T) {
	if os.Getenv("RUN_CLAUDE_CODE_E2E") == "" {
		t.Skip("RUN_CLAUDE_CODE_E2E not set")
	}
	a, err := New(Config{WorkingDirectory: t.TempDir(), Timeout: 3 * time.Minute, ClaudeBin: os.Getenv("CLAUDE_BIN")})
	if err != nil {
		t.Fatal(err)
	}
	first := []scenario.Message{scenario.UserMsg("Remember the secret word PINEAPPLE42. Reply only with: noted")}
	ret, err := a.Call(context.Background(), scenario.AgentInput{ThreadID: "e2e", Messages: first, NewMessages: first})
	if err != nil {
		t.Fatal(err)
	}
	reply := ret.Messages(scenario.RoleAssistant)[0]
	if _, ok := a.session("e2e"); !ok {
		t.Fatal("the CLI reported no session id")
	}
	follow := scenario.UserMsg("What was the secret word? Reply with the word only.")
	ret, err = a.Call(context.Background(), scenario.AgentInput{
		ThreadID: "e2e", Messages: append(first, reply, follow), NewMessages: []scenario.Message{follow},
	})
	if err != nil {
		t.Fatal(err)
	}
	if text := ret.Messages(scenario.RoleAssistant)[0].Text(); !strings.Contains(text, "PINEAPPLE42") {
		t.Fatalf("the resumed session forgot the word: %q", text)
	}
}
