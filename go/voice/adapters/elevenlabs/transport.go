package elevenlabs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/apihttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// AdapterName is the name the transport reports in spans, warnings and
// errors: the JavaScript SDK's class name.
const AdapterName = "ElevenLabsAgentAdapter"

// hangupTools are the system tools whose successful call means the agent
// ended this session on purpose.
var hangupTools = map[string]bool{
	"end_call":            true,
	"transfer_to_agent":   true,
	"transfer_to_number":  true,
	"transfer_to_genesys": true,
}

// ErrNotConnected is returned by I/O on a transport with no live session.
var ErrNotConnected = errors.New(AdapterName + ": not connected")

// Transport is a session with a hosted ElevenLabs ConvAI agent. It
// implements [voice.Transport] and the optional voice.ConnectionReporter,
// voice.HangupReporter, voice.TranscriptSource, voice.StreamingTranscriber
// and voice.PendingAudioReconciler. It is safe for concurrent use.
type Transport struct {
	o Options
	// timings reports the owning agent's turn timings; nil standalone.
	timings *voice.Agent
	// ceilingFloor is the minimum absolute receive ceiling.
	ceilingFloor time.Duration
	// silenceMsg is the encoded closing-silence frame.
	silenceMsg []byte

	mu   sync.Mutex
	conn *websocket.Conn
	// open is false once the socket closed or failed.
	open, stopping         bool
	cancelPump, cancelRead context.CancelFunc
	readDone, pumpDone     chan struct{}
	connectSpan            trace.Span

	// Agent audio pushed by the read loop ahead of a receiver, and the
	// receivers waiting for it (FIFO).
	queue   []voice.AudioChunk
	waiters []*receiveWait

	// Outbound speech for the pump: whole 960-byte frames from outPos on.
	out    []byte
	outPos int
	stats  pumpStats

	awaitingUserTurn bool
	toolsInFlight    int
	toolTurnOpen     bool
	lastInterruptID  int64
	interruptValid   bool

	lastUserTranscript  string
	lastAgentTranscript string
	lastAgentAudioAt    time.Time
	conversationID      string
	conversationStamped bool
	hungUp              bool
	audioCommits        int
}

// New returns a transport for the agent in o. A malformed BaseURL or an
// unknown TurnCommitMode is reported here rather than at the first request.
func New(o Options) (*Transport, error) {
	r, err := o.resolved()
	if err != nil {
		return nil, err
	}
	return &Transport{
		o:               r,
		ceilingFloor:    keepaliveHardCeiling,
		silenceMsg:      appendUserAudioChunk(nil, make([]byte, pumpFrameBytes)),
		interruptValid:  true, // the SDK starts gating at event id 0
		lastInterruptID: 0,
	}, nil
}

// Name implements voice.Named.
func (t *Transport) Name() string { return AdapterName }

// String redacts the API key; dynamic variables are never printed.
func (t *Transport) String() string {
	return fmt.Sprintf("%s(agentId='%s', apiKey='***')", AdapterName, t.o.AgentID)
}

// AgentID is the hosted agent's id.
func (t *Transport) AgentID() string { return t.o.AgentID }

// Capabilities implements voice.Transport.
func (t *Transport) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		StreamingTranscripts: true,
		NativeVAD:            true,
		InputFormats:         []string{"pcm16/24000"},
		OutputFormats:        []string{"pcm16/24000"},
	}
}

func (t *Transport) responseTimeout() time.Duration {
	if t.timings != nil {
		return t.timings.ResponseTimeout
	}
	return voice.DefaultResponseTimeout
}

func (t *Transport) responseTailSilence() time.Duration {
	if t.timings != nil {
		return t.timings.ResponseTailSilence
	}
	return voice.DefaultResponseTailSilence
}

// ---------------------------------------------------------------- lifecycle

