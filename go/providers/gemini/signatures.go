package gemini

import (
	"encoding/base64"
	"sync"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// Gemini 3 rejects a request whose current turn replays a function call
// without the thought signature the model returned with it. scenario.ToolCall
// has no field for the signature, so the Provider remembers the signatures of
// the calls it returned and puts them back when the calls are replayed.

// dummySignature is the value Google documents for function calls that have
// no signature of their own; it tells the API to skip the validation. The
// REST API carries the bytes field as base64 text, and the documented value
// is that text, so the bytes are its decoding: the SDK encodes them back to
// the same value (in the standard base64 alphabet, which the API reads too).
var dummySignature, _ = base64.URLEncoding.DecodeString("skip_thought_signature_validator")

// maxSignatures bounds the remembered signatures; the oldest go first.
const maxSignatures = 4096

// signatureCache maps a returned function call, by its id and arguments, to
// its thought signature. Ids made up from name and position repeat across
// responses, so a key seen with two different signatures is ambiguous and
// resolves to none (the dummy is used instead of a wrong signature).
type signatureCache struct {
	mu    sync.Mutex
	sigs  map[string][]byte
	order []string
}

func signatureKey(id, args string) string { return id + "\x00" + args }

func (c *signatureCache) put(id, args string, sig []byte) {
	if len(sig) == 0 {
		return
	}
	key := signatureKey(id, args)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sigs == nil {
		c.sigs = map[string][]byte{}
	}
	if old, ok := c.sigs[key]; ok {
		if old != nil && string(old) != string(sig) {
			c.sigs[key] = nil
		}
		return
	}
	if len(c.order) >= maxSignatures {
		delete(c.sigs, c.order[0])
		c.order = c.order[1:]
	}
	c.sigs[key] = sig
	c.order = append(c.order, key)
}

func (c *signatureCache) get(tc scenario.ToolCall) []byte {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sigs[signatureKey(tc.ID, tc.Arguments)]
}

// remember stores the signatures of the function calls in a candidate under
// the ids and arguments fromGeminiCandidate gives them.
func (c *signatureCache) remember(cand *genai.Candidate) {
	if cand == nil || cand.Content == nil {
		return
	}
	for i, part := range cand.Content.Parts {
		if part == nil || part.FunctionCall == nil {
			continue
		}
		c.put(callID(part.FunctionCall, i), argsJSON(part.FunctionCall.Args), part.ThoughtSignature)
	}
}

// signModelTurns gives the first function call of every model content a
// signature when it has none, since the API requires one there.
func signModelTurns(contents []*genai.Content) {
	for _, c := range contents {
		if c.Role != genai.RoleModel {
			continue
		}
		for _, part := range c.Parts {
			if part.FunctionCall == nil {
				continue
			}
			if len(part.ThoughtSignature) == 0 {
				part.ThoughtSignature = dummySignature
			}
			break
		}
	}
}
