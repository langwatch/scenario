"""Unit tests for WebRTCVadFallback."""

import warnings

import numpy as np
import pytest

from scenario.voice import AudioChunk, WebRTCVadFallback


SR = 24000


def _high_energy_pcm(duration_s: float) -> bytes:
    """Dense broadband noise near full scale — webrtcvad classifies this as speech."""
    rng = np.random.default_rng(seed=42)
    samples = (rng.standard_normal(int(duration_s * SR)) * 16000).astype(np.int16)
    return samples.tobytes()


def _silence_pcm(duration_s: float) -> bytes:
    return b"\x00\x00" * int(duration_s * SR)


def _frames(n: int) -> bytes:
    """``n`` whole VAD frames of arbitrary PCM.

    Content is irrelevant wherever a :class:`_ScriptedVad` is installed — the
    classification is scripted, so these bytes only have to be the right *length*.
    """
    return b"\x01\x00" * (WebRTCVadFallback.SAMPLES_PER_FRAME * n)


class _ScriptedVad:
    """Deterministic stand-in for ``webrtcvad.Vad``.

    The real classifier's verdicts depend on the acoustic content, so tests that
    drive it with noise can only assert ``>= 1`` transition (it legitimately
    flickers at the boundary). That fuzziness is exactly what lets a
    level-triggered regression hide. Scripting the per-frame verdicts makes the
    transition contract *exactly* assertable.
    """

    def __init__(self, verdicts: list[bool]):
        self._verdicts = list(verdicts)
        self.calls = 0

    def is_speech(self, frame: bytes, rate: int) -> bool:
        self.calls += 1
        return self._verdicts.pop(0) if self._verdicts else False


def _vad_with_scripted_verdicts(monkeypatch: pytest.MonkeyPatch, verdicts: list[bool]):
    """Build a fallback whose classifier is scripted; return (vad, stub, starts, ends).

    ``monkeypatch`` (rather than a direct ``vad._vad = stub``) because the real
    ``_vad`` is nominally a ``webrtcvad.Vad`` — a C-extension class the stub cannot
    subclass — so a plain assignment is a pyright ``reportAttributeAccessIssue``.
    """
    WebRTCVadFallback.reset_warnings()
    starts: list[bool] = []
    ends: list[bool] = []
    vad = WebRTCVadFallback(
        "TestAdapter",
        on_speech_start=lambda: starts.append(True),
        on_speech_end=lambda: ends.append(True),
    )
    stub = _ScriptedVad(verdicts)
    monkeypatch.setattr(vad, "_vad", stub)
    return vad, stub, starts, ends


def test_vad_fires_one_event_per_transition_not_per_frame(monkeypatch: pytest.MonkeyPatch):
    """Callbacks are **edge**-triggered: one event per speech *run*, not per frame.

    The transition tests above assert ``>= 1`` start/end because the real
    classifier flickers on noise — so they pass just as happily against a
    *level*-triggered detector that re-fires ``on_speech_start`` for every single
    speech frame. That would spam the timeline with one "speech started" per 30 ms.
    Scripting the verdicts lets us pin the real contract: a 5-frame speech run
    surrounded by silence yields exactly ONE start and exactly ONE end.
    """
    verdicts = [False, True, True, True, True, True, False, False]
    vad, stub, starts, ends = _vad_with_scripted_verdicts(monkeypatch, verdicts)

    vad.process(AudioChunk(data=_frames(len(verdicts))))

    assert stub.calls == len(verdicts), "every whole frame must be classified"
    assert len(starts) == 1, f"speech run must fire exactly one start, got {len(starts)}"
    assert len(ends) == 1, f"speech run must fire exactly one end, got {len(ends)}"
    assert not vad.is_speaking


def test_vad_buffers_partial_frames_across_chunks(monkeypatch: pytest.MonkeyPatch):
    """A frame split across chunks is reassembled — the residual is not dropped.

    ``process()`` keeps a partial frame in ``self._buf`` and completes it from the
    next chunk. Every other test feeds whole-frame-sized chunks, so a regression
    that discarded the residual each call (or classified a short frame) would go
    unnoticed. Streaming transports hand us arbitrarily-sized chunks, so this is
    the class's normal operating mode, not an edge case.
    """
    vad, stub, starts, _ends = _vad_with_scripted_verdicts(monkeypatch, [True])
    payload = _frames(1)
    third = len(payload) // 3

    vad.process(AudioChunk(data=payload[:third]))
    assert stub.calls == 0, "a sub-frame chunk must not be classified"
    vad.process(AudioChunk(data=payload[third : 2 * third]))
    assert stub.calls == 0, "still short of a whole frame — must keep buffering"

    vad.process(AudioChunk(data=payload[2 * third :]))

    assert stub.calls == 1, "the reassembled frame must be classified exactly once"
    assert len(starts) == 1
    assert vad.is_speaking


