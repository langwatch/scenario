//go:build unix

package claudecode

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// --- argv -----------------------------------------------------------------

func TestArgvRequestsStreamJSONWithoutSkipPermissionsByDefault(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	mustText(t, f.adapter(nil), simpleInput)

	want := []string{"-p", "--output-format", "stream-json", "--verbose", "user: hello"}
	if got := f.argv(0); !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
}

func TestArgvSkipPermissionsOnlyWhenSet(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	mustText(t, f.adapter(func(c *Config) { c.SkipPermissions = true }), simpleInput)
	if !contains(f.argv(0), "--dangerously-skip-permissions") {
		t.Fatalf("argv = %q", f.argv(0))
	}
}

func TestArgvModelAndExtraArgsInOrder(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(systemInitLine("s1"), assistantLine("ok"))})
	a := f.adapter(func(c *Config) {
		c.Model = "claude-sonnet-4-5"
		c.SkipPermissions = true
		c.ExtraArgs = []string{"--max-turns", "3"}
	})
	mustText(t, a, simpleInput)
	mustText(t, a, turn(defaultThread, msgs("user", "hello", "assistant", "ok", "user", "again"), msgs("user", "again")...))

	want := []string{"-p", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-5",
		"--dangerously-skip-permissions", "--resume", "s1", "--max-turns", "3", "user: again"}
	if got := f.argv(1); !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
}

func TestBinaryResolvesClaudeBinOverEnvOverDefault(t *testing.T) {
	f := newFake(t)
	cfg := f.config()
	bin := cfg.ClaudeBin

	t.Setenv("CLAUDE_BIN", "/nonexistent/claude")
	a := f.adapter(nil)
	mustText(t, a, simpleInput) // ClaudeBin wins over CLAUDE_BIN

	t.Setenv("CLAUDE_BIN", bin)
	a = f.adapter(func(c *Config) { c.ClaudeBin = "" })
	mustText(t, a, simpleInput) // CLAUDE_BIN wins over "claude"
	f.wantCalls(2)

	t.Setenv("CLAUDE_BIN", "")
	if got := a.resolveBin(); got != "claude" {
		t.Fatalf("default binary = %q", got)
	}
}

// --- session continuation -------------------------------------------------

func TestCapturesSessionAndResumesItOnTheNextTurnOfTheThread(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-abc"), assistantLine("noted"))},
		fakeSpec{Stdout: lines(assistantLine("PINEAPPLE42"))},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "remember PINEAPPLE42")))
	if f.resumed(0) != "" {
		t.Fatal("first turn must not resume")
	}
	got := mustText(t, a, turn(defaultThread,
		msgs("user", "remember PINEAPPLE42", "assistant", "noted", "user", "what was the secret word?"),
		msgs("user", "what was the secret word?")...))
	if f.resumed(1) != "sess-abc" || got != "PINEAPPLE42" {
		t.Fatalf("resumed %q, text %q", f.resumed(1), got)
	}
}

func TestResumeTurnSendsOnlyTheDelta(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(systemInitLine("sess-delta"), assistantLine("ok"))})
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	mustText(t, a, turn(defaultThread,
		msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA"),
		msgs("user", "SECOND_TURN_DELTA")...))
	if p := f.prompt(1); p != "user: SECOND_TURN_DELTA" {
		t.Fatalf("prompt = %q", p)
	}
}

func TestSessionsStayDistinctPerThread(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-A"), assistantLine("hello A"))},
		fakeSpec{Stdout: lines(systemInitLine("sess-B"), assistantLine("hello B"))},
		fakeSpec{Stdout: lines(assistantLine("answer B"))},
	)
	a := f.adapter(nil)
	mustText(t, a, turn("thread-A", msgs("user", "hi from A")))
	mustText(t, a, turn("thread-B", msgs("user", "hi from B")))
	if f.resumed(1) != "" {
		t.Fatal("thread B's first turn must start fresh")
	}
	mustText(t, a, turn("thread-B", msgs("user", "hi from B", "assistant", "hello B", "user", "follow-up B"), msgs("user", "follow-up B")...))
	if f.resumed(2) != "sess-B" || contains(f.argv(2), "sess-A") {
		t.Fatalf("argv = %q", f.argv(2))
	}
}

