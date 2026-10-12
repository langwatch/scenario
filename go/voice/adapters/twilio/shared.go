package twilio

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/langwatch/scenario/go/voice/tunnel"
)

var (
	e164RE = regexp.MustCompile(`^\+[1-9]\d{6,14}$`)
	// DTMF tones: digits, star, pound and the one-second waits w/W. The
	// tones are embedded in TwiML, so nothing else is allowed.
	dtmfRE = regexp.MustCompile(`^[0-9*#wW]+$`)
)

// ValidateE164 fails unless phoneNumber is E.164 ("+" then 7-15 digits).
// The message redacts the number: a mistyped external destination must not
// reach logs in full.
func ValidateE164(phoneNumber string) error {
	if !e164RE.MatchString(phoneNumber) {
		return fmt.Errorf("phone_number %s is not in E.164 format "+
			"(expected e.g. '+14155551234', pattern: leading '+' then 7–15 digits).", RedactE164(phoneNumber))
	}
	return nil
}

// NormalizeE164 validates a phone number and returns its canonical
// comparison form. Allowlist membership is an exact lookup of this form on
// both sides, so a prefix of an allowed number never passes.
func NormalizeE164(phoneNumber string) (string, error) {
	s := strings.TrimSpace(phoneNumber)
	return s, ValidateE164(s)
}

// ValidateDTMF fails unless tones match [0-9*#wW]+. The tones are embedded
// in TwiML; anything else is rejected to prevent XML injection.
func ValidateDTMF(tones string) error {
	if !dtmfRE.MatchString(tones) {
		return fmt.Errorf("DTMF tones %s must match [0-9*#wW]+ — this string is embedded in TwiML, "+
			"non-DTMF chars are rejected to prevent XML injection.", strconv.Quote(tones))
	}
	return nil
}

// RedactE164 keeps the last four digits of a phone number for logs:
// "+14155551234" becomes "***1234"; fewer than four digits give "***".
func RedactE164(number string) string {
	digits := make([]byte, 0, len(number))
	for i := 0; i < len(number); i++ {
		if c := number[i]; c >= '0' && c <= '9' {
			digits = append(digits, c)
		}
	}
	if len(digits) >= 4 {
		return "***" + string(digits[len(digits)-4:])
	}
	return "***"
}

// StreamWSURL derives the Media Streams WebSocket URL from the public base
// URL: https becomes wss (http becomes ws), a trailing slash is dropped,
// then /twilio/<nonce> when a nonce is given, else the legacy fixed
// /twilio/stream.
//
// The nonce-in-path form lets a host platform route an incoming socket to
// the right process before the handshake completes, which it cannot do from
// the start frame's parameters.
func StreamWSURL(publicBaseURL, nonce string) string {
	base := publicBaseURL
	switch {
	case strings.HasPrefix(base, "https:"):
		base = "wss:" + base[len("https:"):]
	case strings.HasPrefix(base, "http:"):
		base = "ws:" + base[len("http:"):]
	}
	base = strings.TrimSuffix(base, "/")
	if nonce == "" {
		nonce = "stream"
	}
	return base + "/twilio/" + nonce
}

var xmlAttrEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")

// escapeXMLAttr escapes a value for an XML attribute or element text, so a
// URL never breaks out of url="…".
func escapeXMLAttr(s string) string { return xmlAttrEscaper.Replace(s) }

// Call duration and stream-connect bounds.
const (
	// MaxCallDurationCap is the hard ceiling on an a-leg call. A-leg dials
	// numbers this account does not own, so a runaway call is a runaway
	// bill; a longer request is a caller error, never a silent clamp.
	MaxCallDurationCap = 300 * time.Second
	// DefaultMaxCallDuration applies when an a-leg call names none.
	DefaultMaxCallDuration = MaxCallDurationCap
	// DefaultStreamConnectTimeout is how long PlaceCall and WaitForCall wait
	// for the media stream to connect: ring time plus the socket connect. A
	// host platform registering a stream nonce with its own listener must
	// keep that registration alive at least this long.
	DefaultStreamConnectTimeout = 120 * time.Second
)

// ResolveMaxCallDuration returns an a-leg call's maximum duration in whole
// seconds (Twilio's TimeLimit). Zero selects DefaultMaxCallDuration; a
// negative value or one above MaxCallDurationCap is an error. Sub-second
// remainders are truncated, with a floor of one second.
func ResolveMaxCallDuration(requested time.Duration) (int, error) {
	if requested == 0 {
		return int(DefaultMaxCallDuration / time.Second), nil
	}
	if requested < 0 {
		return 0, fmt.Errorf("maxCallDuration must be a positive number of seconds, got %v.", requested)
	}
	if requested > MaxCallDurationCap {
		return 0, fmt.Errorf("maxCallDuration=%v exceeds the %ds cap on a-leg calls. A-leg mode dials "+
			"numbers this account does not own; the cap bounds spend and is not per-call overridable.",
			requested, int(MaxCallDurationCap/time.Second))
	}
	return max(1, int(requested/time.Second)), nil
}

// StreamNonceBytes is the entropy of a per-call media-stream nonce: 128
// bits from the OS CSPRNG, rendered as lowercase hex (which survives
// Twilio's <Parameter> round trip unchanged).
const StreamNonceBytes = 16

// StreamNonceHexLen is the length of a minted nonce.
const StreamNonceHexLen = 2 * StreamNonceBytes

// MintStreamNonce mints a fresh per-call media-stream nonce.
func MintStreamNonce() string { return mintStreamNonce(rand.Reader) }

func mintStreamNonce(r io.Reader) string {
	var b [StreamNonceBytes]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		// crypto/rand never fails on supported platforms.
		panic("twilio: reading the OS CSPRNG: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// NonceMatches compares a received nonce with the minted one in constant
// time. An empty received nonce never matches, so omitting the <Parameter>
// is a rejection rather than a bypass.
func NonceMatches(expected, received string) bool {
	if received == "" || len(expected) != len(received) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(received)) == 1
}

// VerifySignature checks an X-Twilio-Signature header: the base64
// HMAC-SHA1, keyed by the auth token, of the URL followed by every
// parameter's name and value in name order. Any failure is a rejection.
func VerifySignature(authToken, url string, params map[string]string, signature string) bool {
	if signature == "" {
		return false
	}
	received, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	return hmac.Equal(sign(authToken, url, params), received)
}

// sign computes Twilio's request signature.
func sign(authToken, url string, params map[string]string) []byte {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	mac := hmac.New(sha1.New, []byte(authToken))
	io.WriteString(mac, url)
	for _, k := range keys {
		io.WriteString(mac, k)
		io.WriteString(mac, params[k])
	}
	return mac.Sum(nil)
}

// TunnelReadiness tells whether the public base URL is reachable from the
// edge. A-leg origination consults it before dialing. tunnel.Readiness
// implementations (the cloudflared tunnel) satisfy it.
type TunnelReadiness = tunnel.Readiness

// TunnelNotReadyError reports a public base URL not reachable from the edge
// yet: the call is refused before it is originated, rather than billed and
// left to die in a stream-connect timeout.
type TunnelNotReadyError = tunnel.NotReadyError
