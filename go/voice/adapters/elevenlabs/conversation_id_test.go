package elevenlabs

import (
	"context"
	"slices"
	"testing"

	"github.com/langwatch/scenario/go/voice"
)

// The conversation metadata routinely arrives after the connect span ended.
// The id must then land on the next live span (the first audio send), and
// only once, or the run's recording cannot be resolved from its spans.

const conversationIDAttr = "voice.elevenlabs.conversation_id"

func metadataFrame(id string) map[string]any {
	return map[string]any{"type": "conversation_initiation_metadata", "conversation_initiation_metadata_event": map[string]any{
		"conversation_id": id, "agent_output_audio_format": "pcm_24000", "user_input_audio_format": "pcm_24000"}}
}

func TestConversationIDLandsOnTheNextLiveSpan(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	rec := newRecorder()
	f := newFake(t)
	tr := must(New(f.options("agt")))
	cctx, connectSpan := rec.tracer.Start(ctx, "voice.adapter.connect")
	if err := tr.Connect(cctx); err != nil {
		t.Fatal(err)
	}
	connectSpan.End()
	t.Cleanup(func() { _ = tr.Disconnect(ctx) })
	<-f.connected

	f.emit(metadataFrame("conv_late"))
	f.waitFor(func() bool { return tr.ConversationID() == "conv_late" }, "the conversation id")

	sctx, send := rec.tracer.Start(ctx, "voice.audio.send")
	if err := tr.SendAudio(sctx, voice.AudioChunk{Data: []byte{1, 2, 3, 4}}); err != nil {
		t.Fatal(err)
	}
	send.End()

	if got := rec.stamped(conversationIDAttr); !slices.Equal(got, []string{"voice.audio.send"}) {
		t.Fatalf("conversation id stamped on %v, want the send span", got)
	}
	if v := rec.attrs("voice.audio.send")[conversationIDAttr].AsString(); v != "conv_late" {
		t.Fatalf("stamped %q", v)
	}
	if rec.attrs("voice.adapter.connect")["voice.elevenlabs.agent_id"].AsString() != "agt" {
		t.Fatal("agent id not stamped on the connect span")
	}
}

func TestConversationIDStampedOnce(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	rec := newRecorder()
	f := newFake(t)
	tr := f.connect(f.options("agt"))
	f.emit(metadataFrame("conv_once"))
	f.waitFor(func() bool { return tr.ConversationID() == "conv_once" }, "the conversation id")
	for _, name := range []string{"voice.audio.send.first", "voice.audio.send.second"} {
		sctx, span := rec.tracer.Start(ctx, name)
		if err := tr.SendAudio(sctx, voice.AudioChunk{Data: []byte{1, 2, 3, 4}}); err != nil {
			t.Fatal(err)
		}
		span.End()
	}
	if got := rec.stamped(conversationIDAttr); !slices.Equal(got, []string{"voice.audio.send.first"}) {
		t.Fatalf("stamped on %v", got)
	}
}

func TestConversationIDOnAStillOpenConnectSpan(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	rec := newRecorder()
	f := newFake(t)
	tr := must(New(f.options("agt")))
	cctx, connectSpan := rec.tracer.Start(ctx, "voice.adapter.connect")
	if err := tr.Connect(cctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tr.Disconnect(ctx) })
	<-f.connected
	f.emit(metadataFrame("conv_early"))
	f.waitFor(func() bool { return tr.ConversationID() == "conv_early" }, "the conversation id")
	connectSpan.End()
	if got := rec.stamped(conversationIDAttr); !slices.Equal(got, []string{"voice.adapter.connect"}) {
		t.Fatalf("stamped on %v", got)
	}
	_ = tr.Disconnect(ctx)
	if tr.ConversationID() != "" {
		t.Fatal("Disconnect kept the conversation id")
	}
}
