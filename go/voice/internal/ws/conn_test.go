package ws

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// The protocol cases below follow the Autobahn TestSuite sections that
// apply without extensions: framing (1.x), pings and pongs (2.x), reserved
// bits (3.x), opcodes (4.x), fragmentation (5.x), limits (9.x, as a read
// limit) and close handling (7.x).

func readOK(t *testing.T, c *Conn) (MessageType, []byte) {
	t.Helper()
	typ, msg, err := c.Read(context.Background(), nil)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return typ, msg
}

func wantProtocolError(t *testing.T, c *Conn, code StatusCode) {
	t.Helper()
	_, _, err := c.Read(context.Background(), nil)
	var pe *ProtocolError
	if !errors.As(err, &pe) || pe.Code != code {
		t.Fatalf("read err = %v, want a protocol error with code %d", err, code)
	}
	// The error is sticky.
	if _, _, err2 := c.Read(context.Background(), nil); !errors.Is(err2, err) {
		t.Fatalf("second read err = %v, want %v", err2, err)
	}
}

func TestEchoSizes(t *testing.T) {
	client, server := connPair(t)
	client.SetReadLimit(-1)
	server.SetReadLimit(-1)
	ctx := context.Background()
	for _, n := range []int{0, 1, 125, 126, 127, 0xFFFF, 0x10000, writeChunk - 1, writeChunk, writeChunk + 1, 3*writeChunk + 7, 1 << 20} {
		for _, typ := range []MessageType{MessageText, MessageBinary} {
			msg := bytes.Repeat([]byte{'x', 'y', 'z'}, n/3+1)[:n]
			errc := make(chan error, 1)
			go func() { errc <- client.Write(ctx, typ, msg) }()
			gotTyp, got, err := server.Read(ctx, nil)
			if err != nil || <-errc != nil {
				t.Fatalf("n %d: %v", n, err)
			}
			if gotTyp != typ || !bytes.Equal(got, msg) {
				t.Fatalf("n %d: server got type %d, %d bytes", n, gotTyp, len(got))
			}
			go func() { errc <- server.Write(ctx, typ, msg) }()
			gotTyp, got, err = client.Read(ctx, got[:0])
			if err != nil || <-errc != nil {
				t.Fatalf("n %d back: %v", n, err)
			}
			if gotTyp != typ || !bytes.Equal(got, msg) {
				t.Fatalf("n %d: client got type %d, %d bytes", n, gotTyp, len(got))
			}
		}
	}
}

func TestWriteDoesNotModifyThePayload(t *testing.T) {
	client, server := connPair(t)
	msg := []byte("do not mask me in place")
	orig := bytes.Clone(msg)
	if err := client.Write(context.Background(), MessageText, msg); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(msg, orig) {
		t.Fatal("client Write masked the caller's buffer")
	}
	if _, got := readOK(t, server); !bytes.Equal(got, orig) {
		t.Fatalf("got %q", got)
	}
}

func TestReadAppendsToDst(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opText, []byte("world"))
	_, got, err := c.Read(context.Background(), []byte("hello "))
	if err != nil || string(got) != "hello world" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestClientFramesAreMaskedWithFreshKeys(t *testing.T) {
	c, p := clientUnderTest(t)
	keys := map[uint32]bool{}
	for range 100 {
		if err := c.Write(context.Background(), MessageBinary, []byte("k")); err != nil {
			t.Fatal(err)
		}
		_ = p.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
		h, err := readHeader(p.br)
		if err != nil || !h.masked {
			t.Fatalf("h = %+v, %v", h, err)
		}
		b := make([]byte, h.length)
		_, _ = p.br.Read(b)
		keys[h.key] = true
	}
	if len(keys) < 90 {
		t.Fatalf("only %d distinct mask keys in 100 frames", len(keys))
	}
}

// -- fragmentation (Autobahn 5.x)

func TestFragmentedMessageIsReassembled(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(false, opText, []byte("Hel"))
	p.frame(false, opContinuation, []byte("lo, "))
	p.frame(false, opContinuation, nil)
	p.frame(true, opContinuation, []byte("world"))
	typ, msg := readOK(t, c)
	if typ != MessageText || string(msg) != "Hello, world" {
		t.Fatalf("got %d %q", typ, msg)
	}
}

func TestControlFramesBetweenFragments(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(false, opBinary, []byte("ab"))
	p.frame(true, opPing, []byte("p1"))
	p.frame(false, opContinuation, []byte("cd"))
	p.frame(true, opPong, []byte("unsolicited"))
	p.frame(true, opPing, nil)
	p.frame(true, opContinuation, []byte("ef"))
	typ, msg := readOK(t, c)
	if typ != MessageBinary || string(msg) != "abcdef" {
		t.Fatalf("got %d %q", typ, msg)
	}
	for _, want := range []string{"p1", ""} {
		h, b := p.recv()
		if h.op != opPong || string(b) != want {
			t.Fatalf("got opcode %x %q, want pong %q", h.op, b, want)
		}
	}
}

