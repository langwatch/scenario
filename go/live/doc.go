// Package live is the cross-module live test suite of the Go SDK: the
// LangWatch round trip (scenario events, traces, remote trace fetching) and
// the voice scenarios that need both a voice transport and an LLM judge.
//
// Every test is behind the integration build tag and skips, naming the
// missing environment variable, without its credentials:
//
//	go test -tags integration -run Live -count=1 -p 1 ./...
//
// It is its own module so the core, the providers and the voice module stay
// free of each other's dependencies.
package live
