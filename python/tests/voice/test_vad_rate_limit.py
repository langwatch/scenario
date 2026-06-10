"""Regression tests for the ``WebRTCVadFallback`` one-shot UserWarning rate-limit.

Covers AC3 of langwatch/scenario#491 (the P3.2 "VAD rate-limit under-tested"
gap). These are *characterization* tests of the EXISTING production behavior in
``python/scenario/voice/vad.py`` — they assert what the code does today, they do
not drive a change to it.

Behavior under test (quoted from ``vad.py`` lines 37-54 of origin/main):

    _warned_adapters: "set[str]" = set()          # class body -> CLASS attribute

    @classmethod
    def _emit_fallback_warning_once(cls, adapter_name: str) -> None:
        if adapter_name in cls._warned_adapters:   # keyed on the adapter_name str
            return
        cls._warned_adapters.add(adapter_name)
        warnings.warn(... UserWarning, ...)         # category: UserWarning

``_warned_adapters`` is declared in the class body, so it is a **class-level
(shared) attribute**, NOT a per-instance attribute. The memo is keyed on the
caller-passed ``adapter_name`` string. ``_emit_fallback_warning_once`` is
invoked from ``__init__`` (``vad.py`` line 63), so **constructing** a
``WebRTCVadFallback`` is what emits the warning — no audio input is required to
exercise the rate-limit path.

Consequence (asserted below): two distinct ``WebRTCVadFallback`` instances
constructed with the SAME ``adapter_name`` produce **exactly 1** warning,
because the dedup set lives on the class and is shared across instances.
"""

import warnings

import pytest

from scenario.voice import WebRTCVadFallback


@pytest.fixture(autouse=True)
def _reset_vad_warning_memo():
    """Clear the class-level warning memo before AND after each test.

    ``_warned_adapters`` is shared process-wide (class attribute), so without
    this reset, test ordering would leak warning state between cases and other
    test modules. ``reset_warnings()`` is the module's documented test hook
    ("Intended for tests.", ``vad.py`` line 41)."""
    WebRTCVadFallback.reset_warnings()
    yield
    WebRTCVadFallback.reset_warnings()


def _construct_and_count_warnings(adapter_names: list[str]) -> int:
    """Construct one ``WebRTCVadFallback`` per name, return the UserWarning count.

    Exercises the REAL code path: the warning is emitted by ``__init__`` via
    ``_emit_fallback_warning_once`` — we never touch ``_warned_adapters``
    directly. Each name yields a fresh, distinct instance, so this also covers
    the cross-instance dimension for any repeated name."""
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")  # defeat the interpreter's __warningregistry__ dedup
        for name in adapter_names:
            WebRTCVadFallback(name)
        return len([w for w in captured if issubclass(w.category, UserWarning)])


@pytest.mark.parametrize(
    ("adapter_names", "expected_warning_count", "rationale"),
    [
        # Same adapter_name twice -> the second construction hits the memo and
        # is suppressed. One-shot per adapter_name.
        (["A", "A"], 1, "same name twice -> deduped to 1"),
        # Two distinct names -> each is a first-sighting, so both warn.
        (["A", "B"], 2, "two distinct names -> 1 warning each"),
        # Sanity anchors for the boundary cases.
        ([], 0, "no construction -> no warning"),
        (["A"], 1, "single construction -> single warning"),
        # Three distinct names -> three warnings (memo keyed per-string).
        (["A", "B", "C"], 3, "three distinct names -> 3 warnings"),
        # Mixed: repeats of an already-seen name stay suppressed regardless of
        # interleaving.
        (["A", "B", "A", "B"], 2, "interleaved repeats -> still 1 per distinct name"),
    ],
)
def test_warning_count_is_one_shot_per_adapter_name(
    adapter_names: list[str], expected_warning_count: int, rationale: str
):
    """The UserWarning is rate-limited to one emission per distinct ``adapter_name``.

    Each list element constructs a *separate* ``WebRTCVadFallback`` instance, so
    repeated names in the list are inherently cross-instance — the dedup must be
    coming from the shared class-level ``_warned_adapters`` set, not from any
    per-instance state."""
    assert _construct_and_count_warnings(adapter_names) == expected_warning_count, rationale


def test_cross_instance_same_string_warns_once():
    """Two DISTINCT instances, SAME ``adapter_name`` string -> exactly 1 warning.

    This is the load-bearing AC3 characterization: it pins the *class-level*
    (shared) semantics of ``_warned_adapters``. If the attribute were ever moved
    to instance scope (set in ``__init__``), this count would become 2 and this
    test would fail — which is the regression we want to catch."""
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        first = WebRTCVadFallback("SameNameAdapter")
        second = WebRTCVadFallback("SameNameAdapter")
        # Sanity: they really are two different objects (genuine cross-instance).
        assert first is not second
        user_warnings = [w for w in captured if issubclass(w.category, UserWarning)]

    assert len(user_warnings) == 1, (
        "cross-instance same adapter_name must warn exactly once because "
        "_warned_adapters is a shared class attribute"
    )
    # The single warning is the expected UserWarning and names the adapter.
    assert issubclass(user_warnings[0].category, UserWarning)
    assert "SameNameAdapter" in str(user_warnings[0].message)


def test_warned_adapters_is_class_level_not_instance_level():
    """Document & guard the class-vs-instance fact directly.

    ``_warned_adapters`` is declared in the class body, so every instance reads
    through to the SAME set object. We assert identity (``is``) across the class
    and two instances — the structural reason the cross-instance dedup above
    holds. Reading these attributes does not emit (already-warned name), so no
    warning assertions here."""
    WebRTCVadFallback("ClassLevelProbe")  # seed the memo via the real ctor path
    inst_a = WebRTCVadFallback("ClassLevelProbe")
    inst_b = WebRTCVadFallback("ClassLevelProbe")

    # The instance attribute lookup resolves to the class attribute (same object).
    assert inst_a._warned_adapters is WebRTCVadFallback._warned_adapters
    assert inst_b._warned_adapters is WebRTCVadFallback._warned_adapters
    assert inst_a._warned_adapters is inst_b._warned_adapters
    # And the seeded name is present in that shared set.
    assert "ClassLevelProbe" in WebRTCVadFallback._warned_adapters
