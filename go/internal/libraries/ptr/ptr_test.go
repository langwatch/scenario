package ptr

import (
	"testing"
)

func TestPtr(t *testing.T) {
	t.Run("int", func(t *testing.T) {
		v := 42
		p := Ptr(v)
		if p == nil || *p != v {
			t.Errorf("Ptr(int) = %v, want %v", p, v)
		}
	})
	t.Run("string", func(t *testing.T) {
		v := "hello"
		p := Ptr(v)
		if p == nil || *p != v {
			t.Errorf("Ptr(string) = %v, want %v", p, v)
		}
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		v := S{X: 7}
		p := Ptr(v)
		if p == nil || *p != v {
			t.Errorf("Ptr(struct) = %v, want %v", p, v)
		}
	})
}

func TestValueOrNil(t *testing.T) {
	t.Run("int", func(t *testing.T) {
		var p *int
		if got := ValueOrNil(p); got != 0 {
			t.Errorf("ValueOrNil(nil int) = %v, want 0", got)
		}
		v := 5
		p = &v
		if got := ValueOrNil(p); got != v {
			t.Errorf("ValueOrNil(non-nil int) = %v, want %v", got, v)
		}
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		if got := ValueOrNil(p); got != "" {
			t.Errorf("ValueOrNil(nil string) = %q, want \"\"", got)
		}
		v := "foo"
		p = &v
		if got := ValueOrNil(p); got != v {
			t.Errorf("ValueOrNil(non-nil string) = %q, want %q", got, v)
		}
	})
	// struct
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		if got := ValueOrNil(p); got != (S{}) {
			t.Errorf("ValueOrNil(nil struct) = %v, want zero", got)
		}
		v := S{X: 9}
		p = &v
		if got := ValueOrNil(p); got != v {
			t.Errorf("ValueOrNil(non-nil struct) = %v, want %v", got, v)
		}
	})
}

func TestValueOrZero(t *testing.T) {
	t.Run("int", func(t *testing.T) {
		var p *int
		if got := ValueOrZero(p); got != 0 {
			t.Errorf("ValueOrZero(nil int) = %v, want 0", got)
		}
		v := 8
		p = &v
		if got := ValueOrZero(p); got != v {
			t.Errorf("ValueOrZero(non-nil int) = %v, want %v", got, v)
		}
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		if got := ValueOrZero(p); got != "" {
			t.Errorf("ValueOrZero(nil string) = %q, want \"\"", got)
		}
		v := "bar"
		p = &v
		if got := ValueOrZero(p); got != v {
			t.Errorf("ValueOrZero(non-nil string) = %q, want %q", got, v)
		}
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		if got := ValueOrZero(p); got != (S{}) {
			t.Errorf("ValueOrZero(nil struct) = %v, want zero", got)
		}
		v := S{X: 3}
		p = &v
		if got := ValueOrZero(p); got != v {
			t.Errorf("ValueOrZero(non-nil struct) = %v, want %v", got, v)
		}
	})
}

func TestValueOrDefault(t *testing.T) {
	t.Run("int", func(t *testing.T) {
		var p *int
		if got := ValueOrDefault(p); got != 0 {
			t.Errorf("ValueOrDefault(nil int) = %v, want 0", got)
		}
		v := 11
		p = &v
		if got := ValueOrDefault(p); got != v {
			t.Errorf("ValueOrDefault(non-nil int) = %v, want %v", got, v)
		}
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		if got := ValueOrDefault(p); got != "" {
			t.Errorf("ValueOrDefault(nil string) = %q, want \"\"", got)
		}
		v := "baz"
		p = &v
		if got := ValueOrDefault(p); got != v {
			t.Errorf("ValueOrDefault(non-nil string) = %q, want %q", got, v)
		}
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		if got := ValueOrDefault(p); got != (S{}) {
			t.Errorf("ValueOrDefault(nil struct) = %v, want zero", got)
		}
		v := S{X: 4}
		p = &v
		if got := ValueOrDefault(p); got != v {
			t.Errorf("ValueOrDefault(non-nil struct) = %v, want %v", got, v)
		}
	})
}