func TestEmptyResumeDeltaFailsWithoutRunningOrEvicting(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(systemInitLine("sess-empty"), assistantLine("ok"))})
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "opener")))

	in := turn(defaultThread, msgs("user", "opener", "assistant", "ok"))
	in.NewMessages = []scenario.Message{}
	_, err := call(t, a, in)
	if !errors.Is(err, ErrNoPrompt) || !strings.Contains(err.Error(), "received no messages to send to the CLI") {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(1)

	mustText(t, a, turn(defaultThread, msgs("user", "opener", "assistant", "ok", "user", "real follow-up"), msgs("user", "real follow-up")...))
	if f.resumed(1) != "sess-empty" {
		t.Fatalf("argv = %q", f.argv(1))
	}
}

func TestNoCapturedSessionFallsBackToFullHistory(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(assistantLine("ok"))}, fakeSpec{Stdout: lines(assistantLine("done"))})
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	mustText(t, a, turn(defaultThread,
		msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA"),
		msgs("user", "SECOND_TURN_DELTA")...))
	if f.resumed(1) != "" {
		t.Fatal("must not resume without a captured session")
	}
	if p := f.prompt(1); p != "user: FIRST_TURN_TEXT\n\nassistant: ok\n\nuser: SECOND_TURN_DELTA" {
		t.Fatalf("prompt = %q", p)
	}
}

// resumeAfterFailure runs a first turn minting session, then a resume turn
// that fails per failure, then a third turn, and checks the session
// survived the failure.
func resumeAfterFailure(t *testing.T, session string, failure fakeSpec, wantErr string) {
	t.Helper()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine(session), assistantLine("ok"))},
		failure,
		fakeSpec{Stdout: lines(assistantLine("recovered"))},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))

	_, err := call(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA"), msgs("user", "SECOND_TURN_DELTA")...))
	if err == nil || !strings.Contains(err.Error(), wantErr) {
		t.Fatalf("err = %v, want %q", err, wantErr)
	}
	var lost *LostSessionError
	if errors.As(err, &lost) {
		t.Fatalf("a non-stale failure must not be a LostSessionError: %v", err)
	}
	if f.resumed(1) != session {
		t.Fatalf("argv = %q", f.argv(1))
	}
	f.wantCalls(2) // no hidden retry

	mustText(t, a, turn(defaultThread,
		msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA", "assistant", "(failed)", "user", "THIRD_TURN_DELTA"),
		msgs("user", "THIRD_TURN_DELTA")...))
	if f.resumed(2) != session || f.prompt(2) != "user: THIRD_TURN_DELTA" {
		t.Fatalf("argv = %q", f.argv(2))
	}
}

func TestNonStaleResumeFailureKeepsTheSession(t *testing.T) {
	t.Parallel()
	resumeAfterFailure(t, "sess-heal", fakeSpec{Stderr: "Rate limit exceeded", Exit: 1}, "exit code 1: Rate limit exceeded")
}

func TestSignalKilledResumeKeepsTheSession(t *testing.T) {
	t.Parallel()
	resumeAfterFailure(t, "sess-sig", fakeSpec{Signal: true}, "terminated by signal SIGKILL")
}

func TestResumeTimeoutKeepsTheSession(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-timeout"), assistantLine("ok"))},
		fakeSpec{Hang: true},
		fakeSpec{Stdout: lines(assistantLine("ok3"))},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "one")))
	a.timeout = time.Second
	_, err := call(t, a, turn(defaultThread, msgs("user", "one", "assistant", "ok", "user", "two"), msgs("user", "two")...))
	if !errors.Is(err, ErrTimeout) || !strings.Contains(err.Error(), "timed out after 1s") {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(2)
	a.timeout = DefaultTimeout
	mustText(t, a, turn(defaultThread, msgs("user", "one", "assistant", "ok", "user", "two", "user", "three"), msgs("user", "three")...))
	if f.resumed(2) != "sess-timeout" {
		t.Fatalf("argv = %q", f.argv(2))
	}
}