def test_vad_fallback_warning_message_names_adapter_and_accuracy_caveat():
    """Content-shape assertion separate from the rate-limit shape below."""
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("TwilioAgentAdapter")
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    msg = str(user_warnings[0].message)
    assert "TwilioAgentAdapter" in msg
    assert "native VAD" in msg
    assert "accuracy" in msg.lower()


@pytest.mark.parametrize(
    "adapter_names, expected_warning_count",
    [
        # Same name twice on same instance pair → one warning. The
        # ClassVar set memoizes by adapter_name string, not class identity.
        (["A", "A"], 1),
        # Two distinct names → two warnings.
        (["A", "B"], 2),
        # Cross-instance with the same string → still one warning. Locks
        # in that the dedupe is across *all* instances of the fallback,
        # not just within a single instance's lifetime.
        (["SameName", "SameName"], 1),
    ],
)
def test_vad_fallback_rate_limits_by_adapter_name(adapter_names, expected_warning_count):
    """``WebRTCVadFallback._warned_adapters`` rate-limits the
    "no native VAD" UserWarning by the caller-supplied adapter_name
    string, regardless of how many fallback instances are constructed.
    """
    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        for name in adapter_names:
            WebRTCVadFallback(name)
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == expected_warning_count


def test_vad_fallback_rate_limit_keys_on_name_string_not_python_class():
    """The dedupe key is the caller-passed ``adapter_name`` string, not the
    Python class.

    The parametrized test above varies only the name, so on its own it cannot
    distinguish "keyed on the string" from "keyed on the (single) class". This
    pins the distinction explicitly with a *second* class: ``_warned_adapters``
    is a ClassVar shared down the hierarchy, so a subclass instance built with a
    string the base already warned for stays silent, while a fresh string warns.
    Guards against a refactor that switches the key to ``type(self)`` / per-class
    state — which would re-warn once per adapter class and defeat the rate-limit.
    """

    class _SubclassVad(WebRTCVadFallback):
        pass

    WebRTCVadFallback.reset_warnings()
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        WebRTCVadFallback("SharedName")  # base class warns for "SharedName"
        _SubclassVad("SharedName")  # different class, same string → silent
        _SubclassVad("OtherName")  # different class, new string → warns
    user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 2


def test_vad_detects_silence_to_voice_to_silence_transitions():
    # Use dense random-noise "voice" between two silence chunks. Broadband
    # high-energy audio is reliably classified as speech by webrtcvad at
    # aggressiveness 2, where a pure tone is not.
    WebRTCVadFallback.reset_warnings()
    starts, ends = [], []
    vad = WebRTCVadFallback(
        "TestAdapter",
        aggressiveness=2,
        on_speech_start=lambda: starts.append(True),
        on_speech_end=lambda: ends.append(True),
    )
    vad.process(AudioChunk(data=_silence_pcm(0.3)))
    vad.process(AudioChunk(data=_high_energy_pcm(0.8)))
    vad.process(AudioChunk(data=_silence_pcm(0.8)))
    # A silence→speech→silence sequence must produce at least one of each
    # transition. We allow >=1 rather than ==1 because webrtcvad can briefly
    # flicker between classifications around the boundary.
    assert len(starts) >= 1, "expected at least one speech-start transition"
    assert len(ends) >= 1, "expected at least one speech-end transition"
    # And the last transition must be back to silence.
    assert not vad.is_speaking


def test_vad_with_silence_only_never_fires_speech_start():
    WebRTCVadFallback.reset_warnings()
    starts = []
    vad = WebRTCVadFallback(
        "TestAdapter",
        on_speech_start=lambda: starts.append(True),
    )
    vad.process(AudioChunk(data=_silence_pcm(1.0)))
    assert starts == []
    assert not vad.is_speaking