// Connect mints the signed session URL, opens the WebSocket, sends the
// handshake and starts the microphone pump. The agent id is stamped on the
// span in ctx.
func (t *Transport) Connect(ctx context.Context) error {
	span := trace.SpanFromContext(ctx)
	voice.SetSpanAttributes(span, attribute.String("voice.elevenlabs.agent_id", t.o.AgentID))
	t.mu.Lock()
	busy, stale := t.activeLocked(), t.conn != nil
	t.mu.Unlock()
	if busy {
		return errors.New(AdapterName + ": session already started")
	}
	if stale {
		// The previous session closed on its own; finish its teardown.
		_ = t.Disconnect(ctx)
	}
	wsURL, err := t.signedURL(ctx)
	if err != nil {
		return err
	}
	init, err := encodeInit(t.o.conversationConfigOverride(), t.o.DynamicVariables)
	if err != nil {
		return fmt.Errorf("%s: encoding the handshake: %w", AdapterName, err)
	}
	conn, err := t.o.Dialer(ctx, wsURL)
	if err != nil {
		return fmt.Errorf("%s: opening the session: %w", AdapterName, err)
	}
	conn.SetReadLimit(maxMessageBytes)
	if err := conn.Write(ctx, websocket.MessageText, init); err != nil {
		conn.CloseNow()
		return fmt.Errorf("%s: sending the handshake: %w", AdapterName, err)
	}
	// The session outlives Connect's context: it ends with Disconnect.
	base := context.WithoutCancel(ctx)
	readCtx, cancelRead := context.WithCancel(base)
	pumpCtx, cancelPump := context.WithCancel(base)
	t.mu.Lock()
	t.conn, t.open, t.stopping = conn, true, false
	t.cancelRead, t.cancelPump = cancelRead, cancelPump
	t.connectSpan = span
	t.hungUp = false
	t.readDone, t.pumpDone = make(chan struct{}), make(chan struct{})
	t.stats = pumpStats{}
	readDone, pumpDone := t.readDone, t.pumpDone
	t.mu.Unlock()
	go t.readLoop(readCtx, conn, readDone)
	go t.runPump(pumpCtx, conn, pumpDone)
	return nil
}

// signedURL mints the session URL of the (private) agent and appends the
// SDK's source and version query.
func (t *Transport) signedURL(ctx context.Context) (string, error) {
	endpoint := apihttp.JoinURL(t.o.BaseURL, signedURLPath) + "?agent_id=" + url.QueryEscape(t.o.AgentID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("xi-api-key", t.o.APIKey)
	body, err := apihttp.Do(t.o.HTTPClient, req, "ElevenLabs signed-URL mint")
	if err != nil {
		return "", err
	}
	var res struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.Unmarshal(body, &res); err != nil || res.SignedURL == "" {
		return "", fmt.Errorf("ElevenLabs signed-URL mint: no signed_url in the response")
	}
	return withSDKQuery(res.SignedURL), nil
}

// withSDKQuery appends the SDK's source and version to a signed URL.
func withSDKQuery(signed string) string {
	sep := "?"
	if strings.Contains(signed, "?") {
		sep = "&"
	}
	return signed + sep + "source=" + wireSource + "&version=" + wireVersion
}

// IsConnected implements voice.ConnectionReporter: the session is open and
// not shutting down.
func (t *Transport) IsConnected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.activeLocked()
}

func (t *Transport) activeLocked() bool { return t.conn != nil && t.open && !t.stopping }

// AgentHungUp implements voice.HangupReporter: the agent ended the call
// with end_call or a transfer tool.
func (t *Transport) AgentHungUp() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.hungUp
}

// Disconnect stops the pump, stamps its counters on the span in ctx, closes
// the session and releases any waiting receiver with an empty chunk.
func (t *Transport) Disconnect(ctx context.Context) error {
	t.mu.Lock()
	t.stopPumpLocked()
	stats := t.stats
	t.conversationID, t.conversationStamped = "", false
	conn, cancelRead, readDone, pumpDone := t.conn, t.cancelRead, t.readDone, t.pumpDone
	t.conn, t.cancelRead = nil, nil
	t.stopping = true
	t.mu.Unlock()
	voice.SetSpanAttributes(trace.SpanFromContext(ctx),
		attribute.Int("voice.elevenlabs.pump.ticks_total", stats.ticks),
		attribute.Int("voice.elevenlabs.pump.speech_frames_sent", stats.speech),
		attribute.Int("voice.elevenlabs.pump.silence_frames_sent", stats.silence),
		attribute.Int("voice.elevenlabs.pump.unexpected_errors", stats.unexpectedErrors))
	if conn != nil {
		<-pumpDone
		// Best effort: a half-closed session may refuse the close handshake.
		if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
			conn.CloseNow()
		}
		cancelRead()
		<-readDone
	}
	t.mu.Lock()
	t.drainWaitersLocked()
	t.mu.Unlock()
	return nil
}

