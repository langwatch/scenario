package wsconn

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/ws"
)

// coderEcho is a coder/websocket echo server that closes with 4000
// "done" after its first echo when asked to.
func coderEcho(t *testing.T, closeAfter bool) string {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionContextTakeover})
		if err != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(-1)
		for {
			typ, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, msg); err != nil {
				return
			}
			if closeAfter {
				_ = c.Close(4000, "done")
				return
			}
		}
	}))
	t.Cleanup(s.Close)
	return "ws" + strings.TrimPrefix(s.URL, "http")
}

func echoOnce(t *testing.T, c Conn, msg string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
	typ, got, err := c.Read(ctx, []byte("prefix:"))
	if err != nil || typ != MessageText || string(got) != "prefix:"+msg {
		t.Fatalf("%d %q %v", typ, got, err)
	}
}

func TestDialIsNative(t *testing.T) {
	c, err := Dial(context.Background(), coderEcho(t, false), DialOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if _, ok := c.(*ws.Conn); ok == useCoder {
		t.Fatalf("Dial returned %T with useCoder=%v", c, useCoder)
	}
	echoOnce(t, c, "native")
}

func TestFromCoderReadsWholeMessagesIntoDst(t *testing.T) {
	cc, _, err := websocket.Dial(context.Background(), coderEcho(t, false), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := FromCoder(cc)
	defer c.CloseNow()
	c.SetReadLimit(-1)
	echoOnce(t, c, "small")
	echoOnce(t, c, strings.Repeat("big", 50000)) // grows dst many times
}

func TestCloseStatusFromEitherImplementation(t *testing.T) {
	url := coderEcho(t, true)
	native, err := Dial(context.Background(), url, DialOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cc, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []Conn{native, FromCoder(cc)} {
		echoOnce(t, c, "then close")
		_, _, err := c.Read(context.Background(), nil)
		if CloseStatus(err) != 4000 || !IsClosed(err) {
			t.Fatalf("%T: err = %v, CloseStatus = %d", c, err, CloseStatus(err))
		}
	}
	if CloseStatus(context.Canceled) != -1 || IsClosed(context.Canceled) {
		t.Fatal("a context error is not a close")
	}
}

func TestDialCoderOptions(t *testing.T) {
	url := coderEcho(t, false)
	plain, err := DialCoderOptions(context.Background(), url, &websocket.DialOptions{HTTPHeader: http.Header{"X-K": {"v"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.CloseNow()
	if _, ok := plain.(*ws.Conn); !ok && !useCoder {
		t.Fatalf("plain options dialled %T, want the native conn", plain)
	}
	echoOnce(t, plain, "plain")

	compressed, err := DialCoderOptions(context.Background(), url, &websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.CloseNow()
	if _, ok := compressed.(coderConn); !ok {
		t.Fatalf("compression dialled %T, want coder/websocket", compressed)
	}
	echoOnce(t, compressed, strings.Repeat("compress me ", 100))
}

func TestAcceptServesBothClients(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Accept(w, r, AcceptOptions{})
		if err != nil {
			return
		}
		defer c.CloseNow()
		var buf []byte
		for {
			typ, msg, err := c.Read(context.Background(), buf[:0])
			if err != nil {
				return
			}
			buf = msg
			if err := c.Write(context.Background(), typ, msg); err != nil {
				return
			}
		}
	}))
	defer s.Close()
	url := "ws" + strings.TrimPrefix(s.URL, "http")
	native, err := Dial(context.Background(), url, DialOptions{})
	if err != nil {
		t.Fatal(err)
	}
	echoOnce(t, native, "native client")
	if err := native.Close(StatusNormalClosure, ""); err != nil {
		t.Fatalf("native Close: %v", err)
	}
	cc, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	coder := FromCoder(cc)
	echoOnce(t, coder, "coder client")
	if err := coder.Close(StatusNormalClosure, ""); err != nil {
		t.Fatalf("coder Close: %v", err)
	}
}
