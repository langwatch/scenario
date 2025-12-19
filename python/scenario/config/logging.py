"""
Logging configuration for Scenario.

Configures the scenario logger based on SCENARIO_LOG_LEVEL environment variable.
"""

import logging
import os
from typing import Optional


def configure_logging() -> None:
    """
    Configure the scenario logger based on SCENARIO_LOG_LEVEL env var.

    Supported levels: DEBUG, INFO, WARNING, ERROR, CRITICAL
    If not set, logging remains unconfigured (silent).
    """
    level_str: Optional[str] = os.environ.get("SCENARIO_LOG_LEVEL")

    if not level_str:
        return

    level_str = level_str.upper()
    level = getattr(logging, level_str, None)

    if not isinstance(level, int):
        return

    logger = logging.getLogger("scenario")
    logger.setLevel(level)

    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(level)
        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)


configure_logging()