func TestSuccessfulResumeRunsExactlyOnce(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-once"), assistantLine("ok"))},
		fakeSpec{Stdout: lines(assistantLine("RESUMED_ANSWER"))},
		fakeSpec{Stdout: lines(assistantLine("REBUILD_SHOULD_NOT_RUN"))},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	got := mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA"), msgs("user", "SECOND_TURN_DELTA")...))
	if got != "RESUMED_ANSWER" {
		t.Fatalf("text = %q", got)
	}
	f.wantCalls(2)
	if f.resumed(1) != "sess-once" || f.prompt(1) != "user: SECOND_TURN_DELTA" {
		t.Fatalf("argv = %q", f.argv(1))
	}
}

// --- stale-session recovery -----------------------------------------------

const staleStderr = "No conversation found with session ID: sess-gone\n"

var staleEnvelope = fakeSpec{
	Stdout: lines(resultLine(true, "error_during_execution", "No conversation found with session ID: sess-gone")),
	Exit:   1,
}

func secondTurn() scenario.AgentInput {
	return turn(defaultThread, msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND_TURN_DELTA"), msgs("user", "SECOND_TURN_DELTA")...)
}

func TestReplayRecoversInTurnViaTheStderrFallback(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-gone"), assistantLine("ok"))},
		fakeSpec{Stderr: staleStderr, Exit: 1},
		fakeSpec{Stdout: lines(systemInitLine("sess-fresh"), assistantLine("recovered"))},
	)
	a := f.adapter(func(c *Config) { c.ReplayOnLostSession = true })
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	if got := mustText(t, a, secondTurn()); got != "recovered" {
		t.Fatalf("text = %q", got)
	}
	f.wantCalls(3)
	if f.resumed(1) != "sess-gone" || f.resumed(2) != "" {
		t.Fatalf("argv1 %q argv2 %q", f.argv(1), f.argv(2))
	}
	if p := f.prompt(2); !strings.Contains(p, "FIRST_TURN_TEXT") || !strings.Contains(p, "SECOND_TURN_DELTA") {
		t.Fatalf("the rebuild must replay the full history: %q", p)
	}
}

func TestLostSessionFailsByDefaultNamingTheOption(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-gone"), assistantLine("ok"))},
		fakeSpec{Stderr: staleStderr, Exit: 1},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	_, err := call(t, a, secondTurn())
	if err == nil || !strings.Contains(err.Error(), "ReplayOnLostSession: true") || !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(2)
}

func TestReplayDetectsALostSessionFromTheResultEnvelope(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-gone"), assistantLine("ok"))},
		staleEnvelope,
		fakeSpec{Stdout: lines(systemInitLine("sess-fresh"), assistantLine("recovered"))},
	)
	a := f.adapter(func(c *Config) { c.ReplayOnLostSession = true })
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	if got := mustText(t, a, secondTurn()); got != "recovered" {
		t.Fatalf("text = %q", got)
	}
	if f.resumed(1) != "sess-gone" || f.resumed(2) != "" {
		t.Fatal("expected a resume then a fresh rebuild")
	}
}

func TestTheTurnAfterARecoveryResumesTheFreshSession(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-gone"), assistantLine("ok"))},
		fakeSpec{Stderr: staleStderr, Exit: 1},
		fakeSpec{Stdout: lines(systemInitLine("sess-fresh"), assistantLine("recovered"))},
		fakeSpec{Stdout: lines(assistantLine("ok3"))},
	)
	a := f.adapter(func(c *Config) { c.ReplayOnLostSession = true })
	mustText(t, a, turn(defaultThread, msgs("user", "one")))
	mustText(t, a, turn(defaultThread, msgs("user", "one", "assistant", "ok", "user", "two"), msgs("user", "two")...))
	mustText(t, a, turn(defaultThread, msgs("user", "one", "assistant", "ok", "user", "two", "assistant", "recovered", "user", "three"), msgs("user", "three")...))
	if f.resumed(3) != "sess-fresh" {
		t.Fatalf("argv = %q", f.argv(3))
	}
}