func TestPingIsAnsweredWithItsPayload(t *testing.T) {
	c, p := clientUnderTest(t)
	payload := bytes.Repeat([]byte{0xFE}, maxControlPayload)
	p.frame(true, opPing, payload)
	p.frame(true, opText, []byte("after"))
	if _, msg := readOK(t, c); string(msg) != "after" {
		t.Fatalf("got %q", msg)
	}
	h, b := p.recv()
	if h.op != opPong || !bytes.Equal(b, payload) {
		t.Fatalf("got opcode %x, %d bytes", h.op, len(b))
	}
}

func TestContinuationWithoutAMessageIsAProtocolError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opContinuation, []byte("orphan"))
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
	p.expectEOF()
}

func TestDataFrameInsideAFragmentedMessageIsAProtocolError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(false, opText, []byte("first"))
	p.frame(true, opText, []byte("second"))
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

func TestFragmentedControlFrameIsAProtocolError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(false, opPing, []byte("x"))
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

func TestOversizeControlFrameIsAProtocolError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opPing, make([]byte, maxControlPayload+1))
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

// -- reserved bits and opcodes (Autobahn 3.x, 4.x)

func TestReservedBitsAreAProtocolError(t *testing.T) {
	for _, rsv := range []byte{0x40, 0x20, 0x10, 0x70} {
		c, p := serverUnderTest(t)
		p.frameWith(true, rsv, opText, []byte("x"), true)
		wantProtocolError(t, c, StatusProtocolError)
		p.expectClose(StatusProtocolError)
	}
}

func TestReservedOpcodesAreAProtocolError(t *testing.T) {
	for _, op := range []opcode{0x3, 0x4, 0x5, 0x6, 0x7, 0xB, 0xC, 0xD, 0xE, 0xF} {
		c, p := serverUnderTest(t)
		p.frame(true, op, nil)
		wantProtocolError(t, c, StatusProtocolError)
		p.expectClose(StatusProtocolError)
	}
}

// -- masking (RFC 6455 5.1)

func TestServerRejectsUnmaskedFrames(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frameWith(true, 0, opText, []byte("plain"), false)
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

func TestClientRejectsMaskedFrames(t *testing.T) {
	c, p := clientUnderTest(t)
	p.frameWith(true, 0, opText, []byte("masked"), true)
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

// -- limits

func TestMessageOverTheReadLimit(t *testing.T) {
	c, p := serverUnderTest(t)
	c.SetReadLimit(10)
	p.frame(true, opText, []byte("0123456789"))
	if _, msg := readOK(t, c); len(msg) != 10 {
		t.Fatalf("got %d bytes", len(msg))
	}
	p.frame(true, opText, []byte("0123456789A"))
	wantProtocolError(t, c, StatusMessageTooBig)
	p.expectClose(StatusMessageTooBig)
}

func TestFragmentedMessageOverTheReadLimit(t *testing.T) {
	c, p := serverUnderTest(t)
	c.SetReadLimit(10)
	p.frame(false, opBinary, []byte("012345"))
	p.frame(true, opContinuation, []byte("6789A"))
	wantProtocolError(t, c, StatusMessageTooBig)
	p.expectClose(StatusMessageTooBig)
}

func TestDefaultReadLimit(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opBinary, make([]byte, DefaultReadLimit))
	if _, msg := readOK(t, c); len(msg) != DefaultReadLimit {
		t.Fatalf("got %d bytes", len(msg))
	}
	p.frame(true, opBinary, make([]byte, DefaultReadLimit+1))
	wantProtocolError(t, c, StatusMessageTooBig)
}

// -- close handling (Autobahn 7.x)

func TestPeerCloseIsEchoedAndReported(t *testing.T) {
	c, p := serverUnderTest(t)
	p.closeFrame(1000, "bye")
	_, _, err := c.Read(context.Background(), nil)
	var ce CloseError
	if !errors.As(err, &ce) || ce.Code != StatusNormalClosure || ce.Reason != "bye" {
		t.Fatalf("err = %v", err)
	}
	if CloseStatus(err) != StatusNormalClosure {
		t.Fatalf("CloseStatus = %d", CloseStatus(err))
	}
	p.expectClose(StatusNormalClosure)
	p.expectEOF()
	if _, _, err2 := c.Read(context.Background(), nil); !errors.Is(err2, err) {
		t.Fatalf("second read: %v", err2)
	}
	if err := c.Write(context.Background(), MessageText, []byte("late")); err == nil {
		t.Fatal("write after the peer's close succeeded")
	}
}

func TestEmptyCloseIsNoStatus(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opClose, nil)
	if _, _, err := c.Read(context.Background(), nil); CloseStatus(err) != StatusNoStatusRcvd {
		t.Fatalf("err = %v", err)
	}
	p.expectClose(StatusNoStatusRcvd)
}

