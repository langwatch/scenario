"""
ID generation and management utilities for scenario execution.

This module provides functions for generating and managing unique identifiers
used throughout the scenario execution pipeline, particularly for batch runs
and scenario tracking.
"""

import os
import uuid


def get_or_create_batch_run_id() -> str:
    """
    Gets or creates a batch run ID for the current scenario execution.
    
    The batch run ID is consistent across all scenarios in the same process
    execution, allowing grouping of related scenario runs. This is useful
    for tracking and reporting on batches of scenarios run together.
    
    Returns:
        str: A unique batch run ID that persists for the process lifetime
        
    Example:
        ```python
        # All scenarios in same process will share this ID
        batch_id = get_or_create_batch_run_id()
        print(f"Running scenario in batch: {batch_id}")
        ```
    """
    
    # Check if batch ID already exists in environment
    if not os.environ.get("SCENARIO_BATCH_ID"):
        # Generate new batch ID if not set
        os.environ["SCENARIO_BATCH_ID"] = f"batch-run-{uuid.uuid4()}"
    
    return os.environ["SCENARIO_BATCH_ID"]


def generate_scenario_run_id() -> str:
    """
    Generates a unique scenario run ID for a single scenario execution.
    
    Each scenario run gets a unique identifier that distinguishes it from
    other runs, even within the same batch. This is used for tracking
    individual scenario executions and correlating events.
    
    Returns:
        str: A unique scenario run ID
        
    Example:
        ```python
        # Each scenario gets its own unique ID
        scenario_id = generate_scenario_run_id()
        print(f"Running scenario with ID: {scenario_id}")
        ```
    """
    return f"scenario-run-{uuid.uuid4()}" 