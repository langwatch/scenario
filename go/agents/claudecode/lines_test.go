package claudecode

import (
	"strings"
	"testing"
)

func TestLineWriterSplitsLinesAcrossWrites(t *testing.T) {
	var got []string
	w := lineWriter{line: func(b []byte) { got = append(got, string(b)) }}
	for _, chunk := range []string{"one\ntw", "o", "\nthree\n\nfo", "ur"} {
		w.Write([]byte(chunk))
	}
	w.flush()
	if want := []string{"one", "two", "three", "", "four"}; strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("lines = %q", got)
	}
}

func TestStderrLogsAMultibyteCharacterSplitAcrossWritesIntact(t *testing.T) {
	logs := &logRecorder{}
	s := stderrSink{logger: logs.logger()}
	payload := []byte("café\n")
	cut := strings.IndexByte(string(payload), 0xc3) + 1
	s.Write(payload[:cut])
	s.Write(payload[cut:])

	var logged strings.Builder
	for _, rec := range logs.all() {
		_, data, _ := strings.Cut(rec, "data=")
		logged.WriteString(data)
	}
	if logged.String() != "café\n" || strings.Contains(logged.String(), "�") || s.String() != "café\n" {
		t.Fatalf("logged %q, kept %q", logged.String(), s.String())
	}
}

func TestCompleteUTF8(t *testing.T) {
	for in, want := range map[string]int{
		"":                  0,
		"abc":               3,
		"caf\xc3":           3,
		"caf\xc3\xa9":       5,
		"\xf0\x9f":          0,
		"a\xf0\x9f\x98\x80": 5,
		"\xff":              1, // invalid, not incomplete: logged as is
	} {
		if got := completeUTF8([]byte(in)); got != want {
			t.Errorf("completeUTF8(%q) = %d, want %d", in, got, want)
		}
	}
}
