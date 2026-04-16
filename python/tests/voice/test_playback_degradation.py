"""
Unit tests for ffmpeg playback graceful degradation (locked decision #8).

When the ffmpeg subprocess fails to open the output device (typical on
headless CI), the FfmpegPlayback must:
    - not raise from start()
    - become inactive
    - emit a debug log instead of a user-visible error
    - safely ignore subsequent feed() calls
"""

import logging
from unittest.mock import patch

from scenario.voice import AudioChunk
from scenario.voice.playback import FfmpegPlayback


def test_start_failure_sets_inactive_and_logs_at_debug(caplog):
    pb = FfmpegPlayback()
    with patch("subprocess.Popen", side_effect=OSError("device busy")):
        with caplog.at_level(logging.DEBUG, logger="scenario.voice.playback"):
            pb.start()
    assert pb.active is False
    # Error is logged at debug level (not error/warning) so headless CI is quiet.
    debug_msgs = [r for r in caplog.records if r.levelno == logging.DEBUG]
    assert any("failed to start ffmpeg" in r.getMessage() for r in debug_msgs)


def test_feed_after_failed_start_is_noop():
    pb = FfmpegPlayback()
    with patch("subprocess.Popen", side_effect=OSError("no audio device")):
        pb.start()
    # Must not raise even though start() failed.
    pb.feed(AudioChunk(data=b"\x00\x00" * 240))


def test_stop_on_unstarted_playback_is_safe():
    pb = FfmpegPlayback()
    pb.stop()  # must not raise


def test_feed_tolerates_broken_pipe():
    class _FakeProc:
        returncode = 0

        class stdin:
            @staticmethod
            def write(b):
                raise BrokenPipeError

            @staticmethod
            def flush():
                pass

        stderr = None

        def wait(self, timeout=None): return 0

        def kill(self): pass

    pb = FfmpegPlayback()
    pb._proc = _FakeProc()  # type: ignore[assignment]
    pb._active = True
    pb.feed(AudioChunk(data=b"\x00\x00"))
    assert pb.active is False  # now marked inactive
