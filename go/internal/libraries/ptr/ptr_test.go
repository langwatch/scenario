package ptr

import (
	"testing"

	"github.com/matryer/is"
)

func TestPtr(t *testing.T) {
	is := is.New(t)
	t.Run("int", func(t *testing.T) {
		v := 42
		p := Ptr(v)
		is.True(p != nil)
		is.Equal(*p, v)
	})
	t.Run("string", func(t *testing.T) {
		v := "hello"
		p := Ptr(v)
		is.True(p != nil)
		is.Equal(*p, v)
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		v := S{X: 7}
		p := Ptr(v)
		is.True(p != nil)
		is.Equal(*p, v)
	})
}

func TestValueOrNil(t *testing.T) {
	is := is.New(t)
	t.Run("int", func(t *testing.T) {
		var p *int
		is.Equal(ValueOrNil(p), 0)
		v := 5
		p = &v
		is.Equal(ValueOrNil(p), v)
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		is.Equal(ValueOrNil(p), "")
		v := "foo"
		p = &v
		is.Equal(ValueOrNil(p), v)
	})
	// struct
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		is.Equal(ValueOrNil(p), S{})
		v := S{X: 9}
		p = &v
		is.Equal(ValueOrNil(p), v)
	})
}

func TestValueOrZero(t *testing.T) {
	is := is.New(t)
	t.Run("int", func(t *testing.T) {
		var p *int
		is.Equal(ValueOrZero(p), 0)
		v := 8
		p = &v
		is.Equal(ValueOrZero(p), v)
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		is.Equal(ValueOrZero(p), "")
		v := "bar"
		p = &v
		is.Equal(ValueOrZero(p), v)
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		is.Equal(ValueOrZero(p), S{})
		v := S{X: 3}
		p = &v
		is.Equal(ValueOrZero(p), v)
	})
}

func TestValueOrDefault(t *testing.T) {
	is := is.New(t)
	t.Run("int", func(t *testing.T) {
		var p *int
		is.Equal(ValueOrDefault(p, 0), 0)
		v := 11
		p = &v
		is.Equal(ValueOrDefault(p, 0), v)
	})
	t.Run("string", func(t *testing.T) {
		var p *string
		is.Equal(ValueOrDefault(p, ""), "")
		v := "baz"
		p = &v
		is.Equal(ValueOrDefault(p, ""), v)
	})
	t.Run("struct", func(t *testing.T) {
		type S struct{ X int }
		var p *S
		is.Equal(ValueOrDefault(p, S{}), S{})
		v := S{X: 4}
		p = &v
		is.Equal(ValueOrDefault(p, S{}), v)
	})
}
