package ksuid

import (
	"testing"
)

func BenchmarkGenerate(b *testing.B) {
	for b.Loop() {
		Generate(b.Context(), "user")
	}
}