func TestAFailedRebuildSurfacesItsOwnErrorAndTheNextTurnStartsFresh(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-gone"), assistantLine("ok"))},
		fakeSpec{Stderr: staleStderr, Exit: 1},
		fakeSpec{Stderr: "Rate limit exceeded", Exit: 1},
		fakeSpec{Stdout: lines(assistantLine("third try ok"))},
	)
	a := f.adapter(func(c *Config) { c.ReplayOnLostSession = true })
	mustText(t, a, turn(defaultThread, msgs("user", "FIRST_TURN_TEXT")))
	_, err := call(t, a, secondTurn())

	var cliErr *CLIError
	var lost *LostSessionError
	if !errors.As(err, &cliErr) || errors.As(err, &lost) {
		t.Fatalf("want a bare *CLIError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "Rate limit exceeded") || strings.Contains(err.Error(), "No conversation found") {
		t.Fatalf("err = %v", err)
	}

	mustText(t, a, secondTurn())
	if f.resumed(3) != "" || !strings.Contains(f.prompt(3), "FIRST_TURN_TEXT") {
		t.Fatalf("argv = %q", f.argv(3))
	}
}

func TestAFirstTurnNeverAttemptsRecovery(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stderr: "No conversation found with session ID: whatever", Exit: 1})
	_, err := call(t, f.adapter(nil), simpleInput)
	if err == nil || !strings.Contains(err.Error(), "exit code 1") {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(1)
}

// userStub plays the user; scripted steps carry their own content.
type userStub struct{}

func (userStub) Role() scenario.AgentRole { return scenario.AgentRoleUser }
func (userStub) Call(context.Context, scenario.AgentInput) (*scenario.AgentReturn, error) {
	return nil, errors.New("userStub.Call should never run")
}

func TestAMidRunStaleSessionDoesNotAbortTheScenario(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("s1"), assistantLine("ack"))},
		fakeSpec{Stderr: "No conversation found with session ID: s1", Exit: 1},
		fakeSpec{Stdout: lines(systemInitLine("s2"), assistantLine("recovered answer"))},
	)
	a := f.adapter(func(c *Config) { c.ReplayOnLostSession = true })
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "claude-code stale session",
		Description: "turn 2 resumes a session the CLI no longer has",
		Agents:      []scenario.AgentAdapter{a, userStub{}},
		Script: []scenario.ScriptStep{
			scenario.User("first user turn"), scenario.Agent(),
			scenario.User("second user turn"), scenario.Agent(),
			scenario.Succeed("reached the end"),
		},
	}, scenario.WithQuiet())
	if err != nil || !result.Success {
		t.Fatalf("result %+v, err %v", result, err)
	}
	f.wantCalls(3)
	if f.resumed(1) != "s1" || f.resumed(2) != "" {
		t.Fatal("expected a resume then a fresh rebuild")
	}
	var texts []string
	for _, m := range result.Messages {
		if m.Role == scenario.RoleAssistant {
			texts = append(texts, m.Text())
		}
	}
	if !slices.Contains(texts, "recovered answer") {
		t.Fatalf("assistant messages = %q", texts)
	}
}

// --- LostSessionError -----------------------------------------------------

