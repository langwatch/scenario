# Scenario Events System

The Scenario Events System provides comprehensive observability and monitoring capabilities for scenario execution. It automatically publishes events during scenario runs and can be integrated with external monitoring, logging, and analytics systems.

## Overview

The events system consists of several key components:

- **Event Models** - Structured event data with type safety
- **Event Bus** - Asynchronous event processing with RxPY
- **Event Reporter** - HTTP-based event publishing with retry logic
- **Message Utilities** - Conversion between different message formats

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Scenario       │    │   Event Bus     │    │  Event Reporter │
│  Executor       │───▶│   (RxPY)        │───▶│   (HTTP)        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   External      │
                       │   Endpoint      │
                       └─────────────────┘
```

## Event Types

### ScenarioRunStartedEvent

Published when a scenario begins execution. Includes metadata about the scenario.

```python
from scenario.events import ScenarioRunStartedEvent, ScenarioRunStartedEventMetadata

metadata = ScenarioRunStartedEventMetadata(
    name="weather query test",
    description="User asks about weather, agent should provide helpful response"
)

event = ScenarioRunStartedEvent(
    batch_run_id="batch-123",
    scenario_id="weather-query-test",
    scenario_run_id="run-456",
    metadata=metadata,
    timestamp=1703123456789
)
```

### ScenarioMessageSnapshotEvent

Published whenever messages are added to the conversation. Captures the current state.

```python
from scenario.events import ScenarioMessageSnapshotEvent
from scenario.events.messages import UserMessage, AssistantMessage

messages = [
    UserMessage(id="msg-1", content="What's the weather like?"),
    AssistantMessage(id="msg-2", content="Let me check that for you...")
]

event = ScenarioMessageSnapshotEvent(
    batch_run_id="batch-123",
    scenario_id="weather-query-test",
    scenario_run_id="run-456",
    messages=messages,
    timestamp=1703123456789
)
```

### ScenarioRunFinishedEvent

Published when a scenario completes execution. Includes results and verdict.

```python
from scenario.events import (
    ScenarioRunFinishedEvent,
    ScenarioRunFinishedEventStatus,
    ScenarioRunFinishedEventResults,
    ScenarioRunFinishedEventVerdict
)

results = ScenarioRunFinishedEventResults(
    verdict=ScenarioRunFinishedEventVerdict.SUCCESS,
    reasoning="Agent provided helpful weather information",
    met_criteria=["Agent is helpful", "Agent provides weather info"],
    unmet_criteria=[]
)

event = ScenarioRunFinishedEvent(
    batch_run_id="batch-123",
    scenario_id="weather-query-test",
    scenario_run_id="run-456",
    status=ScenarioRunFinishedEventStatus.SUCCESS,
    results=results,
    timestamp=1703123456789
)
```

## Event Bus

The EventBus manages event publishing and processing using RxPY for concurrent, non-blocking operation.

### Basic Usage

```python
from scenario.events import ScenarioEventBus, EventReporter

# Create event bus with default reporter
event_bus = ScenarioEventBus()

# Start listening for events
await event_bus.listen()

# Publish events
event_bus.publish(scenario_started_event)
event_bus.publish(message_snapshot_event)
event_bus.publish(scenario_finished_event)  # Completes the stream

# Wait for all events to be processed
await event_bus.drain()
```

### Custom Configuration

```python
from scenario.events import ScenarioEventBus, EventReporter

# Custom event reporter
reporter = EventReporter(
    endpoint="https://your-api.com/events",
    api_key="your-api-key"
)

# Event bus with custom configuration
event_bus = ScenarioEventBus(
    event_reporter=reporter,
    max_retries=5  # Retry failed events up to 5 times
)
```

### Event Processing Pipeline

The EventBus uses RxPY to create a processing pipeline:

1. **Event Publishing** - Events are published via `publish()`
2. **Concurrent Processing** - Each event is processed in its own asyncio task
3. **Automatic Retry** - Failed events are retried with exponential backoff
4. **Stream Completion** - Publishing a `ScenarioRunFinishedEvent` completes the stream

## Event Reporter

The EventReporter handles HTTP posting of events to external endpoints.

### Configuration

```python
from scenario.events import EventReporter

# Via constructor
reporter = EventReporter(
    endpoint="https://your-api.com/events",
    api_key="your-api-key"
)

# Via environment variables
import os
os.environ["SCENARIO_EVENTS_ENDPOINT"] = "https://your-api.com/events"
os.environ["LANGWATCH_API_KEY"] = "your-api-key"

reporter = EventReporter()  # Uses environment variables
```

### Custom Event Reporter

You can create custom event reporters for different use cases:

```python
from scenario.events import ScenarioEvent
import logging

class LoggingEventReporter:
    def __init__(self):
        self.logger = logging.getLogger("scenario_events")

    async def post_event(self, event: ScenarioEvent):
        self.logger.info(f"Event: {event.type_} - {event.scenario_id}")

class DatabaseEventReporter:
    def __init__(self, db_connection):
        self.db = db_connection

    async def post_event(self, event: ScenarioEvent):
        await self.db.events.insert_one(event.to_dict())

# Use custom reporters
logging_reporter = LoggingEventReporter()
db_reporter = DatabaseEventReporter(db_connection)

event_bus = ScenarioEventBus(event_reporter=logging_reporter)
```

## Message Utilities

The events system includes utilities for converting between different message formats.

### Converting OpenAI Messages

```python
from scenario.events.utils import convert_messages_to_ag_ui_messages
from openai.types.chat import ChatCompletionMessageParam

