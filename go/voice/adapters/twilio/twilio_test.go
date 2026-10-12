package twilio

// Ported from twilio.test.ts: capabilities, interrupt, validation,
// signatures, DTMF, the caller filter, the stop flush and a-leg external
// mode. The attachStream/attachStreamToSelf conflict cases are not ported:
// the Go API has one CallOptions.Attach field, so the legacy boolean and its
// disagreement cannot be expressed.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
)

func TestCapabilities(t *testing.T) {
	a := makeAdapter(t, newSpyREST())
	c := a.Capabilities()
	if !reflect.DeepEqual(c.InputFormats, []string{"mulaw/8000"}) || !reflect.DeepEqual(c.OutputFormats, []string{"mulaw/8000"}) {
		t.Fatalf("formats %v %v", c.InputFormats, c.OutputFormats)
	}
	if !c.Interruption || !c.DTMF || c.NativeVAD || c.StreamingTranscripts {
		t.Fatalf("caps %+v", c)
	}
	if a.Name() != "TwilioAgentAdapter" {
		t.Fatalf("name %q", a.Name())
	}
}

func TestInterruptSendsClearFrame(t *testing.T) {
	a := connected(t, makeAdapter(t, newSpyREST(), withoutGate()))
	c := newConn(`{"event":"start","start":{"streamSid":"MZinterrupt","callSid":"CAinterrupt"}}`)
	loop := drive(t, a, c, false)
	if err := a.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	sent := c.sentFrames()
	var f map[string]string
	if len(sent) != 1 || json.Unmarshal(sent[0], &f) != nil || f["event"] != "clear" || f["streamSid"] != "MZinterrupt" {
		t.Fatalf("sent %q", sent)
	}
	c.Close()
	await(t, loop)
}

func TestCodecRoundTripPreservesSine(t *testing.T) {
	const n = 2400
	orig := make([]byte, 2*n)
	for i := range n {
		audio.PutSample(orig, i, int16(jsRound(sin(2*3.141592653589793*440*float64(i)/24000)*20000)))
	}
	mulaw := audio.AppendMulaw8k(nil, orig)
	if len(mulaw) != n/3 {
		t.Fatalf("µ-law length %d, want %d", len(mulaw), n/3)
	}
	back := audio.AppendPCM24kFromMulaw8k(nil, mulaw)
	total := 0.0
	cmp := min(n, len(back)/2)
	for i := range cmp {
		total += abs(float64(audio.Sample(orig, i)) - float64(audio.Sample(back, i)))
	}
	if avg := total / float64(cmp); avg >= 2000 {
		t.Fatalf("average sample error %.0f", avg)
	}
	if len(audio.AppendMulaw8k(nil, nil)) != 0 || len(audio.AppendPCM24kFromMulaw8k(nil, nil)) != 0 {
		t.Fatal("empty input must give empty output")
	}
}

