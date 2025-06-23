"""
ID generation and management utilities for scenario execution.

This module provides functions for generating and managing unique identifiers
used throughout the scenario execution pipeline, particularly for batch runs
and scenario tracking.
"""

import os
import uuid


def generate_thread_id() -> str:
    """
    Generates a new thread ID.

    Returns:
        str: A new thread ID.
    """
    return f"thread_{uuid.uuid4()}"


def generate_scenario_run_id() -> str:
    """
    Generates a new scenario run ID.

    Returns:
        str: A new scenario run ID.
    """
    return f"scenariorun_{uuid.uuid4()}"


def generate_scenario_id() -> str:
    """
    Generates a new scenario ID.

    Returns:
        str: A new scenario ID.
    """
    return f"scenario_{uuid.uuid4()}"


def get_batch_run_id() -> str:
    """
    Gets the batch run ID. If it's not set, it will be generated.
    It can be set via the SCENARIO_BATCH_RUN_ID environment variable.

    Returns:
        str: The batch run ID.
    """
    # Check if batch ID already exists in environment
    batch_run_id = os.environ.get("SCENARIO_BATCH_RUN_ID")
    if not batch_run_id:
        # Generate new batch ID if not set
        batch_run_id = f"scenariobatchrun_{uuid.uuid4()}"
        os.environ["SCENARIO_BATCH_RUN_ID"] = batch_run_id

    return batch_run_id


def generate_message_id() -> str:
    """
    Generates a new message ID.

    Returns:
        str: A new message ID.
    """
    return f"scenariomsg_{uuid.uuid4()}"


def safe_parse_uuid(id_str: str) -> bool:
    """
    Safely parses a UUID string.

    Args:
        id_str: The UUID string to parse.

    Returns:
        bool: True if the UUID string is valid, false otherwise.
    """
    try:
        uuid.UUID(id_str)
        return True
    except (ValueError, TypeError):
        return False


# Backward compatibility aliases
def get_or_create_batch_run_id() -> str:
    """
    Backward compatibility alias for get_batch_run_id().

    Returns:
        str: The batch run ID.
    """
    return get_batch_run_id()
