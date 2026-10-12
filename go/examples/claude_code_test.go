// Example: Claude Code as the Agent Under Test
//
// Runs the Claude Code CLI in a scratch working directory as the agent under
// test, then checks both the judge verdict and the shell commands the CLI
// ran. Turns return messages with tool calls (OutputMessages) so the judge
// and BashCommands can see them.
//
// Needs the claude CLI on PATH (or CLAUDE_BIN) with its own credentials, and
// OPENAI_API_KEY for the user simulator and the judge.
//
// Mirrors: docs/docs/pages/agent-integration/claude-code.mdx
package examples

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/agents/claudecode"
)

func TestClaudeCodeWritesAFile(t *testing.T) {
	skipWithoutOpenAI(t)
	bin := os.Getenv("CLAUDE_BIN")
	if bin == "" {
		bin = "claude"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skip("claude CLI not found")
	}

	dir := t.TempDir()
	agent, err := claudecode.New(claudecode.Config{
		WorkingDirectory: dir,
		Output:           claudecode.OutputMessages,
		SkipPermissions:  true, // only in a sandbox such as this temp dir
		Timeout:          2 * time.Minute,
		// The judge's key stays with the judge.
		UnsetEnv: []string{"OPENAI_API_KEY"},
	})
	if err != nil {
		t.Fatal(err)
	}

	model := scenario.ModelConfig{LLM: newLLM(), Model: "gpt-4.1-mini"}
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "claude code writes a file",
		Description: "The user asks for a hello.txt file containing the word hello.",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria:    []string{"The agent created hello.txt"},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Create a file named hello.txt that contains the word hello."),
			scenario.Agent(),
			scenario.StepFunc(func(context.Context, *scenario.Executor) error {
				data, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
				return scenario.Assert(err == nil && len(data) > 0, "hello.txt exists and is not empty")
			}),
			scenario.Judge(),
		},
	})
	var cliErr *claudecode.CLIError
	if errors.As(err, &cliErr) {
		t.Fatalf("claude exited %d: %s", cliErr.ExitCode, cliErr.Stderr)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}
	t.Logf("shell commands: %q", claudecode.BashCommands(result.Messages))
}
