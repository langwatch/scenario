"""
Example test demonstrating database service mocking with real LLM tool calling.

This example shows how to mock database connections/operations within tools
while using actual LLM tool calling mechanisms to test realistic agent behavior.
"""

import pytest
import scenario
from unittest.mock import patch, Mock
import litellm
import json


# Mock database connection - this would normally be a real database client
class DatabaseClient:
    def save_user(self, name: str, email: str) -> dict:
        """Save a user to the database."""
        # This would normally execute SQL or call a database API
        raise NotImplementedError("This should be mocked in tests")


# Real tool implementation that uses database client
def save_user(name: str, email: str) -> dict:
    """Save a user to the database using database client."""
    db_client = DatabaseClient()
    return db_client.save_user(name, email)


class DatabaseAgent(scenario.AgentAdapter):
    """Agent that uses real LLM tool calling to save user data to database."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Define the database tool schema for the LLM
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": "save_user",
                    "description": "Save a user to the database with their name and email",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "The user's full name",
                            },
                            "email": {
                                "type": "string",
                                "description": "The user's email address",
                            },
                        },
                        "required": ["name", "email"],
                    },
                },
            }
        ]

        # Let the LLM decide when and how to call the database tool
        # The LLM will extract name and email from the user's natural language request
        response = litellm.completion(
            model="openai/gpt-4o-mini",
            messages=input.messages,
            tools=tool_schemas,
            tool_choice="auto",  # LLM decides when to use tools
        )

        message = response.choices[0].message  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Handle any tool calls the LLM decided to make
        if message.tool_calls:
            tool_responses = []

            for tool_call in message.tool_calls:
                tool_name = tool_call.function.name
                # LLM provides the arguments (name, email) extracted from user input
                args = json.loads(tool_call.function.arguments)

                # Execute the appropriate tool function
                if tool_name == "save_user":
                    try:
                        # Call the actual tool function with LLM-extracted parameters
                        tool_result = save_user(**args)
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": json.dumps(tool_result),
                            }
                        )
                    except Exception as e:
                        # Handle tool execution errors gracefully
                        tool_responses.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.id,
                                "content": f"Error: {str(e)}",
                            }
                        )

            # If tools were called, get the LLM's final response based on tool results
            if tool_responses:
                follow_up_response = litellm.completion(
                    model="openai/gpt-4o-mini",
                    messages=input.messages + [message] + tool_responses,
                )
                return follow_up_response.choices[0].message.content or ""  # type: ignore[attr-defined]  # litellm response has dynamic attributes

        # Return the LLM's direct response if no tools were called
        return message.content or ""


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_database_service_mocking():
    """Test mocking database connections within tools while using real LLM tool calling."""

    # Mock the database client at the service level, not the tool level
    with patch("test_database_tool_mocking.DatabaseClient") as mock_db_class:
        # Setup the mock database client and response
        mock_db_client = Mock()
        mock_db_class.return_value = mock_db_client

        # Mock what the database would return
        mock_db_client.save_user.return_value = {
            "id": 123,
            "name": "John",
            "email": "john@example.com",
        }

        result = await scenario.run(
            name="database service test",
            description="Test tool's database integration with mocked database client",
            agents=[
                DatabaseAgent(),
                scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            ],
            script=[
                # User makes a natural language request
                scenario.user("Save a new user named John with email john@example.com"),
                # Agent uses LLM to understand request and call appropriate tools
                scenario.agent(),
                # Verify the database mock was called with specific parameters extracted by the LLM
                # This proves the LLM correctly:
                # 1. Decided to use the save_user tool
                # 2. Extracted "John" as the name parameter from natural language
                # 3. Extracted "john@example.com" as the email parameter
                lambda state: mock_db_client.save_user.assert_called_once_with(
                    "John", "john@example.com"
                ),
                scenario.succeed(),
            ],
        )

        assert result.success
