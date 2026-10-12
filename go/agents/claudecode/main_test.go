//go:build unix

package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// The tests run the adapter against a fake claude: this test binary itself,
// re-executed with fakeDirEnv set. The fake reads what to do from the spec
// files of that directory, one per invocation in order, and records how it
// was invoked (argv, cwd, environment, pids) next to them.

const fakeDirEnv = "CLAUDECODE_TEST_FAKE_CLI_DIR"

func TestMain(m *testing.M) {
	if dir := os.Getenv(fakeDirEnv); dir != "" {
		os.Exit(runFakeCLI(dir))
	}
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Unsetenv("LANGWATCH_PROJECT_ID")
	os.Unsetenv("SCENARIO_SEND_GRANULAR_EVENTS")
	os.Unsetenv("CLAUDE_BIN")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	os.Exit(m.Run())
}

// fakeSpec is what one fake CLI invocation does, in order: start a
// grandchild, write stdout then stderr, then hang, die on SIGKILL or exit.
type fakeSpec struct {
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
	Exit   int    `json:"exit,omitempty"`
	// Signal makes the CLI die on SIGKILL.
	Signal bool `json:"signal,omitempty"`
	// Hang makes the CLI run until it is killed.
	Hang bool `json:"hang,omitempty"`
	// IgnoreTerm makes the CLI (and its grandchild) ignore SIGTERM.
	IgnoreTerm bool `json:"ignoreTerm,omitempty"`
	// Grandchild starts a long sleep in the CLI's process group, like a
	// command of its Bash tool. With GrandchildHoldsStdout it inherits the
	// CLI's stdout and keeps it open after the CLI exits.
	Grandchild            bool `json:"grandchild,omitempty"`
	GrandchildHoldsStdout bool `json:"grandchildHoldsStdout,omitempty"`
}

// fakeCall is how the fake CLI was invoked.
type fakeCall struct {
	Args          []string `json:"args"`
	Dir           string   `json:"dir"`
	Env           []string `json:"env"`
	PID           int      `json:"pid"`
	PGID          int      `json:"pgid"`
	GrandchildPID int      `json:"grandchildPid"`
}

func runFakeCLI(dir string) int {
	entries, _ := os.ReadDir(dir)
	n := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "call-") {
			n++
		}
	}
	var spec fakeSpec
	if data, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("spec-%d.json", n))); err == nil {
		if err := json.Unmarshal(data, &spec); err != nil {
			fmt.Fprintln(os.Stderr, "fake claude: bad spec:", err)
			return 99
		}
	}
	if spec.IgnoreTerm {
		signal.Ignore(syscall.SIGTERM)
	}
	cwd, _ := os.Getwd()
	call := fakeCall{Args: os.Args[1:], Dir: cwd, Env: os.Environ(), PID: os.Getpid(), PGID: syscall.Getpgrp()}
	if spec.Grandchild {
		gc := exec.Command("sleep", "60")
		if spec.GrandchildHoldsStdout {
			gc.Stdout = os.Stdout
		}
		if err := gc.Start(); err == nil {
			call.GrandchildPID = gc.Process.Pid
		}
	}
	data, _ := json.Marshal(call)
	tmp := filepath.Join(dir, fmt.Sprintf(".call-%d.json", n))
	_ = os.WriteFile(tmp, data, 0o644)
	_ = os.Rename(tmp, filepath.Join(dir, fmt.Sprintf("call-%d.json", n)))

	os.Stdout.WriteString(spec.Stdout)
	os.Stderr.WriteString(spec.Stderr)
	switch {
	case spec.Hang:
		time.Sleep(time.Hour)
	case spec.Signal:
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		time.Sleep(time.Hour)
	}
	return spec.Exit
}

// fake is one test's fake CLI.
type fake struct {
	t   *testing.T
	dir string
}