func TestLostSessionErrorCarriesTheSessionThreadAndCause(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-vanished"), assistantLine("ok"))},
		fakeSpec{Stderr: "No conversation found with session ID: sess-vanished", Exit: 1},
	)
	a := f.adapter(nil)
	mustText(t, a, turn("thread-lost", msgs("user", "FIRST_TURN_TEXT")))
	_, err := call(t, a, turn("thread-lost", msgs("user", "FIRST_TURN_TEXT", "assistant", "ok", "user", "SECOND"), msgs("user", "SECOND")...))

	var lost *LostSessionError
	var cliErr *CLIError
	if !errors.As(err, &lost) || !errors.As(err, &cliErr) {
		t.Fatalf("want a LostSessionError wrapping a CLIError, got %T: %v", err, err)
	}
	if lost.SessionID != "sess-vanished" || lost.ThreadID != "thread-lost" || lost.Cause != cliErr || cliErr.ExitCode != 1 {
		t.Fatalf("%+v / %+v", lost, cliErr)
	}
	if !strings.Contains(lost.Error(), "ReplayOnLostSession: true") || !strings.Contains(lost.Error(), "no longer exists") {
		t.Fatalf("message = %q", lost.Error())
	}
}

func TestNonStaleResumeFailureIsABareCLIError(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-live"), assistantLine("ok"))},
		fakeSpec{Stderr: "Rate limit exceeded", Exit: 1},
	)
	a := f.adapter(nil)
	mustText(t, a, turn(defaultThread, msgs("user", "one")))
	_, err := call(t, a, turn(defaultThread, msgs("user", "one", "assistant", "ok", "user", "two"), msgs("user", "two")...))
	var cliErr *CLIError
	var lost *LostSessionError
	if !errors.As(err, &cliErr) || errors.As(err, &lost) {
		t.Fatalf("got %T: %v", err, err)
	}
}

// --- failures ---------------------------------------------------------------

func TestMissingCLIFailsWithAFriendlyError(t *testing.T) {
	t.Parallel()
	a, err := New(Config{WorkingDirectory: t.TempDir(), ClaudeBin: "claude-missing-for-test"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = call(t, a, simpleInput)
	if !errors.Is(err, ErrCLINotFound) || !strings.Contains(err.Error(), "Claude Code CLI not found") || !strings.Contains(err.Error(), "claude-missing-for-test") {
		t.Fatalf("err = %v", err)
	}
	a, _ = New(Config{WorkingDirectory: t.TempDir(), ClaudeBin: "/nonexistent/claude"})
	if _, err = call(t, a, simpleInput); !errors.Is(err, ErrCLINotFound) {
		t.Fatalf("absolute path: err = %v", err)
	}
}

func TestMissingWorkingDirectoryIsNotReportedAsAMissingCLI(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	a := f.adapter(func(c *Config) { c.WorkingDirectory = c.WorkingDirectory + "/missing" })
	_, err := call(t, a, simpleInput)
	if err == nil || errors.Is(err, ErrCLINotFound) || !strings.Contains(err.Error(), "working directory") {
		t.Fatalf("err = %v", err)
	}
}

func TestNoMessagesFailsWithoutRunning(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	_, err := call(t, f.adapter(nil), turn(defaultThread, nil))
	if !errors.Is(err, ErrNoPrompt) {
		t.Fatalf("err = %v", err)
	}
	// Messages that render to nothing are no prompt either.
	_, err = call(t, f.adapter(nil), turn(defaultThread, msgs("user", "  ", "assistant", "")))
	if !errors.Is(err, ErrNoPrompt) {
		t.Fatalf("err = %v", err)
	}
	f.wantCalls(0)
}

func TestNonZeroExitFailsWithTheCodeAndStderr(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stderr: "Invalid API key (rate limit / auth)\n", Exit: 1})
	_, err := call(t, f.adapter(nil), simpleInput)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || err.Error() != "Claude Code CLI failed with exit code 1: Invalid API key (rate limit / auth)" {
		t.Fatalf("err = %v", err)
	}
	if cliErr.ExitCode != 1 || cliErr.Signal != "" || cliErr.Stderr != "Invalid API key (rate limit / auth)" {
		t.Fatalf("%+v", cliErr)
	}
}

