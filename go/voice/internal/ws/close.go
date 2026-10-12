package ws

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"
)

// StatusCode is a close status code (RFC 6455 7.4). The values match
// github.com/coder/websocket's.
type StatusCode int

// Close status codes.
const (
	StatusNormalClosure           StatusCode = 1000
	StatusGoingAway               StatusCode = 1001
	StatusProtocolError           StatusCode = 1002
	StatusUnsupportedData         StatusCode = 1003
	statusReserved                StatusCode = 1004
	StatusNoStatusRcvd            StatusCode = 1005
	StatusAbnormalClosure         StatusCode = 1006
	StatusInvalidFramePayloadData StatusCode = 1007
	StatusPolicyViolation         StatusCode = 1008
	StatusMessageTooBig           StatusCode = 1009
	StatusMandatoryExtension      StatusCode = 1010
	StatusInternalError           StatusCode = 1011
	StatusServiceRestart          StatusCode = 1012
	StatusTryAgainLater           StatusCode = 1013
	StatusBadGateway              StatusCode = 1014
	StatusTLSHandshake            StatusCode = 1015
)

// CloseError is the close frame the peer sent. Reads after it return the
// same error.
type CloseError struct {
	Code   StatusCode
	Reason string
}

func (e CloseError) Error() string {
	return fmt.Sprintf("websocket closed: status = %d and reason = %q", int(e.Code), e.Reason)
}

// CloseStatus returns the code of the CloseError in err's chain, or -1.
func CloseStatus(err error) StatusCode {
	var ce CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return -1
}

// ErrClosed is returned by operations on a connection this side closed.
var ErrClosed = errors.New("websocket: connection closed")

// ProtocolError is a violation of RFC 6455 by the peer. The connection is
// closed with Code after it.
type ProtocolError struct {
	Code StatusCode
	Msg  string
}

func (e *ProtocolError) Error() string { return "websocket: protocol error: " + e.Msg }

func protocolError(msg string) error { return &ProtocolError{Code: StatusProtocolError, Msg: msg} }

// validWireCode reports whether code may appear in a close frame. 1004,
// 1005, 1006 and 1015 are reserved for local use; 1016-2999 are reserved
// for the protocol; 3000-4999 belong to applications.
func validWireCode(code StatusCode) bool {
	switch code {
	case statusReserved, StatusNoStatusRcvd, StatusAbnormalClosure, StatusTLSHandshake:
		return false
	}
	return (code >= StatusNormalClosure && code <= StatusBadGateway) || (code >= 3000 && code <= 4999)
}

// parseClose decodes a close frame payload. An empty payload is
// StatusNoStatusRcvd.
func parseClose(p []byte) (CloseError, error) {
	switch len(p) {
	case 0:
		return CloseError{Code: StatusNoStatusRcvd}, nil
	case 1:
		return CloseError{}, protocolError("close payload of one byte")
	}
	code := StatusCode(binary.BigEndian.Uint16(p))
	if !validWireCode(code) {
		return CloseError{}, protocolError(fmt.Sprintf("invalid close status code %d", int(code)))
	}
	reason := p[2:]
	if !utf8.Valid(reason) {
		return CloseError{}, &ProtocolError{Code: StatusInvalidFramePayloadData, Msg: "close reason is not valid UTF-8"}
	}
	return CloseError{Code: code, Reason: string(reason)}, nil
}

// appendClose appends a close payload. StatusNoStatusRcvd is the empty
// payload; a code that may not go on the wire becomes 1011. The reason is
// cut to fit the control frame limit on a UTF-8 boundary.
func appendClose(dst []byte, code StatusCode, reason string) []byte {
	if code == StatusNoStatusRcvd {
		return dst
	}
	if !validWireCode(code) {
		code, reason = StatusInternalError, ""
	}
	const maxReason = maxControlPayload - 2
	if len(reason) > maxReason {
		cut := maxReason
		for cut > 0 && !utf8.RuneStart(reason[cut]) {
			cut--
		}
		reason = reason[:cut]
	}
	dst = binary.BigEndian.AppendUint16(dst, uint16(code))
	return append(dst, reason...)
}
