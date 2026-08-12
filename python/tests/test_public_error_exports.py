"""The package root has to be enough to catch what the library raises.

``scenario.voice`` is where the voice adapters live, but a caller writing
``except scenario.FirstChunkTimeoutError`` should not have to know that. The
errors below were reachable only through the submodule, so catching them by
type meant importing a second path and knowing which one raised.
"""

import scenario
import scenario.voice as voice


VOICE_ERRORS = [
    "AgentStreamEndedError",
    "FirstChunkTimeoutError",
    "ModalityNegotiationError",
    "PipecatRecvError",
    "UnsupportedCapabilityError",
]


class TestGivenAnErrorTheLibraryRaises:
    def test_reaches_the_package_root(self) -> None:
        missing = [name for name in VOICE_ERRORS if not hasattr(scenario, name)]
        assert missing == []

    def test_is_the_same_class_the_submodule_raises(self) -> None:
        """Identity, not just a name.

        A re-export that rebound the name to a fresh class would satisfy an
        attribute check and still fail every ``except``, since the object the
        adapter raises would be a different class from the one caught.
        """
        for name in VOICE_ERRORS:
            assert getattr(scenario, name) is getattr(voice, name), name

    def test_is_listed_in_the_root_public_surface(self) -> None:
        """``__all__`` is what ``from scenario import *`` and the docs follow.

        An attribute that exists but is unlisted is reachable by accident
        rather than on purpose, and tooling that reads the surface will not
        show it.
        """
        missing = [name for name in VOICE_ERRORS if name not in scenario.__all__]
        assert missing == []


class TestGivenTheVoicePackageGainsANewError:
    def test_the_root_gains_it_too(self) -> None:
        """The list above is a floor, not the contract.

        This is the part that keeps the gap from reopening: it derives the
        expectation from ``scenario.voice.__all__`` at run time, so an error
        added there and forgotten here fails without anyone remembering to
        update a list. That is exactly how these four came to be missing.
        """
        declared = [n for n in voice.__all__ if n.endswith("Error")]
        assert declared, "expected scenario.voice to declare at least one error"
        missing = [n for n in declared if not hasattr(scenario, n)]
        assert missing == [], (
            f"{missing} are exported from scenario.voice but not from scenario; "
            "add them to the root import block and __all__"
        )


class TestGivenAPipecatReceiveFailure:
    def test_is_catchable_as_the_general_stream_ended_error(self) -> None:
        """The subclass relationship has to survive the re-export.

        ``PipecatRecvError`` is documented as a subclass of
        ``AgentStreamEndedError`` so a caller can catch the general case. Both
        names now come from the root, and the relationship is only useful if
        it holds between the objects the root hands out.
        """
        assert issubclass(scenario.PipecatRecvError, scenario.AgentStreamEndedError)

        try:
            raise scenario.PipecatRecvError("transport closed")
        except scenario.AgentStreamEndedError as caught:
            assert isinstance(caught, scenario.PipecatRecvError)
        else:  # pragma: no cover - the except above always runs
            raise AssertionError("PipecatRecvError was not caught as AgentStreamEndedError")