func TestApplicationCloseCodesAreAccepted(t *testing.T) {
	for _, code := range []int{1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4999} {
		c, p := serverUnderTest(t)
		p.closeFrame(code, "")
		if _, _, err := c.Read(context.Background(), nil); CloseStatus(err) != StatusCode(code) {
			t.Fatalf("code %d: err = %v", code, err)
		}
		p.expectClose(StatusCode(code))
	}
}

func TestInvalidCloseCodesAreAProtocolError(t *testing.T) {
	for _, code := range []int{0, 999, 1004, 1005, 1006, 1015, 1016, 1100, 2000, 2999, 5000, 65535} {
		c, p := serverUnderTest(t)
		p.closeFrame(code, "")
		wantProtocolError(t, c, StatusProtocolError)
		p.expectClose(StatusProtocolError)
	}
}

func TestOneByteCloseIsAProtocolError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(true, opClose, []byte{0x03})
	wantProtocolError(t, c, StatusProtocolError)
	p.expectClose(StatusProtocolError)
}

func TestCloseReasonMustBeUTF8(t *testing.T) {
	c, p := serverUnderTest(t)
	p.closeFrame(1000, "\xce\xba\xe1\xbd\xb9\xcf\x83\xce\xbc\xce\xb5\xed\xa0\x80")
	wantProtocolError(t, c, StatusInvalidFramePayloadData)
	p.expectClose(StatusInvalidFramePayloadData)
}

func TestCloseHandshakeWithAConcurrentReader(t *testing.T) {
	client, server := connPair(t)
	serverErr := make(chan error, 1)
	go func() {
		_, _, err := server.Read(context.Background(), nil)
		serverErr <- err
	}()
	clientErr := make(chan error, 1)
	go func() {
		_, _, err := client.Read(context.Background(), nil)
		clientErr <- err
	}()
	start := time.Now()
	if err := client.Close(StatusNormalClosure, "done"); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("Close waited for its timeout instead of the peer's close")
	}
	var ce CloseError
	if err := <-serverErr; !errors.As(err, &ce) || ce.Code != StatusNormalClosure || ce.Reason != "done" {
		t.Fatalf("server read: %v", err)
	}
	if err := <-clientErr; CloseStatus(err) != StatusNormalClosure {
		t.Fatalf("client read: %v", err)
	}
	if err := client.Close(StatusNormalClosure, ""); !errors.Is(err, ErrClosed) {
		t.Fatalf("second Close: %v", err)
	}
}

func TestCloseHandshakeWithoutAReader(t *testing.T) {
	client, server := connPair(t)
	go func() { _, _, _ = server.Read(context.Background(), nil) }()
	start := time.Now()
	if err := client.Close(StatusGoingAway, ""); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("Close did not read the peer's close itself")
	}
	if _, _, err := client.Read(context.Background(), nil); CloseStatus(err) != StatusGoingAway {
		t.Fatalf("read after Close: %v", err)
	}
}

func TestCloseDiscardsDataStillInFlight(t *testing.T) {
	c, p := serverUnderTest(t)
	done := make(chan error, 1)
	go func() { done <- c.Close(StatusNormalClosure, "") }()
	p.expectClose(StatusNormalClosure)
	p.frame(true, opText, []byte("late data"))
	p.closeFrame(1000, "")
	if err := <-done; err != nil {
		t.Fatalf("Close: %v", err)
	}
	p.expectEOF()
}

func TestCloseNow(t *testing.T) {
	c, p := serverUnderTest(t)
	if err := c.CloseNow(); err != nil {
		t.Fatal(err)
	}
	p.expectEOF()
	if _, _, err := c.Read(context.Background(), nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("read after CloseNow: %v", err)
	}
	if err := c.Write(context.Background(), MessageText, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after CloseNow: %v", err)
	}
	if err := c.CloseNow(); !errors.Is(err, ErrClosed) {
		t.Fatalf("second CloseNow: %v", err)
	}
}

func TestPeerDropIsNotACloseError(t *testing.T) {
	c, p := serverUnderTest(t)
	p.frame(false, opText, []byte("half"))
	_ = p.nc.Close()
	_, _, err := c.Read(context.Background(), nil)
	if err == nil || CloseStatus(err) != -1 {
		t.Fatalf("err = %v, want a transport error", err)
	}
}

// -- contexts and deadlines

