"""
Tests for scenario event classes extending AG-UI base types.
Following TDD approach - these tests define expected behavior before implementation.
"""

import pytest
from typing import Dict, Any
from uuid import UUID
import time
import json

# Import the classes we'll be testing
from scenario.events import (
    ScenarioEventType,
    Verdict,
    ScenarioRunStatus,
    ScenarioResults,
    ScenarioMetadata,
    BaseScenarioEvent,
    ScenarioRunStartedEvent,
    ScenarioRunFinishedEvent,
    ScenarioMessageSnapshotEvent,
    ScenarioEvent,
    generate_batch_run_id,
    generate_scenario_run_id,
    generate_scenario_id,
    # AG-UI types we're extending
    BaseEvent,
    EventType,
    MessagesSnapshotEvent,
)


class TestEnums:
    """Test the enum classes."""
    
    def test_scenario_event_type_enum(self):
        """Test ScenarioEventType enum values."""
        assert ScenarioEventType.RUN_STARTED == "SCENARIO_RUN_STARTED"
        assert ScenarioEventType.RUN_FINISHED == "SCENARIO_RUN_FINISHED"
        assert ScenarioEventType.MESSAGE_SNAPSHOT == "SCENARIO_MESSAGE_SNAPSHOT"
        
        # Test that it's a string enum
        assert isinstance(ScenarioEventType.RUN_STARTED, str)
        
    def test_verdict_enum(self):
        """Test Verdict enum values."""
        assert Verdict.SUCCESS == "success"
        assert Verdict.FAILURE == "failure"
        assert Verdict.INCONCLUSIVE == "inconclusive"
        
        # Test that it's a string enum
        assert isinstance(Verdict.SUCCESS, str)
        
    def test_scenario_run_status_enum(self):
        """Test ScenarioRunStatus enum values."""
        assert ScenarioRunStatus.SUCCESS == "SUCCESS"
        assert ScenarioRunStatus.FAILED == "FAILED"
        assert ScenarioRunStatus.CANCELLED == "CANCELLED"
        assert ScenarioRunStatus.ERROR == "ERROR"
        assert ScenarioRunStatus.IN_PROGRESS == "IN_PROGRESS"
        assert ScenarioRunStatus.PENDING == "PENDING"


class TestScenarioResults:
    """Test ScenarioResults model."""
    
    def test_scenario_results_minimal(self):
        """Test ScenarioResults with minimal required fields."""
        results = ScenarioResults(verdict=Verdict.SUCCESS)
        
        assert results.verdict == Verdict.SUCCESS
        assert results.reasoning is None
        assert results.metCriteria == []
        assert results.unmetCriteria == []
        
    def test_scenario_results_full(self):
        """Test ScenarioResults with all fields."""
        results = ScenarioResults(
            verdict=Verdict.FAILURE,
            reasoning="Agent failed to follow instructions",
            metCriteria=["criterion1"],
            unmetCriteria=["criterion2", "criterion3"]
        )
        
        assert results.verdict == Verdict.FAILURE
        assert results.reasoning == "Agent failed to follow instructions"
        assert results.metCriteria == ["criterion1"]
        assert results.unmetCriteria == ["criterion2", "criterion3"]
        
    def test_scenario_results_serialization(self):
        """Test ScenarioResults serialization."""
        results = ScenarioResults(
            verdict=Verdict.SUCCESS,
            reasoning="All criteria met",
            metCriteria=["responsive", "accurate"],
            unmetCriteria=[]
        )
        
        data = results.model_dump()
        assert data["verdict"] == "success"
        assert data["reasoning"] == "All criteria met"
        assert data["metCriteria"] == ["responsive", "accurate"]
        assert data["unmetCriteria"] == []


class TestScenarioMetadata:
    """Test ScenarioMetadata model."""
    
    def test_scenario_metadata_empty(self):
        """Test ScenarioMetadata with no fields."""
        metadata = ScenarioMetadata()
        
        assert metadata.name is None
        assert metadata.description is None
        
    def test_scenario_metadata_full(self):
        """Test ScenarioMetadata with all fields."""
        metadata = ScenarioMetadata(
            name="Test Scenario",
            description="A comprehensive test scenario"
        )
        
        assert metadata.name == "Test Scenario"
        assert metadata.description == "A comprehensive test scenario"