// ------------------------------------------------------------- text events

// SendUserMessage sends a user text turn ({"type":"user_message"}). The
// agent answers it as if spoken, but its STT and VAD do not run.
func (t *Transport) SendUserMessage(ctx context.Context, text string) error {
	return t.sendText(ctx, evUserMessage, text)
}

// SendContextualUpdate sends non-interrupting context the agent takes into
// account without answering it ({"type":"contextual_update"}).
func (t *Transport) SendContextualUpdate(ctx context.Context, text string) error {
	return t.sendText(ctx, evContextualUpdate, text)
}

func (t *Transport) sendText(ctx context.Context, eventType, text string) error {
	msg, err := encodeText(eventType, text)
	if err != nil {
		return err
	}
	t.mu.Lock()
	conn, ok := t.conn, t.activeLocked()
	t.mu.Unlock()
	if !ok {
		return ErrNotConnected
	}
	return conn.Write(ctx, websocket.MessageText, msg)
}

// ------------------------------------------------------------ transcripts

// LastAgentTranscript implements voice.TranscriptSource: the agent's own
// transcript of the current turn (agent_response, replaced by a
// post-barge-in correction).
func (t *Transport) LastAgentTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastAgentTranscript
}

// ResetAgentTranscript implements voice.TranscriptSource.
func (t *Transport) ResetAgentTranscript() {
	t.mu.Lock()
	t.lastAgentTranscript = ""
	t.mu.Unlock()
}

// StreamingTranscript implements voice.StreamingTranscriber with the
// agent's transcript of the current turn as far as it has arrived.
func (t *Transport) StreamingTranscript() string { return t.LastAgentTranscript() }

// LastUserTranscript is the agent's STT of the latest user turn
// (user_transcript): non-empty after a turn proves the audio reached it.
func (t *Transport) LastUserTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastUserTranscript
}

// AudioCommitCount is how many user turns were committed as real audio.
func (t *Transport) AudioCommitCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.audioCommits
}

// ConversationID is ElevenLabs' id for the current session, once its
// conversation_initiation_metadata arrived; "" before.
func (t *Transport) ConversationID() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conversationID
}

// stampConversationIDLocked puts the conversation id on span once, and
// only counts it stamped when the span was live enough to take it: the
// metadata routinely lands after the connect span ended, and marking that
// dropped write as done would lose the id for good.
func (t *Transport) stampConversationIDLocked(span trace.Span) {
	if t.conversationID == "" || t.conversationStamped || span == nil || !span.IsRecording() {
		return
	}
	voice.SetSpanAttributes(span, attribute.String("voice.elevenlabs.conversation_id", t.conversationID))
	t.conversationStamped = true
}

// ---------------------------------------------------------------- reading

// readLoop routes every server message until the socket closes.
func (t *Transport) readLoop(ctx context.Context, conn *websocket.Conn, done chan struct{}) {
	defer close(done)
	var rs readState
	for {
		var err error
		rs.buf, err = readMessage(ctx, conn, rs.buf[:0])
		if err != nil {
			t.sessionEnded(err)
			return
		}
		t.mu.Lock()
		stopping := t.stopping
		t.mu.Unlock()
		if stopping {
			continue // the SDK ignores messages once the session is ending
		}
		t.handleMessage(ctx, conn, &rs)
	}
}

// readState is the read loop's reusable scratch space.
type readState struct {
	buf, pong []byte
	frame     inboundFrame
}

// readMessage reads one message into dst, reusing its capacity.
func readMessage(ctx context.Context, conn *websocket.Conn, dst []byte) ([]byte, error) {
	_, r, err := conn.Reader(ctx)
	if err != nil {
		return dst, err
	}
	for {
		if len(dst) == cap(dst) {
			dst = append(dst, 0)[:len(dst)]
		}
		n, err := r.Read(dst[len(dst):cap(dst)])
		dst = dst[:len(dst)+n]
		if err != nil {
			if errors.Is(err, io.EOF) {
				return dst, nil
			}
			return dst, err
		}
	}
}

