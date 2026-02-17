"""
Unit tests for reverse_roles (message role reversal).
Mirrors the JS messageRoleReversal tests in utils.test.ts.
"""

from scenario._utils.utils import (
    reverse_roles,
    _has_tool_content,
    _summarize_tool_message,
    _stringify_value,
)


# ── _stringify_value tests ────────────────────────────────────────────────────


class TestStringifyValue:
    def test_string_passthrough(self):
        assert _stringify_value("hello") == "hello"

    def test_none(self):
        assert _stringify_value(None) == "None"

    def test_dict(self):
        assert _stringify_value({"a": 1}) == '{"a": 1}'

    def test_list(self):
        assert _stringify_value([1, 2, 3]) == "[1, 2, 3]"

    def test_number(self):
        assert _stringify_value(42) == "42"

    def test_non_serializable_fallback(self):
        result = _stringify_value(object())
        assert result.startswith("<object object")


# ── _has_tool_content tests ───────────────────────────────────────────────────


class TestHasToolContent:
    def test_tool_role(self):
        assert _has_tool_content({"role": "tool", "content": "result"}) is True

    def test_assistant_with_tool_calls(self):
        msg = {"role": "assistant", "tool_calls": [{"function": {"name": "x"}}]}
        assert _has_tool_content(msg) is True

    def test_regular_user_message(self):
        assert _has_tool_content({"role": "user", "content": "hi"}) is False

    def test_regular_assistant_message(self):
        assert _has_tool_content({"role": "assistant", "content": "hello"}) is False

    def test_system_message(self):
        assert _has_tool_content({"role": "system", "content": "prompt"}) is False


# ── _summarize_tool_message tests ─────────────────────────────────────────────


class TestSummarizeToolMessage:
    def test_tool_result_message(self):
        msg = {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "get_weather",
            "content": "Sunny 22°C",
        }
        assert _summarize_tool_message(msg) == "[Tool result from get_weather: Sunny 22°C]"

    def test_tool_result_with_json_content(self):
        msg = {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "search",
            "content": '{"results": [1, 2, 3]}',
        }
        assert _summarize_tool_message(msg) == '[Tool result from search: {"results": [1, 2, 3]}]'

    def test_tool_result_missing_name(self):
        msg = {"role": "tool", "tool_call_id": "call_1", "content": "data"}
        assert _summarize_tool_message(msg) == "[Tool result from unknown tool: data]"

    def test_assistant_with_single_tool_call(self):
        msg = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "calculator",
                        "arguments": '{"expression": "2+2"}',
                    },
                }
            ],
        }
        result = _summarize_tool_message(msg)
        assert result == '[Called tool calculator with: {"expression": "2+2"}]'

    def test_assistant_with_multiple_tool_calls(self):
        msg = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search", "arguments": '{"q": "foo"}'},
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "fetch", "arguments": '{"url": "bar"}'},
                },
            ],
        }
        result = _summarize_tool_message(msg)
        assert result is not None
        assert '[Called tool search with: {"q": "foo"}]' in result
        assert '[Called tool fetch with: {"url": "bar"}]' in result

    def test_assistant_with_malformed_tool_call_no_function(self):
        msg = {
            "role": "assistant",
            "tool_calls": [{"id": "call_1", "type": "function"}],
        }
        assert _summarize_tool_message(msg) is None

    def test_regular_message_returns_none(self):
        assert _summarize_tool_message({"role": "user", "content": "hi"}) is None
        assert _summarize_tool_message({"role": "assistant", "content": "hello"}) is None


# ── reverse_roles tests ──────────────────────────────────────────────────────


