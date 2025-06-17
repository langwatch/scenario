"""
Scenario event schemas extending AG-UI base event types.
Leverages the official AG-UI Python SDK for base types and message handling.
"""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Any, Dict, List, Optional, Union, Literal
from pydantic import BaseModel, Field

# Import base types from AG-UI SDK
from ag_ui.core import BaseEvent

# Message format compatible with AG-UI protocol
ChatMessage = Dict[str, Any]  # {"id": str, "role": str, "content": str, ...}


# Re-export for convenience
__all__ = [
    "ScenarioEventType",
    "ScenarioRunStatus", 
    "Verdict",
    "ChatMessage",
    "BaseScenarioEvent",
    "ScenarioRunStartedEvent",
    "ScenarioResults",
    "ScenarioRunFinishedEvent",
    "ScenarioMessageSnapshotEvent",
    "generate_batch_run_id",
    "generate_scenario_id",
    "generate_scenario_run_id",
    "generate_scenario_set_id",
]


class ScenarioEventType(str, Enum):
    """Event types for scenario execution."""
    
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    MESSAGE_SNAPSHOT = "MESSAGE_SNAPSHOT"


class Verdict(str, Enum):
    """Verdict of scenario evaluation."""
    
    Success = "Success"
    Failure = "Failure"
    Inconclusive = "Inconclusive"


class ScenarioRunStatus(str, Enum):
    """Status of scenario execution."""
    
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ScenarioResults(BaseModel):
    """Results of scenario evaluation."""
    
    verdict: Verdict
    metCriteria: List[str] = Field(default_factory=list)
    unmetCriteria: List[str] = Field(default_factory=list)
    reasoning: str = ""





class BaseScenarioEvent(BaseEvent):
    """Base event for scenario execution with AG-UI compatibility."""
    
    # Scenario-specific tracking fields
    batchRunId: str = Field(..., description="Batch run identifier")
    scenarioId: str = Field(..., description="Scenario identifier")
    scenarioRunId: str = Field(..., description="Individual scenario run identifier")
    scenarioSetId: Optional[str] = Field(None, description="Scenario set identifier")


class ScenarioRunStartedEvent(BaseScenarioEvent):
    """Event emitted when a scenario run starts."""
    
    type: Literal[ScenarioEventType.RUN_STARTED] = ScenarioEventType.RUN_STARTED
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Scenario metadata")


class ScenarioRunFinishedEvent(BaseScenarioEvent):
    """Event emitted when a scenario run finishes."""
    
    type: Literal[ScenarioEventType.RUN_FINISHED] = ScenarioEventType.RUN_FINISHED
    status: ScenarioRunStatus
    results: ScenarioResults


class ScenarioMessageSnapshotEvent(BaseScenarioEvent):
    """Event emitted when messages are captured during scenario execution."""
    
    type: Literal[ScenarioEventType.MESSAGE_SNAPSHOT] = ScenarioEventType.MESSAGE_SNAPSHOT
    messages: List[ChatMessage] = Field(default_factory=list)


def generate_scenario_set_id() -> str:
    """Generate a scenario set ID."""
    return f"scenario-set-{uuid.uuid4()}"


def generate_batch_run_id() -> str:
    """Generate a batch run ID."""
    return f"batch-run-{uuid.uuid4()}"


def generate_scenario_run_id() -> str:
    """Generate a scenario run ID."""
    return f"scenario-run-{uuid.uuid4()}"


def generate_scenario_id() -> str:
    """Generate a scenario ID."""
    return f"scenario-{uuid.uuid4()}" 