"""
AC-15 — judge auto-transcribes agent audio when model is non-multimodal.

Tests the _enrich_messages_with_transcripts helper directly (surgical) and
the JudgeAgent._conversation_has_audio / _extract_recording helpers.
"""
from __future__ import annotations

from scenario.judge_agent import JudgeAgent, _enrich_messages_with_transcripts
from scenario.voice.recording import AudioSegment, VoiceRecording


# ------------------------------------------------------------------ helpers


def _text_only_judge() -> JudgeAgent:
    """A judge whose model is text-only (gpt-4.1-mini is not in _AUDIO_CAPABLE_MODEL_SUBSTRINGS)."""
    return JudgeAgent(criteria=["agent replied correctly"], model="openai/gpt-4.1-mini")


def _multimodal_judge() -> JudgeAgent:
    """A judge whose model can ingest audio (gpt-4o is in _AUDIO_CAPABLE_MODEL_SUBSTRINGS)."""
    return JudgeAgent(criteria=["agent replied correctly"], model="openai/gpt-4o")


def _make_recording(agent_transcript: str | None = "agent reply text") -> VoiceRecording:
    """Build a recording with one user segment and one agent segment."""
    return VoiceRecording(
        segments=[
            AudioSegment(
                speaker="user",
                start_time=0.0,
                end_time=1.0,
                audio=b"\x00\x00" * 100,
                transcript="user said hi",
            ),
            AudioSegment(
                speaker="agent",
                start_time=1.0,
                end_time=2.0,
                audio=b"\x00\x00" * 100,
                transcript=agent_transcript,
            ),
        ]
    )


def _voice_messages(with_text_in_assistant: bool = False):
    """
    A minimal voice conversation:
      - user message with text + input_audio parts
      - assistant message with input_audio only (no text) — or with text if flag set
    """
    user_msg = {
        "role": "user",
        "content": [
            {"type": "text", "text": "hi"},
            {"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}},
        ],
    }
    if with_text_in_assistant:
        assistant_msg = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "already has text"},
                {"type": "input_audio", "input_audio": {"data": "BBBB", "format": "wav"}},
            ],
        }
    else:
        assistant_msg = {
            "role": "assistant",
            "content": [
                {"type": "input_audio", "input_audio": {"data": "BBBB", "format": "wav"}},
            ],
        }
    return [user_msg, assistant_msg]


# ------------------------------------------------------------------ unit tests


class TestConversationHasAudio:
    def test_detects_input_audio_type(self):
        msgs = _voice_messages()
        assert JudgeAgent._conversation_has_audio(msgs) is True

    def test_detects_audio_type(self):
        msgs = [
            {"role": "assistant", "content": [{"type": "audio", "audio": {"data": "X"}}]}
        ]
        assert JudgeAgent._conversation_has_audio(msgs) is True

    def test_returns_false_for_text_only(self):
        msgs = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ]
        assert JudgeAgent._conversation_has_audio(msgs) is False

    def test_returns_false_for_empty(self):
        assert JudgeAgent._conversation_has_audio([]) is False