class TestReverseRoles:
    def test_reverse_user_to_assistant(self):
        messages = [
            {"role": "user", "content": "Hello, how are you?"},
            {"role": "user", "content": "What's the weather like?"},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "assistant", "content": "Hello, how are you?"},
            {"role": "assistant", "content": "What's the weather like?"},
        ]

    def test_reverse_assistant_to_user(self):
        messages = [
            {"role": "assistant", "content": "I'm doing well, thank you!"},
            {"role": "assistant", "content": "It's sunny today."},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "user", "content": "I'm doing well, thank you!"},
            {"role": "user", "content": "It's sunny today."},
        ]

    def test_mixed_user_and_assistant(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "How are you?"},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "assistant", "content": "Hello"},
            {"role": "user", "content": "Hi there!"},
            {"role": "assistant", "content": "How are you?"},
        ]

    def test_preserve_system_messages(self):
        messages = [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "assistant", "content": "Hello"},
            {"role": "user", "content": "Hi!"},
        ]

    def test_empty_array(self):
        assert reverse_roles([]) == []

    def test_summarize_tool_calls_and_results(self):
        """Tool calls and results should be summarized as plain text with 'user' role."""
        messages = [
            {"role": "user", "content": "Calculate 2+2"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "calculator",
                            "arguments": '{"expression": "2+2"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "calculator",
                "content": "4",
            },
            {"role": "assistant", "content": "The answer is 4"},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "assistant", "content": "Calculate 2+2"},
            {"role": "user", "content": '[Called tool calculator with: {"expression": "2+2"}]'},
            {"role": "user", "content": "[Tool result from calculator: 4]"},
            {"role": "user", "content": "The answer is 4"},
        ]

    def test_multiple_tool_calls_in_conversation(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "What's 5*6?"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "calc", "arguments": '{"expr": "5*6"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_2", "name": "calc", "content": "30"},
            {"role": "assistant", "content": "The result is 30"},
            {"role": "user", "content": "Thanks!"},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "assistant", "content": "Hello"},
            {"role": "user", "content": "Hi there!"},
            {"role": "assistant", "content": "What's 5*6?"},
            {"role": "user", "content": '[Called tool calc with: {"expr": "5*6"}]'},
            {"role": "user", "content": "[Tool result from calc: 30]"},
            {"role": "user", "content": "The result is 30"},
            {"role": "assistant", "content": "Thanks!"},
        ]

    def test_tool_only_agent_response_ends_with_user_role(self):
        """When agent returns only tool-call + tool-result with no final text,
        the last message after reversal must be 'user' role for Anthropic compatibility."""
        messages = [
            {"role": "system", "content": "You are pretending to be a user"},
            {"role": "assistant", "content": "Hello, how can I help you today"},
            {"role": "user", "content": "do you have headphones?"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "lookup",
                            "arguments": '{"query": "headphones"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "lookup",
                "content": "headphones: $29.99, in stock",
            },
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result == [
            {"role": "system", "content": "You are pretending to be a user"},
            {"role": "user", "content": "Hello, how can I help you today"},
            {"role": "assistant", "content": "do you have headphones?"},
            {"role": "user", "content": '[Called tool lookup with: {"query": "headphones"}]'},
            {"role": "user", "content": "[Tool result from lookup: headphones: $29.99, in stock]"},
        ]
        # Verify last message is "user" role (required by Anthropic)
        assert result[-1]["role"] == "user"

    def test_multiple_tool_calls_in_single_message(self):
        """Assistant message with multiple tool_calls should summarize all of them."""
        messages = [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "search", "arguments": '{"q": "foo"}'},
                    },
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "fetch", "arguments": '{"url": "bar"}'},
                    },
                ],
            },
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert len(result) == 1
        assert result[0]["role"] == "user"
        assert '[Called tool search with: {"q": "foo"}]' in str(result[0]["content"])
        assert '[Called tool fetch with: {"url": "bar"}]' in str(result[0]["content"])

    def test_assistant_with_content_and_tool_calls_drops_content(self):
        """When assistant has both text content and tool_calls, only tool calls
        are summarized (text content is dropped). Matches JS behavior."""
        messages = [
            {
                "role": "assistant",
                "content": "Let me check that for you",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "search", "arguments": '{"q": "test"}'},
                    }
                ],
            },
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert len(result) == 1
        assert result[0]["role"] == "user"
        assert "Let me check that for you" not in str(result[0]["content"])
        assert '[Called tool search with: {"q": "test"}]' in str(result[0]["content"])

    def test_does_not_mutate_original_messages(self):
        """reverse_roles should deep copy messages, not mutate originals."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
        ]
        reverse_roles(messages)  # type: ignore[arg-type]
        assert messages[0]["role"] == "user"
        assert messages[1]["role"] == "assistant"

    def test_message_without_content_preserved(self):
        """Messages without content but with a reversible role should still be reversed."""
        messages = [
            {"role": "user", "content": "test"},
            {"role": "assistant", "content": None},
        ]
        result = reverse_roles(messages)  # type: ignore[arg-type]
        assert result[0]["role"] == "assistant"
        assert result[1]["role"] == "user"
        assert result[1]["content"] is None
