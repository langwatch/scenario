//go:build unix

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

func TestTheCLILeadsItsOwnProcessGroup(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	mustText(t, f.adapter(nil), simpleInput)
	if c := f.calls()[0]; c.PGID != c.PID {
		t.Fatalf("pgid %d, pid %d: the CLI must lead its own group", c.PGID, c.PID)
	}
}

func TestTheWatchdogIsADetachedShellToldBothPIDs(t *testing.T) {
	t.Parallel()
	cmd := watchdogCommand("/bin/sh", 111, 4102)
	want := []string{"/bin/sh", "-c", watchdogScript, "claude-code-watchdog", "111", "4102"}
	if cmd.Path != "/bin/sh" || !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("watchdog = %q %q", cmd.Path, cmd.Args)
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid || cmd.Stdin != nil || cmd.Stdout != nil || cmd.Stderr != nil {
		t.Fatal("the watchdog must run in its own session with no stdio")
	}
	for _, s := range []string{`kill -0 "$harness"`, `kill -TERM "-$child"`, `kill -KILL "-$child"`} {
		if !strings.Contains(watchdogScript, s) {
			t.Errorf("script lacks %s", s)
		}
	}
}

// startHanging runs a turn on a fake that hangs, returning once the CLI
// recorded itself, with the turn's result channel.
func startHanging(t *testing.T, ctx context.Context, f *fake, a *ClaudeCodeAgentAdapter) (fakeCall, <-chan error) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := a.Call(ctx, simpleInput)
		done <- err
	}()
	if !eventually(20*time.Second, func() bool { return len(f.calls()) == 1 }) {
		t.Fatal("the CLI never started")
	}
	return f.calls()[0], done
}

func TestAWatchdogGuardsARunningCLI(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Hang: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, done := startHanging(t, ctx, f, f.adapter(nil))

	pattern := fmt.Sprintf("claude-code-watchdog %d %d", os.Getpid(), c.PID)
	found := eventually(10*time.Second, func() bool {
		return exec.Command("pgrep", "-f", pattern).Run() == nil
	})
	cancel()
	<-done
	if !found {
		t.Fatalf("no process matches %q", pattern)
	}
}

func TestAWatchdogThatCannotStartDoesNotFailTheTurn(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(assistantLine("hi"))})
	a := f.adapter(nil)
	a.watchdogShell = "/nonexistent/sh"
	if got := mustText(t, a, simpleInput); got != "hi" {
		t.Fatalf("text = %q", got)
	}
}

func TestATimeoutTerminatesTheWholeGroup(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Hang: true, Grandchild: true})
	a := f.adapter(nil)
	a.timeout = time.Second
	// A CLI that honours SIGTERM must not wait for the SIGKILL.
	a.killGrace = time.Minute
	started := time.Now()
	_, err := call(t, a, simpleInput)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("took %s: SIGTERM did not stop the CLI", elapsed)
	}
	assertGroupGone(t, f.calls()[0])
}

func TestATimeoutKillsACLIThatIgnoresSIGTERM(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Hang: true, IgnoreTerm: true, Grandchild: true})
	a := f.adapter(nil)
	a.timeout = time.Second
	a.killGrace = 300 * time.Millisecond
	if _, err := call(t, a, simpleInput); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v", err)
	}
	assertGroupGone(t, f.calls()[0])
}

func TestCancellationTerminatesTheWholeGroup(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Hang: true, Grandchild: true})
	ctx, cancel := context.WithCancel(context.Background())
	c, done := startHanging(t, ctx, f, f.adapter(nil))
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) || errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v", err)
	}
	assertGroupGone(t, c)
}

func TestAnAlreadyCancelledContextRunsNothing(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.adapter(nil).Call(ctx, simpleInput); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(0)
}

func TestADescendantHoldingStdoutDoesNotHangAFinishedTurn(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(assistantLine("hi")), Grandchild: true, GrandchildHoldsStdout: true})
	a := f.adapter(nil)
	a.killGrace = 300 * time.Millisecond
	got := mustText(t, a, simpleInput)
	if gc := f.calls()[0].GrandchildPID; gc != 0 {
		_ = syscall.Kill(gc, syscall.SIGKILL)
	}
	if got != "hi" {
		t.Fatalf("text = %q", got)
	}
}

// assertGroupGone checks the CLI and its grandchild are gone.
func assertGroupGone(t *testing.T, c fakeCall) {
	t.Helper()
	if c.GrandchildPID == 0 {
		t.Fatal("the fake recorded no grandchild")
	}
	if alive(c.PID) {
		t.Errorf("the CLI %d still runs", c.PID)
	}
	if !eventually(5*time.Second, func() bool { return !alive(c.GrandchildPID) }) {
		_ = syscall.Kill(c.GrandchildPID, syscall.SIGKILL)
		t.Errorf("the CLI's grandchild %d still runs", c.GrandchildPID)
	}
}

