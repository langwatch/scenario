package effects

import (
	"errors"
	"math"
)

// Defaults matching the JavaScript SDK's parameter defaults.
const (
	DefaultLowQualityRate   = 8000 // LowQuality, Hz
	DefaultPacketLoss       = 0.05 // PacketLoss probability
	DefaultPacketLossWindow = 20   // PacketLoss window, ms
	DefaultEchoDelay        = 200  // Echo delay, ms
	DefaultEchoDecay        = 0.5  // Echo decay
)

// LowQuality simulates a low-bitrate codec by resampling down to rate Hz and
// back up. Rates at or above 24 kHz leave the audio unchanged.
func LowQuality(rate int) Effect {
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if n == 0 || rate >= sampleRate {
			return passthrough(dst, src)
		}
		down := max(1, int(math.Floor(float64(n)*float64(rate)/sampleRate)))
		dst, out := extend(dst, n)
		// Down then up by index gather composes into one gather, so the
		// intermediate low-rate buffer is never materialised.
		for i := range n {
			j := gatherIndex(gatherIndex(i, down, n), n, down)
			copy(out[2*i:2*i+2], src[2*j:])
		}
		return dst
	}
}

// PacketLoss silences each window of windowMs milliseconds with the given
// probability, in [0, 1].
func PacketLoss(probability float64, windowMs int, opts ...Option) (Effect, error) {
	if probability < 0 || probability > 1 {
		return nil, errors.New("effects: PacketLoss probability must be in [0, 1]")
	}
	window := max(1, int(math.Floor(float64(sampleRate*windowMs)/1000)))
	return dropWindows(window, probability, newRandom(opts)), nil
}

// BreakingUp simulates an intermittent connection: each 100 ms window is
// silenced with probability 0.2.
func BreakingUp(opts ...Option) Effect {
	return dropWindows(sampleRate*100/1000, 0.2, newRandom(opts))
}

func dropWindows(window int, probability float64, rnd *random) Effect {
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if n == 0 {
			return passthrough(dst, src)
		}
		off := len(dst)
		dst = append(dst, whole(src)...)
		out := dst[off:]
		rnd.draw(func(next func() float64) {
			for i := 0; i < n; i += window {
				if next() < probability {
					clear(out[2*i : 2*min(n, i+window)])
				}
			}
		})
		return dst
	}
}

// Echo overlays a copy of the signal delayed by delayMs and attenuated by
// decay. A delay longer than the audio leaves it unchanged.
func Echo(delayMs int, decay float64) Effect {
	delay := int(math.Floor(float64(sampleRate*delayMs) / 1000))
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if n == 0 || delay >= n {
			return passthrough(dst, src)
		}
		dst, out := extend(dst, n)
		for i := range n {
			v := at(src, i)
			if i >= delay {
				v += float64(at(src, i-delay) * decay)
			}
			put(out, i, v)
		}
		return dst
	}
}

// Robotic gives a crude vocoder sound by ring-modulating the signal with a
// 100 Hz carrier.
func Robotic() Effect {
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		dst, out := extend(dst, n)
		// (2π · 100) · t, rounded step by step as JavaScript evaluates it.
		twoPi := 2 * math.Pi
		omega := twoPi * 100
		for i := range n {
			t := float64(i) / sampleRate
			carrier := math.Sin(omega * t)
			put(out, i, at(src, i)*carrier)
		}
		return dst
	}
}
