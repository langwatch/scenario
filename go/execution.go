package scenario

import (
	"context"
	"fmt"
	"time"

	langwatch "github.com/langwatch/langwatch/sdk-go"
	"github.com/langwatch/scenario/go/internal/libraries/ptr"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type checkpointResult struct {
	metCriteria   []string
	unmetCriteria []string
}

type ScenarioExecution struct {
	cfg    ScenarioConfig
	state  *ScenarioExecutionState
	script []ScriptStep

	eventBus       EventBus
	scenarioRunID  string
	batchRunID     string

	// Turn management
	pendingRolesOnTurn  []AgentRole
	pendingAgentsOnTurn map[int]bool

	// Message broadcasting: per-agent message queues
	pendingMessages map[int][]Message

	// Timing
	agentTimes     map[int]time.Duration
	totalStartTime time.Time

	// Checkpoint logic
	checkpointResults []checkpointResult

	// OTel tracing
	tracer          *langwatch.LangWatchTracer
	spanCollector   *SpanCollector
	currentTurnSpan *langwatch.Span

	// Result
	result *ScenarioResult
}

func NewScenarioExecution(cfg ScenarioConfig, script []ScriptStep, eventBus EventBus, batchRunID string) *ScenarioExecution {
	return &ScenarioExecution{
		cfg:             cfg,
		state:           NewScenarioExecutionState(cfg),
		script:          script,
		eventBus:        eventBus,
		batchRunID:      batchRunID,
		pendingMessages: make(map[int][]Message),
		agentTimes:      make(map[int]time.Duration),
	}
}

// State returns the current state of the Scenario's execution.
func (e *ScenarioExecution) State() *ScenarioExecutionState {
	return e.state
}

// Run executes the scenario from start to finish.
func (e *ScenarioExecution) Run(ctx context.Context) *ScenarioResult {
	e.reset(ctx)

	e.emitRunStarted()

	for _, step := range e.script {
		if ctx.Err() != nil {
			e.emitEvent(ErrorEvent{timestamp: time.Now(), Error: ctx.Err(), Fatal: true})
			break
		}

		result, err := step(ctx, e, e.state)
		if err != nil {
			e.emitEvent(ErrorEvent{timestamp: time.Now(), Error: err, Fatal: true})
			errStr := err.Error()
			e.result = &ScenarioResult{
				RunID:         e.scenarioRunID,
				Success:       false,
				Messages:      e.state.messages,
				Reasoning:     ptr.Ptr(fmt.Sprintf("Scenario failed with error: %s", errStr)),
				MetCriteria:   []string{},
				UnmetCriteria: []string{},
				TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
				Error:         &errStr,
			}
			e.endTurnSpan()
			e.emitRunFinished()
			return e.result
		}

		e.emitMessageSnapshot()

		if result != nil {
			e.result = result
			e.finalizeResult()
			// Merge any accumulated checkpoint criteria
			cp := e.compiledCheckpoints()
			e.result.MetCriteria = append(cp.metCriteria, e.result.MetCriteria...)

			e.endTurnSpan()
			e.emitRunFinished()
			return e.result
		}
	}

	// Check if all checkpoints passed
	if len(e.checkpointResults) > 0 {
		cp := e.compiledCheckpoints()
		e.result = &ScenarioResult{
			RunID:         e.scenarioRunID,
			Success:       len(cp.unmetCriteria) == 0,
			Messages:      e.state.messages,
			Reasoning:     ptr.Ptr("All inline criteria checkpoints passed"),
			MetCriteria:   cp.metCriteria,
			UnmetCriteria: cp.unmetCriteria,
			TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
			AgentTime:     ptr.Ptr(e.totalAgentTime()),
		}
		e.endTurnSpan()
		e.emitRunFinished()
		return e.result
	}

	// End final turn span
	e.endTurnSpan()

	// If no result, treat as failure
	e.result = &ScenarioResult{
		RunID:         e.scenarioRunID,
		Success:       false,
		Messages:      e.state.messages,
		Reasoning:     ptr.Ptr("Reached end of script without conclusion"),
		MetCriteria:   []string{},
		UnmetCriteria: []string{},
		TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
		Error:         ptr.Ptr("no result was created"),
	}
	e.emitRunFinished()
	return e.result
}

func (e *ScenarioExecution) Messages() []Message {
	return e.state.Messages()
}

func (e *ScenarioExecution) ThreadID() string {
	return e.state.ThreadID()
}

// Message adds a message to the conversation, routing by role.
func (e *ScenarioExecution) Message(ctx context.Context, message Message) error {
	switch message.Role {
	case MessageRoleUser:
		return e.UserMessage(ctx, message)
	case MessageRoleAssistant:
		return e.AgentMessage(ctx, message)
	default:
		e.state.AddMessage(message)
		e.broadcastMessage(-1, message)
		return nil
	}
}

// UserString adds a user string message to the conversation.
func (e *ScenarioExecution) UserString(ctx context.Context, content string) error {
	msg := UserMsg(content)
	e.state.AddMessage(msg)
	e.broadcastMessage(-1, msg)
	return nil
}

// UserMessage adds a user message to the conversation.
func (e *ScenarioExecution) UserMessage(ctx context.Context, message Message) error {
	e.state.AddMessage(message)
	e.broadcastMessage(-1, message)
	return nil
}

// AgentString adds an assistant string message to the conversation.
func (e *ScenarioExecution) AgentString(ctx context.Context, content string) error {
	msg := AssistantMsg(content)
	e.state.AddMessage(msg)
	e.broadcastMessage(-1, msg)
	return nil
}

// AgentMessage adds an assistant message to the conversation.
func (e *ScenarioExecution) AgentMessage(ctx context.Context, message Message) error {
	e.state.AddMessage(message)
	e.broadcastMessage(-1, message)
	return nil
}

// JudgeString is not used directly — use Judge() instead.
func (e *ScenarioExecution) JudgeString(ctx context.Context, content string) (*ScenarioResult, error) {
	msg := UserMsg(content)
	e.state.AddMessage(msg)
	e.broadcastMessage(-1, msg)
	return nil, nil
}

// JudgeMessage is not used directly — use Judge() instead.
func (e *ScenarioExecution) JudgeMessage(ctx context.Context, message Message) (*ScenarioResult, error) {
	e.state.AddMessage(message)
	e.broadcastMessage(-1, message)
	return nil, nil
}

// User calls the user simulator agent or returns an error if none is configured.
func (e *ScenarioExecution) User(ctx context.Context) error {
	result, err := e.scriptCallAgent(ctx, AgentRoleUser, "", nil)
	if err != nil {
		return err
	}
	if result != nil {
		e.result = result
	}
	return nil
}

// Agent calls the agent under test or returns an error if none is configured.
func (e *ScenarioExecution) Agent(ctx context.Context) error {
	result, err := e.scriptCallAgent(ctx, AgentRoleAgent, "", nil)
	if err != nil {
		return err
	}
	if result != nil {
		e.result = result
	}
	return nil
}

// Judge calls the judge agent, optionally with inline criteria for checkpoint evaluation.
func (e *ScenarioExecution) Judge(ctx context.Context, opts ...JudgeOption) (*ScenarioResult, error) {
	options := &JudgeOptions{}
	for _, opt := range opts {
		opt(options)
	}

	var judgmentReq *JudgmentRequest
	if len(options.Criteria) > 0 {
		judgmentReq = &JudgmentRequest{
			Criteria:      options.Criteria,
			ForceDecision: true,
		}
	} else {
		judgmentReq = &JudgmentRequest{}
	}

	return e.scriptCallAgent(ctx, AgentRoleJudge, "", judgmentReq)
}

// Proceed runs the conversation automatically for specified turns.
func (e *ScenarioExecution) Proceed(ctx context.Context, opts ...ProceedOption) (*ScenarioResult, error) {
	options := &ProceedOptions{}
	for _, opt := range opts {
		opt(options)
	}

	initialTurn := e.state.currentTurn

	for {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		goToNextTurn := options.Turns == 0 ||
			e.state.currentTurn+1 < initialTurn+options.Turns

		err := e.step(ctx, goToNextTurn, options.OnTurn)
		if err != nil {
			return nil, err
		}

		if e.result != nil {
			return e.result, nil
		}

		if options.OnStep != nil {
			if err := options.OnStep(e.state); err != nil {
				return nil, err
			}
		}

		if !goToNextTurn {
			return nil, nil
		}
	}
}

func (e *ScenarioExecution) Succeed(ctx context.Context, reasoning string) (*ScenarioResult, error) {
	if reasoning == "" {
		reasoning = "Scenario marked as successful with Scenario.succeed()"
	}
	result := &ScenarioResult{
		RunID:         e.scenarioRunID,
		Success:       true,
		Messages:      e.state.messages,
		Reasoning:     &reasoning,
		MetCriteria:   []string{},
		UnmetCriteria: []string{},
		TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
		AgentTime:     ptr.Ptr(e.totalAgentTime()),
	}
	e.result = result
	return result, nil
}

func (e *ScenarioExecution) Fail(ctx context.Context, reasoning string) (*ScenarioResult, error) {
	if reasoning == "" {
		reasoning = "Scenario marked as failed with Scenario.fail()"
	}
	result := &ScenarioResult{
		RunID:         e.scenarioRunID,
		Success:       false,
		Messages:      e.state.messages,
		Reasoning:     &reasoning,
		MetCriteria:   []string{},
		UnmetCriteria: []string{},
		TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
		AgentTime:     ptr.Ptr(e.totalAgentTime()),
	}
	e.result = result
	return result, nil
}

// --- Internal methods ---

func (e *ScenarioExecution) reset(ctx context.Context) {
	e.state = NewScenarioExecutionState(e.cfg)
	e.scenarioRunID = generateScenarioRunID(ctx)
	e.totalStartTime = time.Now()
	e.pendingMessages = make(map[int][]Message)
	e.agentTimes = make(map[int]time.Duration)
	e.result = nil
	e.checkpointResults = nil
	e.newTurn()
	e.state.currentTurn = 0
}

// step runs a single agent interaction.
func (e *ScenarioExecution) step(ctx context.Context, goToNextTurn bool, onTurn ProceedCallback) error {
	if len(e.pendingRolesOnTurn) == 0 {
		if !goToNextTurn {
			return nil
		}

		e.newTurn()

		if onTurn != nil {
			if err := onTurn(e.state); err != nil {
				return err
			}
		}

		if e.state.currentTurn >= e.cfg.MaxTurns {
			e.reachedMaxTurns("")
			return nil
		}
	}

	currentRole := e.pendingRolesOnTurn[0]
	idx, found := e.findAgentForRole(currentRole)
	if !found {
		e.removePendingRole(currentRole)
		return e.step(ctx, goToNextTurn, onTurn)
	}

	e.removePendingAgent(idx)

	return e.callAgent(ctx, idx, currentRole, nil)
}

// scriptCallAgent is the core routing logic for script step agent calls.
func (e *ScenarioExecution) scriptCallAgent(ctx context.Context, role AgentRole, content string, judgmentReq *JudgmentRequest) (*ScenarioResult, error) {
	e.consumeUntilRole(role)

	idx, found := e.findNextAgentForRole(role)
	if !found {
		e.newTurn()
		e.consumeUntilRole(role)
		idx, found = e.findNextAgentForRole(role)
	}

	if !found {
		roleClass := "your agent"
		switch role {
		case AgentRoleUser:
			roleClass = "a scenario.NewUserSimulatorAgent()"
		case AgentRoleAgent:
			roleClass = "your agent adapter"
		case AgentRoleJudge:
			roleClass = "a scenario.NewJudgeAgent()"
		}
		return nil, fmt.Errorf("cannot generate a message for role `%s` because no agent with this role was found, please add %s to the scenario agents list", role, roleClass)
	}

	e.removePendingAgent(idx)

	if content != "" {
		var msg Message
		if role == AgentRoleUser {
			msg = UserMsg(content)
		} else {
			msg = AssistantMsg(content)
		}
		e.state.AddMessage(msg)
		e.broadcastMessage(idx, msg)
		return nil, nil
	}

	err := e.callAgent(ctx, idx, role, judgmentReq)
	if err != nil {
		return nil, err
	}

	// Handle inline criteria checkpoint semantics
	if e.result != nil && judgmentReq != nil && len(judgmentReq.Criteria) > 0 {
		e.checkpointResults = append(e.checkpointResults, checkpointResult{
			metCriteria:   e.result.MetCriteria,
			unmetCriteria: e.result.UnmetCriteria,
		})

		if e.result.Success {
			// Checkpoint passed: clear result, continue script
			e.result = nil
			return nil, nil
		}
		// Checkpoint failed: compile all results into the failing result
		cp := e.compiledCheckpoints()
		e.result.MetCriteria = cp.metCriteria
		e.result.UnmetCriteria = cp.unmetCriteria
		return e.result, nil
	}

	// Merge any prior checkpoint criteria into the final result
	if e.result != nil {
		cp := e.compiledCheckpoints()
		e.result.MetCriteria = append(cp.metCriteria, e.result.MetCriteria...)
	}

	return e.result, nil
}

// callAgent prepares input, calls an agent, tracks timing, processes the return.
func (e *ScenarioExecution) callAgent(ctx context.Context, idx int, role AgentRole, judgmentReq *JudgmentRequest) error {
	agent := e.cfg.Agents[idx]

	// Create agent span as child of turn span if tracer is available
	agentCtx := ctx
	var agentSpan *langwatch.Span
	if e.tracer != nil && e.currentTurnSpan != nil {
		parentCtx := trace.ContextWithSpan(ctx, e.currentTurnSpan)
		var spanCtx context.Context
		spanCtx, agentSpan = e.tracer.Start(parentCtx, fmt.Sprintf("Agent.call [%s]", role),
			trace.WithAttributes(
				attribute.String("langwatch.thread.id", e.state.threadID),
				attribute.String("agent.role", string(role)),
			),
		)
		agentSpan.SetType(langwatch.SpanTypeAgent)
		agentSpan.RecordInput(e.state.Messages())
		agentCtx = spanCtx
	}

	startTime := time.Now()
	agentInput := AgentInput{
		ThreadID:        e.state.threadID,
		Messages:        e.state.Messages(),
		NewMessages:     e.pendingMessages[idx],
		RequestedRole:   role,
		JudgmentRequest: judgmentReq,
		ScenarioState:   e.state,
		ScenarioConfig:  e.cfg,
	}

	ret, err := agent.Call(agentCtx, agentInput)
	duration := time.Since(startTime)

	e.addAgentTime(idx, duration)
	delete(e.pendingMessages, idx)

	// End agent span
	if agentSpan != nil {
		if err != nil {
			agentSpan.RecordError(err)
		} else if ret != nil {
			agentSpan.RecordOutput(ret)
		}
		agentSpan.End()
	}

	if err != nil {
		return fmt.Errorf("agent call failed for role %s: %w", role, err)
	}

	// nil return means "continue" (e.g., judge chose continue_test)
	if ret == nil {
		return nil
	}

	return e.processReturn(idx, role, ret)
}

// processReturn converts an AgentReturn to messages or sets the result.
func (e *ScenarioExecution) processReturn(senderIdx int, role AgentRole, ret *AgentReturn) error {
	switch ret.Kind {
	case AgentReturnScenarioResult:
		e.result = &ret.ScenarioResultValue
		e.finalizeResult()
		return nil

	case AgentReturnString:
		var msg Message
		if role == AgentRoleUser {
			msg = UserMsg(ret.StringValue)
		} else {
			msg = AssistantMsg(ret.StringValue)
		}
		e.state.AddMessage(msg)
		e.broadcastMessage(senderIdx, msg)
		return nil

	case AgentReturnMessage:
		e.state.AddMessage(ret.MessageValue)
		e.broadcastMessage(senderIdx, ret.MessageValue)
		return nil

	case AgentReturnMessages:
		for _, msg := range ret.MessagesValue {
			e.state.AddMessage(msg)
			e.broadcastMessage(senderIdx, msg)
		}
		return nil

	default:
		return fmt.Errorf("unknown agent return kind: %d", ret.Kind)
	}
}

// broadcastMessage adds a message to all other agents' pending queues.
func (e *ScenarioExecution) broadcastMessage(fromIdx int, msg Message) {
	for i := range e.cfg.Agents {
		if i == fromIdx {
			continue
		}
		e.pendingMessages[i] = append(e.pendingMessages[i], msg)
	}
}

// newTurn resets pending roles/agents and increments the turn counter.
func (e *ScenarioExecution) newTurn() {
	// End previous turn span if any
	e.endTurnSpan()

	e.pendingAgentsOnTurn = make(map[int]bool)
	for i := range e.cfg.Agents {
		e.pendingAgentsOnTurn[i] = true
	}
	e.pendingRolesOnTurn = []AgentRole{
		AgentRoleUser,
		AgentRoleAgent,
		AgentRoleJudge,
	}
	e.state.IncrementTurn()

	// Start new turn span if tracer is available
	if e.tracer != nil {
		_, span := e.tracer.Start(context.Background(), "Scenario Turn",
			trace.WithAttributes(
				attribute.String("scenario.name", e.cfg.Name),
				attribute.String("scenario.id", e.cfg.ID),
				attribute.String("langwatch.thread.id", e.state.threadID),
				attribute.Int("scenario.turn", e.state.currentTurn),
			),
		)
		e.currentTurnSpan = span
	}
}

// endTurnSpan ends the current turn span if one is active.
func (e *ScenarioExecution) endTurnSpan() {
	if e.currentTurnSpan != nil {
		e.currentTurnSpan.End()
		e.currentTurnSpan = nil
	}
}

// findAgentForRole finds the first pending agent matching role in pendingAgentsOnTurn AND pendingRolesOnTurn.
func (e *ScenarioExecution) findAgentForRole(role AgentRole) (int, bool) {
	for i, agent := range e.cfg.Agents {
		if agent.Role() == role && e.pendingAgentsOnTurn[i] {
			return i, true
		}
	}
	return -1, false
}

// findNextAgentForRole finds the first agent matching role that is still pending.
func (e *ScenarioExecution) findNextAgentForRole(role AgentRole) (int, bool) {
	for i, agent := range e.cfg.Agents {
		if agent.Role() == role && e.pendingAgentsOnTurn[i] {
			return i, true
		}
	}
	return -1, false
}

// consumeUntilRole removes roles from pendingRolesOnTurn until the target role is at the front.
func (e *ScenarioExecution) consumeUntilRole(role AgentRole) {
	for len(e.pendingRolesOnTurn) > 0 {
		if e.pendingRolesOnTurn[0] == role {
			break
		}
		e.pendingRolesOnTurn = e.pendingRolesOnTurn[1:]
	}
}

func (e *ScenarioExecution) removePendingRole(role AgentRole) {
	for i, r := range e.pendingRolesOnTurn {
		if r == role {
			e.pendingRolesOnTurn = append(e.pendingRolesOnTurn[:i], e.pendingRolesOnTurn[i+1:]...)
			return
		}
	}
}

func (e *ScenarioExecution) removePendingAgent(idx int) {
	delete(e.pendingAgentsOnTurn, idx)
}

func (e *ScenarioExecution) addAgentTime(idx int, d time.Duration) {
	e.agentTimes[idx] = e.agentTimes[idx] + d
}

func (e *ScenarioExecution) totalAgentTime() time.Duration {
	var total time.Duration
	for i, agent := range e.cfg.Agents {
		if agent.Role() == AgentRoleAgent {
			total += e.agentTimes[i]
		}
	}
	return total
}

// finalizeResult fills in RunID, Messages, TotalTime, AgentTime on the result.
func (e *ScenarioExecution) finalizeResult() {
	if e.result == nil {
		return
	}
	e.result.RunID = e.scenarioRunID
	e.result.Messages = e.state.messages
	e.result.TotalTime = ptr.Ptr(time.Since(e.totalStartTime))
	e.result.AgentTime = ptr.Ptr(e.totalAgentTime())
}

func (e *ScenarioExecution) reachedMaxTurns(errorMessage string) {
	if errorMessage == "" {
		errorMessage = fmt.Sprintf("Reached maximum turns (%d) without conclusion", e.cfg.MaxTurns)
	}

	// Try to get judge criteria for unmet
	var unmetCriteria []string
	for _, agent := range e.cfg.Agents {
		if ja, ok := agent.(*JudgeAgent); ok {
			unmetCriteria = ja.GetCriteria()
			break
		}
	}
	if unmetCriteria == nil {
		unmetCriteria = []string{}
	}

	e.result = &ScenarioResult{
		RunID:         e.scenarioRunID,
		Success:       false,
		Messages:      e.state.messages,
		Reasoning:     &errorMessage,
		MetCriteria:   []string{},
		UnmetCriteria: unmetCriteria,
		TotalTime:     ptr.Ptr(time.Since(e.totalStartTime)),
		AgentTime:     ptr.Ptr(e.totalAgentTime()),
	}
}

func (e *ScenarioExecution) compiledCheckpoints() checkpointResult {
	var met, unmet []string
	for _, cp := range e.checkpointResults {
		met = append(met, cp.metCriteria...)
		unmet = append(unmet, cp.unmetCriteria...)
	}
	return checkpointResult{metCriteria: met, unmetCriteria: unmet}
}

// --- Event emission ---

func (e *ScenarioExecution) emitEvent(event ScenarioEvent) {
	if e.eventBus != nil {
		e.eventBus.Publish(event)
	}
}

func (e *ScenarioExecution) emitRunStarted() {
	e.emitEvent(RunStartedEvent{
		timestamp:     time.Now(),
		BatchRunID:    e.batchRunID,
		ScenarioRunID: e.scenarioRunID,
		ScenarioSetID: e.cfg.SetID,
		ScenarioID:    e.cfg.ID,
		ScenarioName:  e.cfg.Name,
		Description:   e.cfg.Description,
		Metadata:      e.cfg.Metadata,
	})
}

func (e *ScenarioExecution) emitMessageSnapshot() {
	e.emitEvent(MessageSnapshotEvent{
		timestamp:     time.Now(),
		BatchRunID:    e.batchRunID,
		ScenarioRunID: e.scenarioRunID,
		ScenarioSetID: e.cfg.SetID,
		ScenarioID:    e.cfg.ID,
		Messages:      e.state.Messages(),
	})
}

func (e *ScenarioExecution) emitRunFinished() {
	e.emitEvent(RunFinishedEvent{
		timestamp:     time.Now(),
		BatchRunID:    e.batchRunID,
		ScenarioRunID: e.scenarioRunID,
		ScenarioSetID: e.cfg.SetID,
		ScenarioID:    e.cfg.ID,
		Result:        e.result,
	})
}
