package scenario

// This file is a template, not part of the scenario package. run.sh copies
// it into go/ for one `go test -bench`, so it can reach the unexported
// AG-UI and event encoders, and deletes it afterwards. The inputs match
// js/micro.mjs exactly; change both together.

import (
	"fmt"
	"testing"
)

// govsjsMessages is the 20-message conversation of the micro benchmarks:
// alternating user and assistant text with fixed ids.
func govsjsMessages() []Message {
	msgs := make([]Message, 0, 20)
	for i := range 20 {
		var m Message
		if i%2 == 0 {
			m = UserMsg(fmt.Sprintf("user message number %d with some text", i))
		} else {
			m = AssistantMsg(fmt.Sprintf("assistant reply number %d with some longer text in it", i))
		}
		m.ID = fmt.Sprintf("msg_%02d", i)
		msgs = append(msgs, m)
	}
	return msgs
}

var govsjsBase = eventBase{batchRunID: "b", scenarioID: "i", scenarioRunID: "r", scenarioSetID: "s"}

const govsjsTimestamp = 1700000000000

var govsjsSink int

// BenchmarkGoVsJSAGUIConvert20 converts 20 messages to AG-UI JSON rows.
// JS: convertModelMessagesToAguiMessages(20 messages), which builds objects
// (no JSON yet).
func BenchmarkGoVsJSAGUIConvert20(b *testing.B) {
	msgs := govsjsMessages()
	b.ReportAllocs()
	for b.Loop() {
		for _, m := range msgs {
			govsjsSink += len(aguiRows(m))
		}
	}
}

// BenchmarkGoVsJSSnapshotFromScratch20 builds one MESSAGE_SNAPSHOT body of
// the 20 messages from nothing: AG-UI rows, then the envelope. This is the
// same work the JS SDK does for every snapshot event.
func BenchmarkGoVsJSSnapshotFromScratch20(b *testing.B) {
	msgs := govsjsMessages()
	rows := make([][]byte, len(msgs))
	b.ReportAllocs()
	for b.Loop() {
		for i, m := range msgs {
			rows[i] = aguiRows(m)[0].json
		}
		govsjsSink += len(govsjsBase.snapshotPayload(govsjsTimestamp, rows))
	}
}

// BenchmarkGoVsJSSnapshotCached20 builds the same body the way the Go
// executor does after every message: each message's AG-UI JSON is encoded
// once per run and cached, so only the envelope is new.
func BenchmarkGoVsJSSnapshotCached20(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 10})
	for _, m := range govsjsMessages() {
		st.add(m, m.ID)
	}
	_ = st.aguiRowsJSON()
	b.ReportAllocs()
	for b.Loop() {
		govsjsSink += len(govsjsBase.snapshotPayload(govsjsTimestamp, st.aguiRowsJSON()))
	}
}
