"""
Post-hoc STT over a VoiceRecording — fills .transcript on segments that
don't already have one. Used by the judge fallback path for non-multimodal
judges (proposal §4.3) and as an opt-in to save_segments for richer
manifests.

We MUTATE segments in place rather than returning a new recording — keeps
the manifest, the executor's _voice_recording, and any user-held reference
in sync without churn.

Failure mode: if no STT provider is configured / the provider raises, we
log a warning per-segment and leave .transcript = None. We never raise.
The caller (judge, save_segments) treats null transcripts as "best-effort
not available" and proceeds.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .audio_chunk import AudioChunk
from .recording import AudioSegment, VoiceRecording
from .stt import STTProvider, get_stt_provider
from ._telemetry import voice_span

logger = logging.getLogger("scenario.voice")


async def transcribe_segments(
    recording: VoiceRecording,
    provider: Optional[STTProvider] = None,
    only_missing: bool = True,
) -> None:
    """
    Run STT over recording.segments, mutating .transcript in place.

    Args:
        recording: VoiceRecording to enrich.
        provider: STTProvider to use. Defaults to scenario.configure-set provider
            (OpenAI by default). Pass explicitly to override.
        only_missing: If True (default), skip segments whose transcript is
            already set. If False, re-transcribe everything (e.g. to overwrite
            adapter-side STT with a different provider).

    Concurrency: transcribes segments concurrently with asyncio.gather. Each
    segment's STT call is independent. Empty-data segments are skipped.

    Errors are caught per-segment and logged as warnings; never raised. Result:
    transcript stays None on failed segments, caller sees partial coverage.
    """
    if not recording.segments:
        return
    p = provider or _try_get_provider()
    if p is None:
        return  # already warned
    targets = [
        s
        for s in recording.segments
        if s.audio and (not only_missing or s.transcript is None)
    ]
    if not targets:
        return
    await asyncio.gather(*(_transcribe_one(p, s) for s in targets))


def _try_get_provider() -> Optional[STTProvider]:
    try:
        return get_stt_provider()
    except Exception as e:
        logger.warning(
            "scenario.voice.transcribe: no STT provider configured (%s); "
            "agent transcripts will remain null. Install one with "
            "scenario.set_stt_provider(...) to enable.",
            e,
        )
        return None


async def _transcribe_one(provider: STTProvider, segment: AudioSegment) -> None:
    try:
        with voice_span(
            "voice.stt.transcribe",
            {
                "voice.stt.scope": "judge",
                "voice.stt.speaker": segment.speaker,
                "voice.stt.audio_bytes": len(segment.audio),
            },
        ) as stt_span:
            try:
                text = await provider.transcribe(AudioChunk(data=segment.audio))
            except Exception as exc:
                # Provider SDK errors can include response bodies and key fragments.
                # Keep the raw detail local and let telemetry record only a minimal
                # provider-agnostic exception, matching the #783 STT guard.
                logger.debug(
                    "scenario.voice.transcribe: STT provider error detail",
                    exc_info=True,
                )
                raise RuntimeError(
                    f"STT provider failed: {type(exc).__name__}"
                ) from None
            segment.transcript = text or None
            if text:
                stt_span.set_attribute("voice.stt.transcript_chars", len(text))
    except Exception as e:
        logger.warning(
            "scenario.voice.transcribe: STT failed for %s segment at %.2fs: %s",
            segment.speaker,
            segment.start_time,
            e,
        )
