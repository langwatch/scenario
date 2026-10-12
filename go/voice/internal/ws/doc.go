// Package ws is a small RFC 6455 WebSocket implementation for the voice
// adapters' hot paths: one 20 ms audio frame in each direction, fifty times
// a second, per call.
//
// It covers what the adapters need and nothing more: client dial (through
// an *http.Client, so TLS, custom transports and the HTTP proxy from the
// environment behave as with any HTTP request), server accept on an
// http.ResponseWriter or a raw net.Conn, text and binary messages,
// fragmentation reassembly, ping/pong, the close handshake with status
// codes, client masking and a maximum message size. permessage-deflate is
// not implemented: none of the servers the adapters talk to requires it,
// and the dial never offers it.
//
// The steady state allocates nothing. Messages are read with an
// append-style [Conn.Read] into a buffer the caller reuses, and written from
// one per-connection buffer. Contexts map onto net.Conn deadlines: a
// context's deadline becomes the connection deadline, and its cancellation
// is watched by one context.AfterFunc registered when a new context (a new
// Done channel) is first seen, then reused while the caller keeps passing
// the same one (or a value context derived from it). A cancellation during
// an operation sets a past deadline, which fails the blocked read or write;
// as with github.com/coder/websocket, a context that ends mid-operation
// closes the connection, since a half-read or half-written frame cannot be
// resumed.
//
// Text messages are not checked for valid UTF-8 (close reasons are), as in
// github.com/coder/websocket: the adapters parse every message as JSON
// anyway.
package ws