class TestBaseScenarioEvent:
    """Test BaseScenarioEvent model extending AG-UI BaseEvent."""
    
    def test_base_scenario_event_extends_ag_ui(self):
        """Test that BaseScenarioEvent properly extends AG-UI BaseEvent."""
        # This should be a subclass of AG-UI BaseEvent
        assert issubclass(BaseScenarioEvent, BaseEvent)
        
    def test_base_scenario_event_creation(self):
        """Test BaseScenarioEvent creation with scenario-specific fields."""
        event = BaseScenarioEvent(
            type=ScenarioEventType.RUN_STARTED,
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789"
        )
        
        assert event.type == ScenarioEventType.RUN_STARTED
        assert event.batchRunId == "batch-run-123"
        assert event.scenarioId == "scenario-456"
        assert event.scenarioRunId == "scenario-run-789"
        assert event.scenarioSetId == "default"
        
        # Should have AG-UI BaseEvent fields
        assert hasattr(event, 'timestamp')
        assert hasattr(event, 'raw_event')
        
    def test_base_scenario_event_with_optional_fields(self):
        """Test BaseScenarioEvent with optional fields."""
        custom_time = int(time.time() * 1000)  # AG-UI uses milliseconds
        raw_event = {"custom": "data"}
        
        event = BaseScenarioEvent(
            type=ScenarioEventType.RUN_FINISHED,
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            scenarioSetId="custom-set",
            timestamp=custom_time,
            raw_event=raw_event
        )
        
        assert event.scenarioSetId == "custom-set"
        assert event.timestamp == custom_time
        assert event.raw_event == raw_event


class TestScenarioRunStartedEvent:
    """Test ScenarioRunStartedEvent model."""
    
    def test_scenario_run_started_event_creation(self):
        """Test ScenarioRunStartedEvent creation."""
        metadata = ScenarioMetadata(name="Test Scenario")
        
        event = ScenarioRunStartedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            metadata=metadata
        )
        
        assert event.type == ScenarioEventType.RUN_STARTED
        assert event.batchRunId == "batch-run-123"
        assert event.scenarioId == "scenario-456"
        assert event.scenarioRunId == "scenario-run-789"
        assert event.metadata == metadata
        assert isinstance(event, BaseEvent)  # Should be AG-UI BaseEvent
        
    def test_scenario_run_started_event_serialization(self):
        """Test ScenarioRunStartedEvent serialization."""
        metadata = ScenarioMetadata(
            name="Test Scenario",
            description="A test scenario"
        )
        
        event = ScenarioRunStartedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            metadata=metadata
        )
        
        data = event.model_dump()
        assert data["type"] == "SCENARIO_RUN_STARTED"
        assert data["batchRunId"] == "batch-run-123"
        assert data["metadata"]["name"] == "Test Scenario"
        assert data["metadata"]["description"] == "A test scenario"


class TestScenarioRunFinishedEvent:
    """Test ScenarioRunFinishedEvent model."""
    
    def test_scenario_run_finished_event_minimal(self):
        """Test ScenarioRunFinishedEvent with minimal fields."""
        event = ScenarioRunFinishedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            status=ScenarioRunStatus.SUCCESS
        )
        
        assert event.type == ScenarioEventType.RUN_FINISHED
        assert event.status == ScenarioRunStatus.SUCCESS
        assert event.results is None
        assert isinstance(event, BaseEvent)  # Should be AG-UI BaseEvent
        
    def test_scenario_run_finished_event_with_results(self):
        """Test ScenarioRunFinishedEvent with results."""
        results = ScenarioResults(
            verdict=Verdict.SUCCESS,
            reasoning="All tests passed",
            metCriteria=["responsive"],
            unmetCriteria=[]
        )
        
        event = ScenarioRunFinishedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            status=ScenarioRunStatus.SUCCESS,
            results=results
        )
        
        assert event.results == results
        assert event.results.verdict == Verdict.SUCCESS
        
    def test_scenario_run_finished_event_serialization(self):
        """Test ScenarioRunFinishedEvent serialization."""
        results = ScenarioResults(verdict=Verdict.FAILURE)
        
        event = ScenarioRunFinishedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            status=ScenarioRunStatus.FAILED,
            results=results
        )
        
        data = event.model_dump()
        assert data["type"] == "SCENARIO_RUN_FINISHED"
        assert data["status"] == "FAILED"
        assert data["results"]["verdict"] == "failure"