// sessionEnded handles the socket closing (or failing): the pump stops and
// waiting receivers get an empty chunk so the drain exits instead of
// hanging.
func (t *Transport) sessionEnded(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.stopping && websocket.CloseStatus(err) == -1 {
		t.o.Logger.Warn(AdapterName + ": session error: " + err.Error())
	}
	t.open = false
	t.stopPumpLocked()
	t.drainWaitersLocked()
}

// handleMessage routes one server message the way the SDK's Conversation
// does, then runs the adapter's own per-message hook.
func (t *Transport) handleMessage(ctx context.Context, conn *websocket.Conn, rs *readState) {
	data, f := rs.buf, &rs.frame
	if !parseFrame(data, f) {
		t.o.Logger.Error("Error parsing WebSocket message", "bytes", len(data))
		return
	}
	switch string(f.typ) {
	case evAudio:
		if !t.onAudio(f) {
			return
		}
	case evPing:
		rs.pong = appendPong(rs.pong[:0], f.eventID)
		_ = conn.Write(ctx, websocket.MessageText, rs.pong)
	case evInterruption:
		id, ok := parseEventID(f.eventID)
		t.mu.Lock()
		t.lastInterruptID, t.interruptValid = id, ok
		t.mu.Unlock()
	case evClientToolCall:
		t.replyToClientTool(ctx, conn, data)
	}
	t.onMessage(internType(f.typ), data)
}

