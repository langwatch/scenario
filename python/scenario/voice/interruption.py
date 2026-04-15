"""
Interruption configuration for proceed(interruptions=...).

Source §4.4 L478-492. Two strategies:
    - ``"contextual"``: an LLM generates a short interruption phrase from
      the running conversation context.
    - ``"random_phrase"``: draw from a canned phrase list.

The proposal does not supply the contextual LLM prompt — implementer-level
decision. We use a short system prompt focused on realistic user interjections.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Literal, Sequence, Tuple


# Short, realistic mid-turn interruptions. Used as-is for strategy="random_phrase"
# and as few-shot examples for strategy="contextual".
_CANNED_PHRASES: Tuple[str, ...] = (
    "Wait, that's not right",
    "No no, let me explain again",
    "Hold on a second",
    "Actually scratch that",
    "Sorry to cut you off",
    "Wait I forgot to mention",
    "Hmm, let me correct you",
)


CONTEXTUAL_PROMPT = (
    "You are simulating a user interrupting an AI agent mid-sentence. "
    "Produce a SHORT (2–8 word) interjection that would realistically "
    "cut the agent off. Do not answer their question. Do not greet them. "
    "Just the interjection — no quotes, no punctuation besides a comma or period."
)


@dataclass
class InterruptionConfig:
    """Configuration for random interruptions during ``proceed()``."""

    probability: float = 0.3
    delay_range: Tuple[float, float] = (0.5, 3.0)
    strategy: Literal["contextual", "random_phrase"] = "random_phrase"
    phrases: Sequence[str] = field(default_factory=lambda: _CANNED_PHRASES)

    def should_interrupt(self, rng: random.Random | None = None) -> bool:
        r = rng or random
        return r.random() < self.probability

    def sample_delay(self, rng: random.Random | None = None) -> float:
        r = rng or random
        lo, hi = self.delay_range
        return r.uniform(lo, hi)

    def pick_random_phrase(self, rng: random.Random | None = None) -> str:
        r = rng or random
        return r.choice(list(self.phrases))