class TestScenarioMessageSnapshotEvent:
    """Test ScenarioMessageSnapshotEvent model."""
    
    def test_scenario_message_snapshot_event_creation(self):
        """Test ScenarioMessageSnapshotEvent creation with AG-UI message format."""
        # Use AG-UI message format (dict with id, role, content)
        messages = [
            {"id": "msg-1", "role": "user", "content": "Hello"},
            {"id": "msg-2", "role": "assistant", "content": "Hi there!"}
        ]
        
        event = ScenarioMessageSnapshotEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            messages=messages
        )
        
        assert event.type == ScenarioEventType.MESSAGE_SNAPSHOT
        assert len(event.messages) == 2
        assert event.messages[0]["content"] == "Hello"
        assert event.messages[1]["content"] == "Hi there!"
        assert isinstance(event, BaseEvent)  # Should be AG-UI BaseEvent
        
    def test_scenario_message_snapshot_event_empty_messages(self):
        """Test ScenarioMessageSnapshotEvent with empty messages."""
        event = ScenarioMessageSnapshotEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            messages=[]
        )
        
        assert event.messages == []
        
    def test_scenario_message_snapshot_event_serialization(self):
        """Test ScenarioMessageSnapshotEvent serialization."""
        messages = [
            {"id": "msg-1", "role": "user", "content": "Test message"}
        ]
        
        event = ScenarioMessageSnapshotEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            messages=messages
        )
        
        data = event.model_dump()
        assert data["type"] == "SCENARIO_MESSAGE_SNAPSHOT"
        assert len(data["messages"]) == 1
        assert data["messages"][0]["role"] == "user"
        assert data["messages"][0]["content"] == "Test message"


class TestIdGenerators:
    """Test ID generation functions."""
    
    def test_generate_batch_run_id(self):
        """Test batch run ID generation."""
        batch_id = generate_batch_run_id()
        
        assert isinstance(batch_id, str)
        assert batch_id.startswith("batch-run-")
        
        # Should be followed by a valid UUID
        uuid_part = batch_id.replace("batch-run-", "")
        UUID(uuid_part)  # Will raise if invalid
        
        # Multiple calls should generate different IDs
        batch_id2 = generate_batch_run_id()
        assert batch_id != batch_id2
        
    def test_generate_scenario_run_id(self):
        """Test scenario run ID generation."""
        run_id = generate_scenario_run_id()
        
        assert isinstance(run_id, str)
        assert run_id.startswith("scenario-run-")
        
        # Should be followed by a valid UUID
        uuid_part = run_id.replace("scenario-run-", "")
        UUID(uuid_part)  # Will raise if invalid
        
        # Multiple calls should generate different IDs
        run_id2 = generate_scenario_run_id()
        assert run_id != run_id2
        
    def test_generate_scenario_id(self):
        """Test scenario ID generation."""
        scenario_id = generate_scenario_id()
        
        assert isinstance(scenario_id, str)
        assert scenario_id.startswith("scenario-")
        
        # Should be followed by a valid UUID
        uuid_part = scenario_id.replace("scenario-", "")
        UUID(uuid_part)  # Will raise if invalid
        
        # Multiple calls should generate different IDs
        scenario_id2 = generate_scenario_id()
        assert scenario_id != scenario_id2


class TestEventUnion:
    """Test the ScenarioEvent union type."""
    
    def test_scenario_event_union_started(self):
        """Test that ScenarioRunStartedEvent is valid ScenarioEvent."""
        metadata = ScenarioMetadata(name="Test")
        event = ScenarioRunStartedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            metadata=metadata
        )
        
        # Should be valid ScenarioEvent and AG-UI BaseEvent
        assert isinstance(event, BaseScenarioEvent)
        assert isinstance(event, BaseEvent)
        
    def test_scenario_event_union_finished(self):
        """Test that ScenarioRunFinishedEvent is valid ScenarioEvent."""
        event = ScenarioRunFinishedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            status=ScenarioRunStatus.SUCCESS
        )
        
        # Should be valid ScenarioEvent and AG-UI BaseEvent
        assert isinstance(event, BaseScenarioEvent)
        assert isinstance(event, BaseEvent)
        
    def test_scenario_event_union_snapshot(self):
        """Test that ScenarioMessageSnapshotEvent is valid ScenarioEvent."""
        event = ScenarioMessageSnapshotEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            messages=[]
        )
        
        # Should be valid ScenarioEvent and AG-UI BaseEvent
        assert isinstance(event, BaseScenarioEvent)
        assert isinstance(event, BaseEvent)


