"""
Unit tests for local audio playback (§4.7).

We verify the command shape only — actually invoking ffmpeg against a real
audio device is an integration concern and not guaranteed in CI.
"""

import platform

from scenario.voice.playback import FfmpegPlayback, _platform_audio_output_args


def test_platform_output_args_matches_host_platform():
    args = _platform_audio_output_args()
    sysname = platform.system()
    # Always "-f <driver>" + device argument.
    assert args[0] == "-f"
    if sysname == "Darwin":
        assert args[1] == "audiotoolbox"
    elif sysname == "Linux":
        assert args[1] == "alsa"
    elif sysname == "Windows":
        assert args[1] == "dshow"


def test_ffmpeg_playback_has_safe_default_state():
    pb = FfmpegPlayback()
    assert pb.active is False  # not started yet


def test_feed_before_start_is_a_noop():
    from scenario.voice import AudioChunk

    pb = FfmpegPlayback()
    # Should not raise even though we never called start().
    pb.feed(AudioChunk(data=b"\x00" * 100))