func TestAnErrorEnvelopeFailsEvenOnAZeroExitAndStoresNoSession(t *testing.T) {
	t.Parallel()
	f := newFake(t,
		fakeSpec{Stdout: lines(systemInitLine("sess-doomed"), resultLine(true, "error_during_execution", "Execution failed: a tool crashed"))},
		fakeSpec{Stdout: lines(assistantLine("ok"))},
	)
	a := f.adapter(nil)
	_, err := call(t, a, turn(defaultThread, msgs("user", "hi")))
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || err.Error() != "Claude Code CLI reported an error result (error_during_execution): Execution failed: a tool crashed" {
		t.Fatalf("err = %v", err)
	}
	if cliErr.ExitCode != 0 || cliErr.Subtype != "error_during_execution" || !reflect.DeepEqual(cliErr.Errors, []string{"Execution failed: a tool crashed"}) {
		t.Fatalf("%+v", cliErr)
	}
	mustText(t, a, turn(defaultThread, msgs("user", "again")))
	if f.resumed(1) != "" {
		t.Fatal("a failed run must store no session")
	}
}

func TestSignalDeathFailsWithTheSignalAndStderr(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Signal: true}, fakeSpec{Stderr: "OOM killer struck", Signal: true})
	a := f.adapter(nil)
	_, err := call(t, a, simpleInput)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || err.Error() != "Claude Code CLI was terminated by signal SIGKILL" || cliErr.ExitCode != -1 || cliErr.Signal != "SIGKILL" {
		t.Fatalf("err = %v (%+v)", err, cliErr)
	}
	if _, err = call(t, a, simpleInput); err == nil || !strings.Contains(err.Error(), "SIGKILL: OOM killer struck") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigValidation(t *testing.T) {
	t.Parallel()
	for name, cfg := range map[string]Config{
		"no working directory": {},
		"negative timeout":     {WorkingDirectory: "/tmp", Timeout: -5},
		"negative cap":         {WorkingDirectory: "/tmp", MaxToolResultChars: -1},
		"unknown output":       {WorkingDirectory: "/tmp", Output: "xml"},
	} {
		if _, err := New(cfg); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	a, err := New(Config{WorkingDirectory: "/tmp"})
	if err != nil || a.timeout != DefaultTimeout || a.limits != (Limits{8000, 30000}) {
		t.Fatalf("defaults: %v %v %+v", err, a.timeout, a.limits)
	}
	if a.Role() != scenario.AgentRoleAgent || a.Name() != "ClaudeCodeAgent" {
		t.Fatal("role/name")
	}
}

// --- logger -------------------------------------------------------------

func TestDiagnosticsGoThroughTheLogger(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stderr: "some stderr noise", Stdout: lines(assistantLine("ok"))})
	logs := &logRecorder{}
	mustText(t, f.adapter(func(c *Config) { c.Logger = logs.logger() }), simpleInput)

	if !logs.has("INFO", "Starting Claude Code", "") || !logs.has("INFO", "Claude Code stdout", `"text":"ok"`) {
		t.Fatalf("logs = %q", logs.all())
	}
	if !logs.has("WARN", "Claude Code stderr", "some stderr noise") {
		t.Fatalf("logs = %q", logs.all())
	}
}

func TestUnknownEventsWarnAndKnownContentStillReturns(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(jsonLine(map[string]any{"type": "some_new_event", "payload": map[string]any{"x": 1}}), assistantLine("KNOWN_TEXT"))})
	logs := &logRecorder{}
	if got := mustText(t, f.adapter(func(c *Config) { c.Logger = logs.logger() }), simpleInput); got != "KNOWN_TEXT" {
		t.Fatalf("text = %q", got)
	}
	if !logs.has("WARN", "unknown event type", "some_new_event") {
		t.Fatalf("logs = %q", logs.all())
	}
}

// --- env ------------------------------------------------------------------