// onAudio queues an audio event for a receiver. It returns false for audio
// of a response the user interrupted, which the SDK drops before any other
// processing.
func (t *Transport) onAudio(f *inboundFrame) bool {
	t.mu.Lock()
	gate, valid := t.lastInterruptID, t.interruptValid
	t.mu.Unlock()
	if id, ok := parseEventID(f.audioEventID); ok && valid && id <= gate {
		return false
	}
	pcm, err := decodeAudio(f.audioB64)
	if err != nil {
		t.o.Logger.Error("Error parsing WebSocket message", "error", err.Error())
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	// The agent's turn audio arrived: pause the idle microphone until the
	// next user turn. Audio after the last tool answered is the post-tool
	// answer, so the tail probe applies again.
	t.awaitingUserTurn = true
	if t.toolsInFlight == 0 {
		t.toolTurnOpen = false
	}
	t.lastAgentAudioAt = time.Now()
	t.deliverLocked(voice.AudioChunk{Data: pcm})
	return true
}

// replyToClientTool answers a client tool call the way the SDK does when no
// handler is registered for it.
func (t *Transport) replyToClientTool(ctx context.Context, conn *websocket.Conn, data []byte) {
	var ev struct {
		ClientToolCall struct {
			ToolName   string          `json:"tool_name"`
			ToolCallID json.RawMessage `json:"tool_call_id"`
		} `json:"client_tool_call"`
	}
	if json.Unmarshal(data, &ev) != nil {
		return
	}
	msg, err := encodeUnregisteredToolResult(ev.ClientToolCall.ToolName, ev.ClientToolCall.ToolCallID)
	if err == nil {
		_ = conn.Write(ctx, websocket.MessageText, msg)
	}
}

// controlEvent is the decoded view of the low-rate server messages.
type controlEvent struct {
	Metadata *struct {
		ConversationID string `json:"conversation_id"`
		OutputFormat   string `json:"agent_output_audio_format"`
		InputFormat    string `json:"user_input_audio_format"`
	} `json:"conversation_initiation_metadata_event"`
	AgentResponse *struct {
		Text string `json:"agent_response"`
	} `json:"agent_response_event"`
	Correction *struct {
		Corrected string `json:"corrected_agent_response"`
	} `json:"agent_response_correction_event"`
	UserTranscript *struct {
		Text string `json:"user_transcript"`
	} `json:"user_transcription_event"`
	ToolResponse *struct {
		ToolName  string `json:"tool_name"`
		IsCalled  *bool  `json:"is_called"`
		IsError   *bool  `json:"is_error"`
		IsBlocked *bool  `json:"is_blocked"`
	} `json:"agent_tool_response"`
}

// decodeControl decodes a low-rate message. It is a separate function so
// the hot path (audio, pings) never pays for the decode target's
// allocation.
func decodeControl(data []byte) controlEvent {
	ev := new(controlEvent)
	_ = json.Unmarshal(data, ev)
	return *ev
}

// needsDecode lists the message types whose payload the transport reads.
func needsDecode(etype string) bool {
	switch etype {
	case evInitMetadata, evAgentResponse, evAgentCorrection, evUserTranscript, evAgentToolResponse:
		return true
	}
	return false
}

// onMessage is the per-message hook, run for every routed message: tool
// bookkeeping, re-arming the waiting receivers' idle deadlines, terminal
// client tool calls, hangups, transcripts and the conversation id.
func (t *Transport) onMessage(etype string, data []byte) {
	var ev controlEvent
	if needsDecode(etype) {
		ev = decodeControl(data)
	}
	var lagLog func()
	t.mu.Lock()
	switch etype {
	case evAgentToolRequest:
		t.toolsInFlight++
		t.toolTurnOpen = true
	case evAgentToolResponse:
		t.toolsInFlight = max(0, t.toolsInFlight-1)
	}
	now := time.Now()
	for _, w := range t.waiters {
		w.onFrame(t, etype, now)
	}
	switch etype {
	case evClientToolCall:
		// A tool-only turn produces no spoken audio: hand a waiting receiver
		// the empty terminal chunk. With none waiting it is dropped, never
		// queued, so it cannot surface as the next turn's first chunk.
		if len(t.waiters) > 0 {
			t.handOffLocked(voice.AudioChunk{})
		}
	case evAgentToolResponse:
		if tr := ev.ToolResponse; tr != nil && hangupTools[tr.ToolName] &&
			isTrue(tr.IsCalled) && !isTrue(tr.IsError) && !isTrue(tr.IsBlocked) {
			t.o.Logger.Info(AdapterName + ": agent invoked " + tr.ToolName + " — treating the upcoming close as a deliberate hangup")
			t.hungUp = true
		}
	case evInitMetadata:
		if m := ev.Metadata; m != nil {
			if m.ConversationID != "" {
				t.conversationID = m.ConversationID
				t.stampConversationIDLocked(t.connectSpan)
			}
			t.warnOnFormatDriftLocked(m.OutputFormat, m.InputFormat)
		}
	case evAgentResponse:
		if r := ev.AgentResponse; r != nil {
			t.lastAgentTranscript = strings.TrimSpace(r.Text)
			lagLog = t.transcriptLagLogLocked(now)
		}
	case evAgentCorrection:
		if c := ev.Correction; c != nil {
			t.lastAgentTranscript = strings.TrimSpace(c.Corrected)
		}
	case evUserTranscript:
		if u := ev.UserTranscript; u != nil {
			t.lastUserTranscript = strings.TrimSpace(u.Text)
		}
	}
	t.mu.Unlock()
	if lagLog != nil {
		lagLog()
	}
}

func isTrue(b *bool) bool { return b != nil && *b }

// transcriptLagLogLocked measures how far the agent_response transcript
// lags the turn's last audio: a lag past ResponseTailSilence is a turn whose
// transcript lands after the drain closed, covered by the runtime's grace
// wait.
func (t *Transport) transcriptLagLogLocked(now time.Time) func() {
	at := t.lastAgentAudioAt
	tail := t.responseTailSilence()
	return func() {
		args := []any{"responseTailSilenceMs", tail.Milliseconds()}
		if !at.IsZero() {
			lag := now.Sub(at)
			args = append(args, "transcriptLagMs", lag.Milliseconds(), "lostRacePreFix", lag > tail)
		}
		t.o.Logger.Debug("agent_response transcript received", args...)
	}
}

// warnOnFormatDriftLocked warns when ElevenLabs negotiated another audio
// format than the pcm_24000 the transport streams.
func (t *Transport) warnOnFormatDriftLocked(out, in string) {
	if out != "" && out != canonicalAudioFormat {
		t.o.Logger.Warn(AdapterName + ": agent_output_audio_format=" + out +
			" differs from advertised pcm16/24000 capability; audio may pitch-shift or fail to decode.")
	}
	if in != "" && in != canonicalAudioFormat {
		t.o.Logger.Warn(AdapterName + ": user_input_audio_format=" + in +
			" differs from advertised pcm16/24000 capability; the agent may not understand audio we send.")
	}
}
