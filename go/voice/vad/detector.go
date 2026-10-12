// Package vad detects speech in canonical PCM16 audio (24 kHz mono) without
// any native dependency: an RMS-energy detector with hysteresis for adapters
// that publish no voice-activity events of their own, and an energy gate
// that admits only speech from a continuously streaming phone line.
package vad

import "github.com/langwatch/scenario/go/voice/audio"

// Detector framing and defaults, matching the Python and JavaScript SDKs.
const (
	// FrameMs is the classification frame length.
	FrameMs = 30
	// FrameBytes is one 30 ms frame of canonical PCM16 (720 samples).
	FrameBytes = audio.SampleRate * FrameMs / 1000 * audio.SampleWidth
	// DefaultRMSThreshold is the frame RMS (int16 scale) at or above which a
	// frame is speech: about -36 dBFS, admitting normal speech while
	// rejecting most ambient noise.
	DefaultRMSThreshold = 500
	// DefaultHysteresisFrames is how many consecutive frames must agree
	// before the speaking state flips, rejecting flicker.
	DefaultHysteresisFrames = 3
)

// Options tune a [Detector]. Zero values select the defaults.
type Options struct {
	// RMSThreshold overrides [DefaultRMSThreshold].
	RMSThreshold float64
	// HysteresisFrames overrides [DefaultHysteresisFrames].
	HysteresisFrames int
	// OnSpeechStart is called when speech is detected (after hysteresis).
	OnSpeechStart func()
	// OnSpeechEnd is called when silence follows speech (after hysteresis).
	OnSpeechEnd func()
}

// Detector is an incremental voice-activity detector over canonical PCM16.
// Feed it audio with [Detector.Process]; the callbacks fire on stable
// speech/silence transitions. Classification depends only on how many bytes
// have arrived, never on how they were split into chunks.
//
// A Detector is purely sample-driven (no goroutines, no timers) and does not
// allocate while processing. It is not safe for concurrent use.
type Detector struct {
	threshold  float64
	hysteresis int
	onStart    func()
	onEnd      func()

	speaking     bool
	candidate    bool
	candidateRun int

	// carry holds the bytes of a partial frame between Process calls.
	carry    [FrameBytes]byte
	carryLen int
}

// NewDetector returns a Detector configured by opts.
func NewDetector(opts Options) *Detector {
	d := &Detector{
		threshold:  opts.RMSThreshold,
		hysteresis: opts.HysteresisFrames,
		onStart:    opts.OnSpeechStart,
		onEnd:      opts.OnSpeechEnd,
	}
	if d.threshold == 0 {
		d.threshold = DefaultRMSThreshold
	}
	if d.hysteresis == 0 {
		d.hysteresis = DefaultHysteresisFrames
	}
	return d
}

// Speaking reports whether hysteresis has settled on speech.
func (d *Detector) Speaking() bool { return d.speaking }

// Process feeds canonical PCM16 into the detector, classifying every
// complete 30 ms frame. Frames are read in place from pcm; only a trailing
// partial frame is copied, to be completed by the next call.
func (d *Detector) Process(pcm []byte) {
	if d.carryLen > 0 {
		n := copy(d.carry[d.carryLen:], pcm)
		d.carryLen += n
		pcm = pcm[n:]
		if d.carryLen < FrameBytes {
			return
		}
		d.observe(audio.RMS(d.carry[:]) >= d.threshold)
		d.carryLen = 0
	}
	for len(pcm) >= FrameBytes {
		d.observe(audio.RMS(pcm[:FrameBytes]) >= d.threshold)
		pcm = pcm[FrameBytes:]
	}
	d.carryLen = copy(d.carry[:], pcm)
}

// observe applies hysteresis: the state flips only after the candidate
// state has held for the configured number of consecutive frames.
func (d *Detector) observe(speech bool) {
	if speech == d.candidate {
		d.candidateRun++
	} else {
		d.candidate = speech
		d.candidateRun = 1
	}
	if d.candidateRun < d.hysteresis {
		return
	}
	switch {
	case d.candidate && !d.speaking:
		d.speaking = true
		if d.onStart != nil {
			d.onStart()
		}
	case !d.candidate && d.speaking:
		d.speaking = false
		if d.onEnd != nil {
			d.onEnd()
		}
	}
}