func TestTheCLIEnvironmentIsThisProcesssWithConfigOnTop(t *testing.T) {
	t.Setenv("CC_TEST_PROVIDER_KEY", "sk-judge")
	t.Setenv("CC_TEST_BATCH_ID", "batch-1")
	t.Setenv("FORCE_COLOR", "3")
	f := newFake(t)
	mustText(t, f.adapter(func(c *Config) {
		c.Env["CC_TEST_NEW"] = "1"
		c.Env["FORCE_COLOR"] = "1"
		c.UnsetEnv = []string{"CC_TEST_BATCH_ID"}
	}), simpleInput)

	env := map[string][]string{}
	for _, kv := range f.calls()[0].Env {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = append(env[k], v)
	}
	want := map[string][]string{"CC_TEST_NEW": {"1"}, "CC_TEST_PROVIDER_KEY": {"sk-judge"}, "FORCE_COLOR": {"0"}}
	for k, v := range want {
		if !reflect.DeepEqual(env[k], v) {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	if _, ok := env["CC_TEST_BATCH_ID"]; ok {
		t.Error("CC_TEST_BATCH_ID must be removed")
	}
}

func TestTheCLIRunsInTheWorkingDirectory(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	a := f.adapter(nil)
	mustText(t, a, simpleInput)
	c := f.calls()[0]
	if !sameDir(c.Dir, a.cfg.WorkingDirectory) {
		t.Fatalf("cwd = %q, want %q", c.Dir, a.cfg.WorkingDirectory)
	}
	if !slices.Contains(c.Env, "PWD="+a.cfg.WorkingDirectory) {
		t.Fatal("PWD must name the working directory, not the harness's")
	}
}

// --- output -----------------------------------------------------------------

var toolTurnStdout = lines(
	toolUseLine("toolu_1", "Bash", map[string]any{"command": "ls"}, "Reading."),
	toolResultLine("toolu_1", []any{map[string]any{"type": "text", "text": "a.txt"}}, false),
	assistantLine("Done."),
)

func TestOutputMessagesReturnsToolCallsAndResults(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: toolTurnStdout})
	ret, err := call(t, f.adapter(func(c *Config) { c.Output = OutputMessages }), simpleInput)
	if err != nil {
		t.Fatal(err)
	}
	want := []scenario.Message{
		{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("Reading.")},
			ToolCalls: []scenario.ToolCall{{ID: "toolu_1", Name: "Bash", Arguments: `{"command":"ls"}`}}},
		{Role: scenario.RoleTool, ToolCallID: "toolu_1", ToolName: "Bash", Content: "a.txt"},
		{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("Done.")}},
	}
	if got := ret.Messages(scenario.RoleAssistant); !reflect.DeepEqual(got, want) {
		t.Fatalf("messages:\n got %+v\nwant %+v", got, want)
	}
}

func TestOutputTextRendersToolsInline(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: toolTurnStdout})
	got := mustText(t, f.adapter(nil), simpleInput)
	if want := "Reading.\nTool Called: Bash({\"command\":\"ls\"})\n\nTool Result: a.txt\n\nDone."; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}
}

func TestToolResultCapIsConfigurable(t *testing.T) {
	t.Parallel()
	f := newFake(t, fakeSpec{Stdout: lines(
		toolUseLine("toolu_1", "Bash", map[string]any{"command": "cat big"}),
		toolResultLine("toolu_1", strings.Repeat("y", 500), false),
	)})
	ret, err := call(t, f.adapter(func(c *Config) { c.Output = OutputMessages; c.MaxToolResultChars = 100 }), simpleInput)
	if err != nil {
		t.Fatal(err)
	}
	value := ret.Messages(scenario.RoleAssistant)[1].Content
	if value != strings.Repeat("y", 100)+"\n… [400 more characters]" {
		t.Fatalf("value = %q", value)
	}
}

func TestStderrIsCapturedOnSuccessToo(t *testing.T) {
	t.Parallel()
	// A multibyte character split across reads reaches the log intact.
	f := newFake(t, fakeSpec{Stdout: lines(assistantLine("café")), Stderr: "café"})
	logs := &logRecorder{}
	if got := mustText(t, f.adapter(func(c *Config) { c.Logger = logs.logger() }), simpleInput); got != "café" {
		t.Fatalf("text = %q", got)
	}
	if !logs.has("WARN", "Claude Code stderr", "café") {
		t.Fatalf("logs = %q", logs.all())
	}
}
