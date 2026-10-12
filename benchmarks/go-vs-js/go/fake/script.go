// Package fake holds the deterministic stand-ins the Go side of the
// Go-vs-JS benchmark runs against: a scripted LLM, the agent under test and
// a local HTTP sink for scenario events.
//
// The script is duplicated, word for word, in ../../js/lib/fake-model.mjs.
// Change both together, or the two SDKs stop doing the same work.
package fake

// Script texts. They are the same strings on the JS side.
const (
	// UserText is every reply of the user simulator.
	UserText = "Hi, I ordered a blue kettle last week and it has not arrived yet. Where is order 42?"
	// AgentText is the agent's answer after it read the tool result.
	AgentText = "Your order 42 left our warehouse yesterday and should arrive within two days."
	// OrderTool is the tool the agent under test calls once per turn.
	OrderTool = "get_order_status"
	// OrderArgs are the arguments of every get_order_status call.
	OrderArgs = `{"order_id":"42"}`
	// OrderResult is what the get_order_status tool returns.
	OrderResult = `{"order_id":"42","status":"shipped","eta_days":2}`
	// Criterion is the single judge criterion.
	Criterion = "Agent responds"
	// CriterionKey is the finish_test property the SDKs derive from Criterion.
	CriterionKey = "agent_responds"
	// FinishArgs is the judge's verdict on the last turn.
	FinishArgs = `{"criteria":{"agent_responds":{"requirement":"Agent responds","reasoning":"The agent answered with the order status.","status":"passed"}},"reasoning":"The agent answered the question."}`
	// ModelName is reported as the model id.
	ModelName = "fake-model"
	// Description is the scenario description.
	Description = "A customer asks the support agent where their order is."
	// MaxTurns is the number of turns of the full scenario.
	MaxTurns = 10
)

// Reply is what the scripted model answers to one request: text, or one
// tool call.
type Reply struct {
	Text     string
	ToolName string
	ToolArgs string
}

// Decide is the whole script. It looks only at which tools the request
// offers and whether the last message is a tool result:
//
//   - finish_test offered (judge, verdict phase): call finish_test with FinishArgs
//   - continue_test offered (judge, decision phase): call continue_test
//   - get_order_status offered (agent under test): call it, or answer
//     AgentText once the last message is its result
//   - no tools (user simulator): answer UserText
func Decide(tools func(name string) bool, lastIsToolResult bool) Reply {
	switch {
	case tools("finish_test"):
		return Reply{ToolName: "finish_test", ToolArgs: FinishArgs}
	case tools("continue_test"):
		return Reply{ToolName: "continue_test", ToolArgs: "{}"}
	case tools(OrderTool):
		if lastIsToolResult {
			return Reply{Text: AgentText}
		}
		return Reply{ToolName: OrderTool, ToolArgs: OrderArgs}
	}
	return Reply{Text: UserText}
}
