package gemini

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// requestParts decodes the parts of every content of a generateContent body.
func requestParts(t *testing.T, body []byte) [][]map[string]any {
	t.Helper()
	var req struct {
		Contents []struct {
			Parts []map[string]any `json:"parts"`
		} `json:"contents"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatal(err)
	}
	out := make([][]map[string]any, 0, len(req.Contents))
	for _, c := range req.Contents {
		out = append(out, c.Parts)
	}
	return out
}

// Gemini 3 answers 400 when a replayed function call lacks the signature it
// came with; the Provider puts it back.
func TestReplayedFunctionCallsKeepTheirThoughtSignature(t *testing.T) {
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, b)
		w.Header().Set("Content-Type", "application/json")
		// "c2lnQQ==" is base64 of "sigA"; a parallel call carries none.
		io.WriteString(w, `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"search","args":{"q":"a"}},"thoughtSignature":"c2lnQQ=="},{"functionCall":{"name":"search","args":{"q":"b"}}}]}}]}`)
	}))
	defer srv.Close()
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{APIKey: "k", Backend: genai.BackendGeminiAPI, HTTPOptions: genai.HTTPOptions{BaseURL: srv.URL}})
	if err != nil {
		t.Fatal(err)
	}
	p := NewProvider(client)
	history := []scenario.Message{scenario.UserMsg("find a and b")}
	res, err := p.Inference(context.Background(), scenario.InferenceParams{Model: "gemini-3-test", Messages: history})
	if err != nil {
		t.Fatal(err)
	}
	history = append(history, res.Message, scenario.ToolMsg(res.Message.ToolCalls[0].ID, "A"), scenario.ToolMsg(res.Message.ToolCalls[1].ID, "B"))
	if _, err := p.Inference(context.Background(), scenario.InferenceParams{Model: "gemini-3-test", Messages: history}); err != nil {
		t.Fatal(err)
	}
	model := requestParts(t, bodies[1])[1]
	if got := model[0]["thoughtSignature"]; got != "c2lnQQ==" {
		t.Errorf("first call signature = %v, want the returned one", got)
	}
	if got, ok := model[1]["thoughtSignature"]; ok {
		t.Errorf("parallel call signature = %v, want none", got)
	}
}

// Calls with no known signature get the documented dummy on the first call
// of every model step, in the JSON form Google documents.
func TestFunctionCallsWithoutSignatureGetTheDummy(t *testing.T) {
	contents := ToGeminiContents([]scenario.Message{
		scenario.UserMsg("go"),
		{Role: scenario.RoleAssistant, Content: "checking", ToolCalls: []scenario.ToolCall{{ID: "a", Name: "f", Arguments: `{}`}, {ID: "b", Name: "f", Arguments: `{}`}}},
		scenario.ToolMsg("a", "1"),
		scenario.ToolMsg("b", "2"),
		{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "c", Name: "g", Arguments: `{}`}}},
		scenario.ToolMsg("c", "3"),
	})
	enc, err := json.Marshal(map[string]any{"contents": contents})
	if err != nil {
		t.Fatal(err)
	}
	parts := requestParts(t, enc)
	// The API reads base64 in either alphabet; this is the documented
	// "skip_thought_signature_validator" in the standard one.
	const dummy = "skip/thought/signature/validator"
	steps := [][]map[string]any{parts[1], parts[3]}
	if got := steps[0][0]["thoughtSignature"]; got != nil {
		t.Errorf("text part signature = %v, want none", got)
	}
	if got := steps[0][1]["thoughtSignature"]; got != dummy {
		t.Errorf("first call of step 1 = %v, want %s", got, dummy)
	}
	if got := steps[0][2]["thoughtSignature"]; got != nil {
		t.Errorf("parallel call of step 1 = %v, want none", got)
	}
	if got := steps[1][0]["thoughtSignature"]; got != dummy {
		t.Errorf("first call of step 2 = %v, want %s", got, dummy)
	}
}

// Made-up ids repeat across responses; a key seen with two signatures must
// not hand out either.
func TestAnAmbiguousSignatureIsNotReused(t *testing.T) {
	var c signatureCache
	c.put("f_0", "{}", []byte("one"))
	c.put("f_0", "{}", []byte("one"))
	if got := string(c.get(scenario.ToolCall{ID: "f_0", Arguments: "{}"})); got != "one" {
		t.Fatalf("signature = %q", got)
	}
	c.put("f_0", "{}", []byte("two"))
	if got := c.get(scenario.ToolCall{ID: "f_0", Arguments: "{}"}); got != nil {
		t.Fatalf("ambiguous signature = %q, want none", got)
	}
}

func TestTheSignatureCacheIsBounded(t *testing.T) {
	var c signatureCache
	for i := range maxSignatures + 10 {
		c.put(string(rune(i)), "{}", []byte("s"))
	}
	if len(c.sigs) != maxSignatures || len(c.order) != maxSignatures {
		t.Fatalf("cache holds %d/%d entries, want %d", len(c.sigs), len(c.order), maxSignatures)
	}
	if c.get(scenario.ToolCall{ID: string(rune(0)), Arguments: "{}"}) != nil {
		t.Fatal("the oldest entry should be gone")
	}
}

func TestStreamKeepsTextThoughtSignatures(t *testing.T) {
	client, _ := sseClient(t,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"lo","thoughtSignature":"c2lnQQ=="}]},"finishReason":"STOP"}]}`,
	)
	resp, err := StreamGenerateContent(context.Background(), client, "gemini-test", []*genai.Content{genai.NewContentFromText("hi", genai.RoleUser)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	parts := resp.Candidates[0].Content.Parts
	if len(parts) != 1 || parts[0].Text != "Hello" || string(parts[0].ThoughtSignature) != "sigA" {
		t.Fatalf("parts %+v", parts)
	}
}

func TestFilesByURIGetAMediaType(t *testing.T) {
	contents := ToGeminiContents([]scenario.Message{{Role: scenario.RoleUser, Parts: []scenario.Part{
		scenario.ImageURLPart("https://example.com/cat.png?size=2"),
		scenario.ImageURLPart("gs://bucket/photo"),
		{Type: scenario.PartFile, URL: "https://example.com/report.pdf"},
		{Type: scenario.PartImage, Data: []byte("\x89PNG\r\n\x1a\n0000")},
	}}})
	parts := contents[0].Parts
	got := []string{parts[0].FileData.MIMEType, parts[1].FileData.MIMEType, parts[2].FileData.MIMEType, parts[3].InlineData.MIMEType}
	want := []string{"image/png", "image/jpeg", "application/pdf", "image/png"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("part %d media type = %q, want %q", i, got[i], want[i])
		}
	}
}
