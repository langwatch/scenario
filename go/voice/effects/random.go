package effects

import (
	"math/rand/v2"
	"sync"
)

// Option configures the random source of the stochastic effects ([Static],
// [PacketLoss], [BreakingUp]).
type Option func(*random)

// WithSeed makes an effect deterministic: the same seed gives the same
// sequence of drops and noise on every run. The JavaScript SDK draws from
// Math.random and has no seeding, so seeded output is Go-only.
func WithSeed(seed uint64) Option {
	return func(r *random) { r.src = rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)) }
}

// WithRand draws from src. The effect serializes its own calls to src.
func WithRand(src *rand.Rand) Option {
	return func(r *random) { r.src = src }
}

// random is an effect's random source. Without options it uses the
// goroutine-safe global generator; a seeded source is guarded by mu for the
// length of one effect application.
type random struct {
	mu  sync.Mutex
	src *rand.Rand
}

func newRandom(opts []Option) *random {
	r := &random{}
	for _, o := range opts {
		o(r)
	}
	return r
}

// draw runs fn with a uniform [0, 1) generator, holding the lock if the
// source is not the global one.
func (r *random) draw(fn func(next func() float64)) {
	if r.src == nil {
		fn(rand.Float64)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	fn(r.src.Float64)
}