func TestValidateE164AndDTMF(t *testing.T) {
	for _, ok := range []string{"+14155551234", "+447700900123"} {
		if err := ValidateE164(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"14155551234", "+0155551234", "+1234", ""} {
		if err := ValidateE164(bad); err == nil || !strings.Contains(err.Error(), "E.164") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if err := ValidateE164("+0155551234"); strings.Contains(err.Error(), "0155551234") {
		t.Errorf("the error leaks the number: %v", err)
	}
	for _, ok := range []string{"123", "*0#", "1wW2"} {
		if err := ValidateDTMF(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "12a", `1"/><Say>x</Say><Play digits="`} {
		if err := ValidateDTMF(bad); err == nil || !strings.Contains(err.Error(), "DTMF") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if RedactE164("+14155551234") != "***1234" || RedactE164("") != "***" || RedactE164("+12") != "***" {
		t.Error("redaction")
	}
}

// signFixture computes a signature independently of the adapter.
func signFixture(authToken, u string, params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sortStrings(keys)
	data := u
	for _, k := range keys {
		data += k + params[k]
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	mac.Write([]byte(data))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature(t *testing.T) {
	u := "https://example.test/twilio/voice"
	params := map[string]string{"From": "+14155557777", "CallSid": "CA1"}
	if !VerifySignature("test-token-xyz", u, params, signFixture("test-token-xyz", u, params)) {
		t.Error("a signature over the same inputs is rejected")
	}
	if VerifySignature("real", u, params, signFixture("wrong", u, params)) {
		t.Error("a different auth token is accepted")
	}
	if VerifySignature("shared", u, params, signFixture("shared", "https://attacker.test/twilio/voice", params)) {
		t.Error("a different URL is accepted")
	}
	if VerifySignature("x", "https://example.test", nil, "") || VerifySignature("x", u, nil, "%%%") {
		t.Error("a missing or malformed signature is accepted")
	}
}

func TestOnDTMFFires(t *testing.T) {
	got := make(chan string, 1)
	a := makeAdapter(t, newSpyREST(), withoutGate())
	a.onDTMF = func(d string) { got <- d }
	connected(t, a)
	c := newConn(`{"event":"start","start":{"streamSid":"MZdtmf","callSid":"CAdtmf"}}`,
		`{"event":"dtmf","streamSid":"MZdtmf","dtmf":{"digit":"5"}}`)
	loop := drive(t, a, c, false)
	select {
	case d := <-got:
		if d != "5" {
			t.Fatalf("digit %q", d)
		}
	case <-time.After(time.Second):
		t.Fatal("OnDTMF never fired")
	}
	c.Close()
	await(t, loop)
}

func TestOnDTMFPanicDoesNotStopTheStream(t *testing.T) {
	a := makeAdapter(t, newSpyREST(), withoutGate())
	a.onDTMF = func(string) { panic("boom") }
	connected(t, a)
	c := newConn(startFrame(startOpts{}), dtmfFrame("1"), dtmfFrame("2"))
	loop := drive(t, a, c, false)
	if n := state(a, func(a *Adapter) int { return a.dtmfReceived }); n != 2 {
		t.Fatalf("dtmf received %d", n)
	}
	c.Close()
	await(t, loop)
}

func postVoice(t *testing.T, a *Adapter, form url.Values, signature string) (*http.Response, string) {
	t.Helper()
	base, err := a.LocalBaseURL()
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, base+"/twilio/voice", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if signature != "" {
		req.Header.Set("X-Twilio-Signature", signature)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestRejectsDisallowedCallers(t *testing.T) {
	a := makeAdapter(t, newSpyREST(), func(o *Options) { o.AllowedCallers = []string{"+14155557777"} })
	connected(t, a)
	resp, body := postVoice(t, a, url.Values{"From": {"+14155550000"}, "CallSid": {"CAblocked"}}, "")
	if resp.StatusCode != 200 || !strings.Contains(body, "<Reject/>") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if n := state(a, func(a *Adapter) int { return a.rejected }); n != 1 {
		t.Fatalf("rejected %d", n)
	}
	resp, body = postVoice(t, a, url.Values{"From": {"+14155557777"}}, "")
	if resp.StatusCode != 200 || !strings.Contains(body, "<Connect><Stream") {
		t.Fatalf("allowed caller: %d %s", resp.StatusCode, body)
	}
}

func TestStopFlushesBufferedMulaw(t *testing.T) {
	a := connected(t, makeAdapter(t, newSpyREST(), withoutGate()))
	payload := make([]byte, 400) // 50 ms: under the 100 ms batch
	for i := range payload {
		payload[i] = 0xff
	}
	c := newConn(`{"event":"start","start":{"streamSid":"MZstop","callSid":"CAstop"}}`, mediaFrame("MZstop", payload), stopFrame)
	if err := await(t, drive(t, a, c, false)); err != nil {
		t.Fatal(err)
	}
	chunk, err := a.ReceiveAudio(context.Background(), 500*time.Millisecond)
	if err != nil || len(chunk.Data) == 0 {
		t.Fatalf("chunk %d bytes, %v", len(chunk.Data), err)
	}
}

// A socket that closes or fails without a stop frame still delivers the
// audio batched under the 100 ms threshold, ahead of the end of the call.
func TestCloseWithoutStopFlushesBufferedMulaw(t *testing.T) {
	for _, end := range []item{{eof: true}, {err: errors.New("connection reset")}} {
		a := connected(t, makeAdapter(t, newSpyREST(), withoutGate()))
		payload := bytes.Repeat([]byte{0xff}, 400) // 50 ms: under the 100 ms batch
		c := newConn(`{"event":"start","start":{"streamSid":"MZeof","callSid":"CAeof"}}`, mediaFrame("MZeof", payload))
		c.queue = append(c.queue, end)
		_ = await(t, drive(t, a, c, false))
		chunk, err := a.ReceiveAudio(context.Background(), 500*time.Millisecond)
		if err != nil || len(chunk.Data) == 0 {
			t.Fatalf("%+v: chunk %d bytes, %v", end, len(chunk.Data), err)
		}
	}
}

// aLegTwiML is the exact a-leg origination TwiML for a nonce.
func aLegTwiML(nonce string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.test/twilio/` + nonce + `">` +
		`<Parameter name="nonce" value="` + nonce + `"/></Stream></Connect></Response>`
}

func placeALeg(a *Adapter, extra ...func(*CallOptions)) func() error {
	return func() error {
		o := CallOptions{To: aLegDestination, Attach: AttachALeg}
		for _, f := range extra {
			f(&o)
		}
		return a.PlaceCall(context.Background(), o)
	}
}

func placeBLeg(a *Adapter, extra ...func(*CallOptions)) func() error {
	return func() error {
		o := CallOptions{To: "+14155557777"}
		for _, f := range extra {
			f(&o)
		}
		return a.PlaceCall(context.Background(), o)
	}
}

func TestALegOriginatesConnectStreamTouchingNothingOnTheCallee(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	base := rest.logLen()
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	p := rest.places()
	nonce := state(a, func(a *Adapter) string { return a.streamNonce })
	if len(p) != 1 || !strings.Contains(p[0].TwiML, `<Connect><Stream url="wss://`) || !strings.Contains(p[0].TwiML, "/twilio/"+nonce) {
		t.Fatalf("TwiML %+v", p)
	}
	if got := rest.logSince(base); len(got) != 0 {
		t.Fatalf("callee REST traffic %v", got)
	}
	if p[0].TwiML != aLegTwiML(nonce) {
		t.Fatalf("TwiML %s, want %s", p[0].TwiML, aLegTwiML(nonce))
	}
	if len(nonce) != StreamNonceHexLen {
		t.Fatalf("minted nonce %q", nonce)
	}
}

func TestALegHonoursACallerSuppliedNonce(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	const injected = "caller-supplied-nonce-0123456789abcdef"
	if err := dialAndConnect(t, a, placeALeg(a, func(o *CallOptions) { o.StreamNonce = injected })); err != nil {
		t.Fatal(err)
	}
	if n := state(a, func(a *Adapter) string { return a.streamNonce }); n != injected {
		t.Fatalf("nonce %q", n)
	}
	if got := rest.places()[0].TwiML; got != aLegTwiML(injected) {
		t.Fatalf("TwiML %s", got)
	}
}

func TestBLegResolveErrorSurfacesWithNoALegFallback(t *testing.T) {
	for _, resolveErr := range []error{errors.New("HTTP 404: phone number not found"), errors.New("HTTP 500: Twilio internal error")} {
		rest := newSpyREST()
		a := connected(t, makeAdapter(t, rest))
		rest.resolveErr = resolveErr
		err := a.PlaceCall(context.Background(), CallOptions{To: "+14155557777"})
		if err == nil || !strings.Contains(err.Error(), "HTTP") {
			t.Fatalf("err %v", err)
		}
		if len(rest.places()) != 0 {
			t.Fatal("originated after a resolve failure")
		}
	}
}

func calleeState(a *Adapter) [2]string {
	return state(a, func(a *Adapter) [2]string { return [2]string{a.calleeSID, a.priorCallee} })
}

func TestALegDisconnectIsANoOpOnTheCallee(t *testing.T) {
	rest := newSpyREST()
	a := makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	base := rest.logLen()
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	if calleeState(a) != [2]string{} {
		t.Fatal("a-leg set callee state")
	}
	_ = a.Disconnect(context.Background())
	if got := rest.logSince(base); len(got) != 0 || calleeState(a) != [2]string{} {
		t.Fatalf("callee REST %v", got)
	}

	// The same after a stream-connect timeout.
	rest = newSpyREST()
	a = makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	base = rest.logLen()
	if err := placeALeg(a, func(o *CallOptions) { o.Timeout = 20 * time.Millisecond })(); err == nil {
		t.Fatal("a stream that never connects must time out")
	}
	_ = a.Disconnect(context.Background())
	if got := rest.logSince(base); len(got) != 0 || calleeState(a) != [2]string{} {
		t.Fatalf("callee REST %v", got)
	}
}

func TestBLegGoldenTwiMLAndRESTSequence(t *testing.T) {
	rest := newSpyREST()
	rest.priorVoiceURL = "https://old-webhook.example.com/previous"
	a := makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	base := rest.logLen()
	if err := dialAndConnect(t, a, placeBLeg(a)); err != nil {
		t.Fatal(err)
	}
	_ = a.Disconnect(context.Background())
	want := `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Thank you for calling. ` +
		`I will hold the line while you complete your scenario.</Say><Pause length="120"/></Response>`
	if got := rest.places()[0].TwiML; got != want {
		t.Fatalf("b-leg TwiML changed:\n%s", got)
	}
	golden := []restCall{
		{"resolvePhoneNumberSid", []string{"+14155557777"}},
		{"readVoiceUrl", []string{phoneSID}},
		{"writeVoiceUrl", []string{phoneSID, "https://example.test/twilio/voice"}},
		{"writeVoiceUrl", []string{phoneSID, "https://old-webhook.example.com/previous"}},
	}
	if got := rest.logSince(base); !reflect.DeepEqual(got, golden) {
		t.Fatalf("callee REST sequence\n got %v\nwant %v", got, golden)
	}
	if rest.places()[0].TimeLimitSeconds != 0 {
		t.Fatal("b-leg origination carries a TimeLimit; the cap is a-leg-only")
	}
}

func TestRecordIsThreadedAndCallSIDReflectsTheCall(t *testing.T) {
	rest := newSpyREST()
	rest.placeCall = func(PlaceCallParams) (string, error) { return "CAtest", nil }
	a := connected(t, makeAdapter(t, rest))
	if a.CallSID() != "" {
		t.Fatal("call SID before any call")
	}
	if err := dialAndConnect(t, a, placeBLeg(a, func(o *CallOptions) { o.Record = true })); err != nil {
		t.Fatal(err)
	}
	if !rest.places()[0].Record || a.CallSID() != "CAtest" {
		t.Fatalf("record %v sid %q", rest.places()[0].Record, a.CallSID())
	}

	rest = newSpyREST()
	a = connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeBLeg(a)); err != nil {
		t.Fatal(err)
	}
	if rest.places()[0].Record {
		t.Fatal("record requested without being asked")
	}
}

func TestTheDirectionIsFixedPerConnection(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeBLeg(a)); err != nil {
		t.Fatal(err)
	}
	err := a.WaitForCall(context.Background(), 10*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "already in 'call' mode") {
		t.Fatalf("err %v", err)
	}
}

func TestOperationsBeforeConnect(t *testing.T) {
	a := makeAdapter(t, newSpyREST())
	if err := a.PlaceCall(context.Background(), CallOptions{To: "+14155557777"}); err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("PlaceCall: %v", err)
	}
	if _, err := a.ReceiveAudio(context.Background(), time.Millisecond); err == nil {
		t.Fatal("ReceiveAudio before connect")
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 2)}); err == nil {
		t.Fatal("SendAudio before connect")
	}
	if _, err := a.LocalBaseURL(); err == nil {
		t.Fatal("LocalBaseURL before connect")
	}
	if _, err := New(Options{PhoneNumber: "4155551234"}); err == nil {
		t.Fatal("New accepted a non-E.164 number")
	}
	b, _ := New(Options{PhoneNumber: "+14155551234", REST: newSpyREST()})
	if err := b.Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "publicBaseUrl is required") {
		t.Fatalf("connect without a public URL: %v", err)
	}
}