class TestEnrichMessagesWithTranscripts:
    def test_prepends_transcript_text_preserving_audio(self):
        """Core invariant: audio-only assistant msg → message with text + audio.

        Audio MUST be preserved so audio-presence criteria
        ("agent and user exchanged real audio turns") still see the
        ``input_audio`` block. Stripping audio caused those criteria to
        fail with "the assistant's turns are text-only" verdicts.
        """
        msgs = _voice_messages()
        original_audio_part = msgs[1]["content"][0]
        recording = _make_recording(agent_transcript="agent reply text")

        result = _enrich_messages_with_transcripts(msgs, recording)

        # User message unchanged
        assert result[0] == msgs[0]

        # Assistant message: text prepended, audio preserved.
        enriched_content = result[1]["content"]
        assert enriched_content == [
            {"type": "text", "text": "agent reply text"},
            original_audio_part,
        ]

    def test_leaves_assistant_message_with_text_unchanged(self):
        """If assistant already has a text part, it should not be replaced."""
        msgs = _voice_messages(with_text_in_assistant=True)
        recording = _make_recording(agent_transcript="should not appear")

        result = _enrich_messages_with_transcripts(msgs, recording)

        # The assistant message still has its original content
        assert result[1]["content"] == msgs[1]["content"]

    def test_leaves_user_message_with_text_unchanged(self):
        """A user message that already carries text (audio+text) is not modified."""
        msgs = _voice_messages()  # user has BOTH text + audio
        recording = _make_recording()

        result = _enrich_messages_with_transcripts(msgs, recording)

        assert result[0] == msgs[0]

    def test_audio_only_user_message_gets_transcript_prepended(self):
        """An audio-only user message (no text part) gets its segment's
        transcript prepended. This is what lets a text-only judge read
        what the user simulator said via the swapped STT provider.
        """
        user_msg = {
            "role": "user",
            "content": [
                {"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}},
            ],
        }
        assistant_msg = {
            "role": "assistant",
            "content": [
                {"type": "input_audio", "input_audio": {"data": "BBBB", "format": "wav"}},
            ],
        }
        original_user_audio = user_msg["content"][0]
        original_agent_audio = assistant_msg["content"][0]
        recording = _make_recording(agent_transcript="agent reply text")

        result = _enrich_messages_with_transcripts([user_msg, assistant_msg], recording)

        assert result[0]["content"] == [
            {"type": "text", "text": "user said hi"},
            original_user_audio,
        ]
        assert result[1]["content"] == [
            {"type": "text", "text": "agent reply text"},
            original_agent_audio,
        ]

    def test_degrades_gracefully_when_no_transcript(self):
        """If no transcript available (STT failed), the message is left as-is."""
        msgs = _voice_messages()
        recording = _make_recording(agent_transcript=None)

        result = _enrich_messages_with_transcripts(msgs, recording)

        # Original audio-only message preserved
        assert result[1] == msgs[1]

    def test_ordinal_advances_past_segment_with_missing_transcript(self):
        """When an audio-only message exhausts the transcript list (e.g. STT
        dropped one segment), the ordinal must still advance so any LATER
        per-role message doesn't accidentally re-claim a transcript.

        Pins the safety-net at judge_agent.py:1107-1112 ('consume the ordinal
        slot anyway'). Without that branch, two agent messages with only one
        agent transcript would both map to the same transcript text. With it,
        the second message degrades gracefully.
        """
        # Two agent audio-only messages, but recording only yields ONE
        # agent transcript. Second message must NOT get the first transcript.
        msgs = [
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}},
            ]},
            {"role": "assistant", "content": [
                {"type": "input_audio", "input_audio": {"data": "BBBB", "format": "wav"}},
            ]},
            {"role": "assistant", "content": [
                {"type": "input_audio", "input_audio": {"data": "CCCC", "format": "wav"}},
            ]},
        ]
        recording = VoiceRecording(segments=[
            AudioSegment(speaker="user", start_time=0.0, end_time=1.0,
                         audio=b"\x00" * 200, transcript="user 1"),
            AudioSegment(speaker="agent", start_time=1.0, end_time=2.0,
                         audio=b"\x00" * 200, transcript="agent 1"),
            # Note: NO second agent segment → only "agent 1" in transcript list
        ])

        result = _enrich_messages_with_transcripts(msgs, recording)

        # First agent message: claims "agent 1"
        assert result[1]["content"][0] == {"type": "text", "text": "agent 1"}
        # Second agent message: NO transcript available — passes through
        # unchanged (does NOT re-claim "agent 1").
        assert result[2] == msgs[2]

    def test_does_not_mutate_input(self):
        """Returns a new list; original messages list is not modified."""
        msgs = _voice_messages()
        original_msgs = [dict(m) for m in msgs]
        recording = _make_recording()

        _enrich_messages_with_transcripts(msgs, recording)

        for orig, current in zip(original_msgs, msgs):
            assert orig["role"] == current["role"]

    def test_text_only_messages_pass_through(self):
        """Messages without any content list pass through unchanged."""
        msgs = [
            {"role": "user", "content": "plain text"},
            {"role": "assistant", "content": "plain reply"},
        ]
        recording = _make_recording()

        result = _enrich_messages_with_transcripts(msgs, recording)

        assert result == msgs


class TestTextOnlyJudgeAutoDetection:
    def test_text_only_model_should_not_include_audio(self):
        j = _text_only_judge()
        assert j.effective_include_audio(conversation_has_audio=True) is False

    def test_multimodal_model_should_include_audio(self):
        j = _multimodal_judge()
        assert j.effective_include_audio(conversation_has_audio=True) is True