# OpenAI format messages
openai_messages = [
    ChatCompletionMessageParam(role="user", content="Hello"),
    ChatCompletionMessageParam(role="assistant", content="Hi there!")
]

# Convert to ag_ui format
ag_ui_messages = convert_messages_to_ag_ui_messages(openai_messages)
```

### Message Types

The system supports various message types:

```python
from scenario.events.messages import (
    UserMessage, AssistantMessage, SystemMessage,
    ToolMessage, ToolCall, FunctionCall
)

# User message
user_msg = UserMessage(id="msg-1", content="What's the weather?")

# Assistant message with tool calls
tool_call = ToolCall(
    id="call-1",
    function=FunctionCall(name="get_weather", arguments='{"city": "NYC"}')
)
assistant_msg = AssistantMessage(
    id="msg-2",
    content="Let me check the weather for you.",
    tool_calls=[tool_call]
)

# Tool response
tool_msg = ToolMessage(
    id="msg-3",
    content='{"temperature": 72, "condition": "sunny"}',
    tool_call_id="call-1"
)
```

## Integration Examples

### Monitoring System Integration

```python
from scenario.events import ScenarioEventBus, EventReporter

# Integrate with monitoring systems like DataDog, New Relic, etc.
monitoring_reporter = EventReporter(
    endpoint="https://api.datadoghq.com/api/v1/events",
    api_key="your-datadog-api-key"
)

event_bus = ScenarioEventBus(event_reporter=monitoring_reporter)

# Use in scenario
result = await scenario.run(
    name="monitored test",
    agents=[my_agent, scenario.UserSimulatorAgent()],
    event_bus=event_bus
)
```

### Custom Analytics

```python
from scenario.events import ScenarioEventBus, ScenarioEvent
import asyncio

class AnalyticsReporter:
    def __init__(self):
        self.metrics = {
            "scenarios_started": 0,
            "scenarios_completed": 0,
            "total_messages": 0
        }

    async def post_event(self, event: ScenarioEvent):
        if event.type_ == "SCENARIO_RUN_STARTED":
            self.metrics["scenarios_started"] += 1
        elif event.type_ == "SCENARIO_RUN_FINISHED":
            self.metrics["scenarios_completed"] += 1
        elif event.type_ == "SCENARIO_MESSAGE_SNAPSHOT":
            self.metrics["total_messages"] += len(event.messages)

        print(f"Current metrics: {self.metrics}")

analytics_reporter = AnalyticsReporter()
event_bus = ScenarioEventBus(event_reporter=analytics_reporter)
```

### Error Handling and Retry Logic

The EventBus includes built-in retry logic for failed event processing:

```python
from scenario.events import ScenarioEventBus, EventReporter

# Custom reporter that sometimes fails
class FlakyReporter:
    def __init__(self, fail_probability=0.3):
        self.fail_probability = fail_probability
        self.attempts = {}

    async def post_event(self, event: ScenarioEvent):
        event_id = f"{event.scenario_run_id}-{event.type_}"
        self.attempts[event_id] = self.attempts.get(event_id, 0) + 1

        # Simulate occasional failures
        if random.random() < self.fail_probability:
            raise Exception(f"Simulated failure (attempt {self.attempts[event_id]})")

        print(f"Successfully processed {event.type_}")

# Event bus will automatically retry failed events
flaky_reporter = FlakyReporter(fail_probability=0.5)
event_bus = ScenarioEventBus(event_reporter=flaky_reporter, max_retries=3)
```

## Performance Considerations

### Concurrent Processing

Events are processed concurrently to avoid blocking scenario execution:

```python
# Multiple events can be processed simultaneously
event_bus.publish(event1)  # Starts processing immediately
event_bus.publish(event2)  # Starts processing immediately
event_bus.publish(event3)  # Starts processing immediately

# All events are processed in parallel
await event_bus.drain()  # Wait for all to complete
```

### Memory Management

The EventBus automatically manages memory by completing the event stream:

```python
# Event stream is automatically cleaned up when finished
event_bus.publish(scenario_started_event)
event_bus.publish(message_snapshot_event)
event_bus.publish(scenario_finished_event)  # Completes stream, cleans up resources

await event_bus.drain()  # Ensures all events are processed
```

## Troubleshooting

### Common Issues

1. **Events not being published**

   - Check that `event_bus.listen()` was called before publishing
   - Verify environment variables are set correctly

2. **Events failing to post**

   - Check network connectivity to the endpoint
   - Verify API key is valid
   - Check endpoint URL format

3. **Memory leaks**
   - Ensure `ScenarioRunFinishedEvent` is published to complete the stream
   - Call `event_bus.drain()` to wait for processing

### Debug Mode

Enable debug logging to troubleshoot event processing:

```python
import logging

# Enable debug logging for events
logging.basicConfig(level=logging.DEBUG)
logging.getLogger("EventReporter").setLevel(logging.DEBUG)
```

## API Reference

### EventBus Methods

- `__init__(event_reporter=None, max_retries=3)` - Initialize event bus
- `publish(event)` - Publish an event to the processing pipeline
- `listen()` - Start listening for events (idempotent)
- `drain()` - Wait for all events to be processed
- `is_completed()` - Check if event processing is complete

### EventReporter Methods

- `__init__(endpoint=None, api_key=None)` - Initialize reporter
- `post_event(event)` - Post event to configured endpoint

### Event Models

All event models inherit from the generated LangWatch API client models and include:

- `to_dict()` - Convert to dictionary representation
- `type_` - Event type identifier
- `timestamp` - Unix timestamp in milliseconds
- Common fields: `batch_run_id`, `scenario_id`, `scenario_run_id`

For detailed API documentation, see the individual module docstrings and the generated LangWatch API client documentation.