// newFake prepares a fake CLI whose nth invocation follows specs[n]; an
// invocation past the specs prints nothing and exits 0.
func newFake(t *testing.T, specs ...fakeSpec) *fake {
	t.Helper()
	f := &fake{t: t, dir: t.TempDir()}
	for i, s := range specs {
		data, _ := json.Marshal(s)
		if err := os.WriteFile(filepath.Join(f.dir, fmt.Sprintf("spec-%d.json", i)), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

// config is a Config running the fake in a fresh working directory.
func (f *fake) config() Config {
	bin, err := os.Executable()
	if err != nil {
		f.t.Fatal(err)
	}
	return Config{
		WorkingDirectory: f.t.TempDir(),
		ClaudeBin:        bin,
		Env:              map[string]string{fakeDirEnv: f.dir},
	}
}

// adapter returns an adapter on the fake, cfg adjusted by edit.
func (f *fake) adapter(edit func(*Config)) *ClaudeCodeAgentAdapter {
	f.t.Helper()
	cfg := f.config()
	if edit != nil {
		edit(&cfg)
	}
	a, err := New(cfg)
	if err != nil {
		f.t.Fatal(err)
	}
	return a
}

// calls returns every recorded invocation, in order.
func (f *fake) calls() []fakeCall {
	f.t.Helper()
	var out []fakeCall
	for i := 0; ; i++ {
		data, err := os.ReadFile(filepath.Join(f.dir, fmt.Sprintf("call-%d.json", i)))
		if err != nil {
			return out
		}
		var c fakeCall
		if err := json.Unmarshal(data, &c); err != nil {
			f.t.Fatal(err)
		}
		out = append(out, c)
	}
}

// argv is the argv of the ith invocation.
func (f *fake) argv(i int) []string {
	f.t.Helper()
	calls := f.calls()
	if i >= len(calls) {
		f.t.Fatalf("invocation %d never happened (%d calls)", i, len(calls))
	}
	return calls[i].Args
}

// prompt is the prompt (last argument) of the ith invocation.
func (f *fake) prompt(i int) string {
	argv := f.argv(i)
	return argv[len(argv)-1]
}

// resumed returns the --resume argument of the ith invocation, or "".
func (f *fake) resumed(i int) string {
	argv := f.argv(i)
	for j, a := range argv {
		if a == "--resume" && j+1 < len(argv) {
			return argv[j+1]
		}
	}
	return ""
}

func (f *fake) wantCalls(n int) {
	f.t.Helper()
	if got := len(f.calls()); got != n {
		f.t.Fatalf("CLI ran %d times, want %d", got, n)
	}
}

// --- stream-json lines --------------------------------------------------

func jsonLine(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func lines(ls ...string) string { return strings.Join(ls, "\n") + "\n" }

func systemInitLine(sessionID string) string {
	return jsonLine(map[string]any{"type": "system", "subtype": "init", "session_id": sessionID})
}

func assistantLine(text string) string {
	return jsonLine(map[string]any{
		"type":    "assistant",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}},
	})
}

func resultLine(isError bool, subtype string, errs ...string) string {
	return jsonLine(map[string]any{"type": "result", "subtype": subtype, "is_error": isError, "errors": errs})
}

func toolUseLine(id, name string, input any, text ...string) string {
	var content []any
	for _, t := range text {
		content = append(content, map[string]any{"type": "text", "text": t})
	}
	content = append(content, map[string]any{"type": "tool_use", "id": id, "name": name, "input": input})
	return jsonLine(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": content}})
}

func toolResultLine(toolUseID string, content any, isError bool) string {
	block := map[string]any{"type": "tool_result", "tool_use_id": toolUseID, "content": content}
	if isError {
		block["is_error"] = true
	}
	return jsonLine(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{block}}})
}

// --- agent input --------------------------------------------------------

const defaultThread = "claude-code-thread"

// turn is the input of a turn on thread with the full history; newMessages
// default to the whole history, the shape of a first turn.
func turn(thread string, history []scenario.Message, newMessages ...scenario.Message) scenario.AgentInput {
	if newMessages == nil {
		newMessages = history
	}
	return scenario.AgentInput{ThreadID: thread, Messages: history, NewMessages: newMessages, RequestedRole: scenario.AgentRoleAgent}
}

func msgs(roleContent ...string) []scenario.Message {
	var out []scenario.Message
	for i := 0; i+1 < len(roleContent); i += 2 {
		out = append(out, scenario.Message{Role: scenario.Role(roleContent[i]), Content: roleContent[i+1]})
	}
	return out
}

var simpleInput = turn(defaultThread, msgs("user", "hello"))

// call runs one turn with a background context.
func call(t *testing.T, a *ClaudeCodeAgentAdapter, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	t.Helper()
	return a.Call(context.Background(), in)
}

// mustText runs one turn that must succeed and returns its text.
func mustText(t *testing.T, a *ClaudeCodeAgentAdapter, in scenario.AgentInput) string {
	t.Helper()
	ret, err := call(t, a, in)
	if err != nil {
		t.Fatal(err)
	}
	return textOf(ret)
}

func textOf(ret *scenario.AgentReturn) string {
	ms := ret.Messages(scenario.RoleAssistant)
	if len(ms) != 1 {
		return fmt.Sprintf("<%d messages>", len(ms))
	}
	return ms[0].Text()
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// alive reports whether pid still runs (a zombie counts as gone).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", fmt.Sprint(pid)).Output()
	return err == nil && !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

// eventually polls cond for up to d.
func eventually(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cond()
}
