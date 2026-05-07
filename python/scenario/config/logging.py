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

    # Optional file handler: set SCENARIO_LOG_FILE to write logs to a file.
    # Attached to the ROOT logger at SCENARIO_LOG_LEVEL so third-party
    # libraries (litellm, OpenAI, OpenTelemetry, Pipecat) flow into the same
    # file — otherwise their output is terminal-only and lost when the
    # process exits.
    log_file: Optional[str] = os.environ.get("SCENARIO_LOG_FILE")
    if log_file:
        root_logger = logging.getLogger()
        if root_logger.level == logging.NOTSET or root_logger.level > level:
            root_logger.setLevel(level)
        # Avoid duplicate file handlers on re-import
        if not any(
            isinstance(h, logging.FileHandler) and h.baseFilename == os.path.abspath(log_file)
            for h in root_logger.handlers
        ):
            log_dir = os.path.dirname(os.path.abspath(log_file))
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)
            file_handler = logging.FileHandler(log_file, mode="a")
            file_handler.setLevel(level)
            file_handler.setFormatter(logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
            ))
            root_logger.addHandler(file_handler)


configure_logging()
