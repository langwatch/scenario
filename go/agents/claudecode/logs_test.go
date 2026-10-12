package claudecode

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
)

// logRecorder is a slog handler that keeps every record as
// "LEVEL message key=value…".
type logRecorder struct {
	mu      sync.Mutex
	records []string
}

func (r *logRecorder) logger() *slog.Logger { return slog.New(r) }

func (r *logRecorder) Enabled(context.Context, slog.Level) bool { return true }

func (r *logRecorder) Handle(_ context.Context, rec slog.Record) error {
	var b strings.Builder
	b.WriteString(rec.Level.String() + " " + rec.Message)
	rec.Attrs(func(a slog.Attr) bool {
		b.WriteString(" " + a.Key + "=" + a.Value.String())
		return true
	})
	r.mu.Lock()
	r.records = append(r.records, b.String())
	r.mu.Unlock()
	return nil
}

func (r *logRecorder) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *logRecorder) WithGroup(string) slog.Handler      { return r }

func (r *logRecorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.records...)
}

// has reports a record at level whose message contains msg and whose text
// contains detail.
func (r *logRecorder) has(level, msg, detail string) bool {
	for _, rec := range r.all() {
		head, _, _ := strings.Cut(rec, "=")
		if strings.HasPrefix(rec, level+" ") && strings.Contains(head, msg) && strings.Contains(rec, detail) {
			return true
		}
	}
	return false
}

// count is the number of records containing s.
func (r *logRecorder) count(s string) int {
	n := 0
	for _, rec := range r.all() {
		if strings.Contains(rec, s) {
			n++
		}
	}
	return n
}

// sameDir reports whether two paths name the same directory.
func sameDir(a, b string) bool {
	sa, errA := os.Stat(a)
	sb, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(sa, sb)
}