// TestTheWatchdogScriptKillsTheGroupWhenTheHarnessDies runs the real script
// under every POSIX shell on the machine, dash included, against real
// processes.
func TestTheWatchdogScriptKillsTheGroupWhenTheHarnessDies(t *testing.T) {
	t.Parallel()
	for _, shell := range []string{"/bin/sh", "/bin/dash"} {
		if _, err := os.Stat(shell); err != nil {
			continue
		}
		t.Run(shell, func(t *testing.T) {
			t.Parallel()
			harness := exec.Command("sleep", "60")
			if err := harness.Start(); err != nil {
				t.Fatal(err)
			}
			harnessDone := reap(harness)
			// A group leader with a descendant, like the CLI and its Bash tool.
			cli := exec.Command("/bin/sh", "-c", "sleep 60 & wait")
			cli.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := cli.Start(); err != nil {
				t.Fatal(err)
			}
			cliDone := reap(cli)
			group := cli.Process.Pid
			t.Cleanup(func() { _ = syscall.Kill(-group, syscall.SIGKILL); _ = harness.Process.Kill() })

			watchdog := watchdogCommand(shell, harness.Process.Pid, group)
			if err := watchdog.Start(); err != nil {
				t.Fatal(err)
			}
			reap(watchdog)

			// Let the watchdog enter its poll loop, so the kill comes from the loop.
			time.Sleep(1500 * time.Millisecond)
			_ = harness.Process.Kill()
			<-harnessDone

			select {
			case <-cliDone:
			case <-time.After(15 * time.Second):
				t.Fatal("the watchdog did not kill the CLI")
			}
			if !eventually(10*time.Second, func() bool { return syscall.Kill(-group, 0) != nil }) {
				t.Fatal("the CLI's process group survived")
			}
		})
	}
}

// reap waits for cmd in the background, closing the channel when it exited.
func reap(cmd *exec.Cmd) <-chan struct{} {
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	return done
}

// --- granular streaming -----------------------------------------------------

// streamOf runs a one-turn scenario with granular events and returns the
// TEXT_MESSAGE_CONTENT deltas, tool call names and the agent's messages.
func streamOf(t *testing.T, a *ClaudeCodeAgentAdapter) (deltas, tools []string, agentMessages []scenario.Message) {
	t.Helper()
	var mu sync.Mutex
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "claude-code streaming",
		Description: "the turn streams as the CLI writes it",
		Agents:      []scenario.AgentAdapter{a, userStub{}},
		Script:      []scenario.ScriptStep{scenario.User("hello"), scenario.Agent(), scenario.Succeed()},
	}, scenario.WithQuiet(), scenario.WithGranularEventsForRun(true), scenario.WithEventListener(func(e scenario.Event) {
		var body struct {
			Delta        string `json:"delta"`
			ToolCallName string `json:"toolCallName"`
		}
		_ = json.Unmarshal(e.Payload, &body)
		mu.Lock()
		defer mu.Unlock()
		switch e.Type {
		case scenario.EventTextMessageContent:
			deltas = append(deltas, body.Delta)
		case scenario.EventToolCallStart:
			tools = append(tools, body.ToolCallName)
		}
	}))
	if err != nil || !result.Success {
		t.Fatalf("result %+v, err %v", result, err)
	}
	for _, m := range result.Messages {
		if m.Role != scenario.RoleUser {
			agentMessages = append(agentMessages, m)
		}
	}
	return deltas, tools, agentMessages
}

func TestTextTurnsStreamDeltasThatAddUpToTheText(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: toolTurnStdout})
	deltas, _, agent := streamOf(t, f.adapter(nil))
	if len(deltas) != 3 || strings.Join(deltas, "") != agent[0].Content {
		t.Fatalf("deltas %q do not add up to %q", deltas, agent[0].Content)
	}
}

func TestMessageTurnsStreamTheFirstAssistantMessage(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: toolTurnStdout})
	deltas, tools, agent := streamOf(t, f.adapter(func(c *Config) { c.Output = OutputMessages }))
	if !reflect.DeepEqual(deltas, []string{"Reading."}) || !reflect.DeepEqual(tools, []string{"Bash"}) || len(agent) != 3 {
		t.Fatalf("deltas %q, tools %q, messages %d", deltas, tools, len(agent))
	}
}