class TestAGUIIntegration:
    """Test integration with AG-UI base types."""
    
    def test_ag_ui_base_event_available(self):
        """Test that AG-UI BaseEvent is available."""
        assert BaseEvent is not None
        assert EventType is not None
        assert MessagesSnapshotEvent is not None
        
    def test_scenario_events_extend_ag_ui(self):
        """Test that our scenario events properly extend AG-UI types."""
        # All our events should extend AG-UI BaseEvent
        assert issubclass(BaseScenarioEvent, BaseEvent)
        assert issubclass(ScenarioRunStartedEvent, BaseEvent)
        assert issubclass(ScenarioRunFinishedEvent, BaseEvent)
        assert issubclass(ScenarioMessageSnapshotEvent, BaseEvent)
        
    def test_ag_ui_event_type_compatibility(self):
        """Test that our events work with AG-UI EventType enum."""
        # Our events should have type field compatible with AG-UI
        event = ScenarioRunStartedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            metadata=ScenarioMetadata()
        )
        
        # Should have a type field
        assert hasattr(event, 'type')
        assert isinstance(event.type, str)


class TestOpenAPICompatibility:
    """Test compatibility with OpenAPI schema expectations."""
    
    def test_scenario_run_started_matches_openapi(self):
        """Test that ScenarioRunStartedEvent matches OpenAPI schema."""
        event = ScenarioRunStartedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            metadata=ScenarioMetadata(name="Test", description="Test scenario")
        )
        
        data = event.model_dump()
        
        # Should have all required OpenAPI fields
        required_fields = [
            "type", "batchRunId", "scenarioId", "scenarioRunId", "metadata"
        ]
        for field in required_fields:
            assert field in data
            
        # Type should match OpenAPI enum
        assert data["type"] == "SCENARIO_RUN_STARTED"
        
    def test_scenario_run_finished_matches_openapi(self):
        """Test that ScenarioRunFinishedEvent matches OpenAPI schema."""
        results = ScenarioResults(
            verdict=Verdict.SUCCESS,
            reasoning="Test passed",
            metCriteria=["criterion1"],
            unmetCriteria=[]
        )
        
        event = ScenarioRunFinishedEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            status=ScenarioRunStatus.SUCCESS,
            results=results
        )
        
        data = event.model_dump()
        
        # Should have all required OpenAPI fields
        required_fields = [
            "type", "batchRunId", "scenarioId", "scenarioRunId", "status"
        ]
        for field in required_fields:
            assert field in data
            
        # Status should match OpenAPI enum
        assert data["status"] == "SUCCESS"
        
        # Results should have required structure
        assert "results" in data
        assert "verdict" in data["results"]
        assert "metCriteria" in data["results"]
        assert "unmetCriteria" in data["results"]
        
    def test_message_snapshot_matches_openapi(self):
        """Test that ScenarioMessageSnapshotEvent matches OpenAPI schema."""
        messages = [
            {"id": "msg-1", "role": "user", "content": "Hello"},
            {"id": "msg-2", "role": "assistant", "content": "Hi"}
        ]
        
        event = ScenarioMessageSnapshotEvent(
            batchRunId="batch-run-123",
            scenarioId="scenario-456",
            scenarioRunId="scenario-run-789",
            messages=messages
        )
        
        data = event.model_dump()
        
        # Should have all required OpenAPI fields
        required_fields = [
            "type", "messages", "batchRunId", "scenarioId", "scenarioRunId"
        ]
        for field in required_fields:
            assert field in data
            
        # Messages should have proper structure
        assert len(data["messages"]) == 2
        for msg in data["messages"]:
            assert "id" in msg
            assert "role" in msg
            assert "content" in msg 