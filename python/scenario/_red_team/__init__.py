"""Red-team attack strategy implementations for RedTeamAgent."""

from .base import AttackerOutput, RedTeamStrategy
from .crescendo import CrescendoStrategy
from .goat import GoatStrategy
from .tap import TapStrategy
from .techniques import AttackTechnique, DEFAULT_TECHNIQUES
from .techniques_goat import Technique, DEFAULT_GOAT_TECHNIQUES

__all__ = [
    "AttackerOutput",
    "RedTeamStrategy",
    "CrescendoStrategy",
    "GoatStrategy",
    "TapStrategy",
    "AttackTechnique",
    "DEFAULT_TECHNIQUES",
    "Technique",
    "DEFAULT_GOAT_TECHNIQUES",
]