func TestReadCancelledMidWaitClosesTheConnection(t *testing.T) {
	c, p := serverUnderTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if _, _, err := c.Read(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	p.expectEOF()
	if _, _, err := c.Read(context.Background(), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("sticky err = %v", err)
	}
}

func TestReadDeadlineFromTheContext(t *testing.T) {
	c, _ := serverUnderTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := c.Read(ctx, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func TestAlreadyCancelledContextLeavesTheConnectionOpen(t *testing.T) {
	c, p := serverUnderTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := c.Read(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	p.frame(true, opText, []byte("still here"))
	if _, msg := readOK(t, c); string(msg) != "still here" {
		t.Fatalf("got %q", msg)
	}
}

func TestContextCancelledBetweenReadsIsHarmless(t *testing.T) {
	c, p := serverUnderTest(t)
	for range 3 {
		ctx, cancel := context.WithCancel(context.Background())
		p.frame(true, opText, []byte("x"))
		if _, _, err := c.Read(ctx, nil); err != nil {
			t.Fatal(err)
		}
		cancel() // after the read: must not poison the next one
	}
	p.frame(true, opText, []byte("y"))
	if _, msg := readOK(t, c); string(msg) != "y" {
		t.Fatalf("got %q", msg)
	}
}

func TestDeadlineIsLiftedForALaterContextWithout(t *testing.T) {
	c, p := serverUnderTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	p.frame(true, opText, []byte("x"))
	if _, _, err := c.Read(ctx, nil); err != nil {
		t.Fatal(err)
	}
	cancel()
	time.AfterFunc(200*time.Millisecond, func() { p.frame(true, opText, []byte("late")) })
	if _, msg := readOK(t, c); string(msg) != "late" {
		t.Fatalf("got %q", msg)
	}
}

func TestWriteBlockedPastItsDeadline(t *testing.T) {
	c, _ := clientUnderTest(t) // the peer never reads
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	big := make([]byte, 64<<20)
	if err := c.Write(ctx, MessageBinary, big); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if err := c.Write(context.Background(), MessageBinary, []byte("x")); err == nil {
		t.Fatal("write after a failed write succeeded")
	}
}

func TestWriteCancelledWhileBlocked(t *testing.T) {
	c, _ := clientUnderTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if err := c.Write(ctx, MessageBinary, make([]byte, 64<<20)); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestConcurrentWritersDoNotInterleave(t *testing.T) {
	client, server := connPair(t)
	server.SetReadLimit(-1)
	const writers, each = 8, 50
	var wg sync.WaitGroup
	for w := range writers {
		wg.Go(func() {
			msg := bytes.Repeat([]byte{byte('a' + w)}, 40000)
			for range each {
				if err := client.Write(context.Background(), MessageBinary, msg); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	var buf []byte
	for range writers * each {
		var err error
		_, buf, err = server.Read(context.Background(), buf[:0])
		if err != nil {
			t.Fatal(err)
		}
		if len(buf) != 40000 || bytes.Count(buf, buf[:1]) != len(buf) {
			t.Fatal("interleaved message")
		}
	}
	wg.Wait()
}

// -- allocations

func TestSteadyStateRoundTripAllocatesNothing(t *testing.T) {
	client, server := connPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	msg := bytes.Repeat([]byte("a"), 1400) // one base64 20 ms frame, roughly
	var sbuf, cbuf []byte
	roundTrip := func() {
		if err := client.Write(ctx, MessageText, msg); err != nil {
			t.Fatal(err)
		}
		var err error
		if _, sbuf, err = server.Read(ctx, sbuf[:0]); err != nil {
			t.Fatal(err)
		}
		if err := server.Write(ctx, MessageText, sbuf); err != nil {
			t.Fatal(err)
		}
		if _, cbuf, err = client.Read(ctx, cbuf[:0]); err != nil {
			t.Fatal(err)
		}
	}
	roundTrip() // grow the buffers, register the context once
	if n := testing.AllocsPerRun(200, roundTrip); n != 0 {
		t.Fatalf("round trip allocates %v times", n)
	}
}

func TestValueContextsShareTheRegistration(t *testing.T) {
	client, server := connPair(t)
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	type key struct{}
	ctxs := []context.Context{base, context.WithValue(base, key{}, 1), context.WithValue(base, key{}, 2)}
	// The message is built once: a []byte("v") per call would itself be
	// the allocation counted, since Write's argument escapes.
	msg, buf := []byte("v"), []byte(nil)
	write := func() {
		for _, ctx := range ctxs {
			if err := client.Write(ctx, MessageText, msg); err != nil {
				t.Fatal(err)
			}
			var err error
			if _, buf, err = server.Read(ctx, buf[:0]); err != nil {
				t.Fatal(err)
			}
		}
	}
	write()
	if n := testing.AllocsPerRun(50, write); n != 0 {
		t.Fatalf("value contexts allocate %v times", n)
	}
}
