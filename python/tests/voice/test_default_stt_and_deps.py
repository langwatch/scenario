"""
Unit tests for the default STT provider identity + hard-dep presence.

Covers:
    - get_stt_provider() defaults to OpenAISTTProvider with gpt-4o-transcribe.
    - Every hard voice dep is importable (no stale package metadata).
    - Bundled noise WAVs ship inside the package at scenario/voice/assets/noise/.
"""

import importlib

from scenario.voice import OpenAISTTProvider, get_stt_provider


def test_default_stt_provider_is_openai_gpt4o_transcribe():
    provider = get_stt_provider()
    assert isinstance(provider, OpenAISTTProvider)
    assert provider.model == "gpt-4o-transcribe"


def test_every_hard_voice_dep_imports():
    # Each is a hard dep per pyproject.toml + Background in voice-agents.feature.
    for module_name in ("imageio_ffmpeg", "numpy", "webrtcvad", "websockets"):
        mod = importlib.import_module(module_name)
        assert mod is not None


def test_imageio_ffmpeg_binary_resolvable():
    import imageio_ffmpeg

    path = imageio_ffmpeg.get_ffmpeg_exe()
    assert path and isinstance(path, str)


def test_bundled_noise_samples_ship_with_package():
    from importlib.resources import files

    pkg = files("scenario.voice.assets.noise")
    for name in ("cafe", "street", "office", "airport", "babble"):
        wav = pkg / f"{name}.wav"
        assert wav.is_file(), f"Missing bundled noise sample: {name}.wav"
        # Ensure the file is non-trivially populated.
        assert len(wav.read_bytes()) > 1000
