"""
User simulator agent module for generating realistic user interactions.

This module provides the UserSimulatorAgent class, which simulates human user
behavior in conversations with agents under test. The simulator generates
contextually appropriate user messages based on the scenario description and
conversation history.
"""

import logging
from typing import Optional, cast

from litellm import Choices, completion
from litellm.files.main import ModelResponse

from scenario.cache import scenario_cache
from scenario.agent_adapter import AgentAdapter
from scenario._utils.utils import reverse_roles
from scenario.config import ModelConfig, ScenarioConfig

from ._error_messages import agent_not_configured_error_message
from .types import AgentInput, AgentReturnTypes, AgentRole


logger = logging.getLogger("scenario")


class UserSimulatorAgent(AgentAdapter):
    """
    Agent that simulates realistic user behavior in scenario conversations.

    This agent generates user messages that are appropriate for the given scenario
    context, simulating how a real human user would interact with the agent under test.
    It uses an LLM to generate natural, contextually relevant user inputs that help
    drive the conversation forward according to the scenario description.

    Attributes:
        role: Always AgentRole.USER for user simulator agents
        model: LLM model identifier to use for generating user messages
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for response generation
        max_tokens: Maximum tokens to generate in user messages
        system_prompt: Custom system prompt to override default user simulation behavior

    Example:
        ```
        import scenario

        # Basic user simulator with default behavior
        user_sim = scenario.UserSimulatorAgent(
            model="openai/gpt-4.1-mini"
        )

        # Customized user simulator
        custom_user_sim = scenario.UserSimulatorAgent(
            model="openai/gpt-4.1-mini",
            temperature=0.3,
            system_prompt="You are a technical user who asks detailed questions"
        )

        # Use in scenario
        result = await scenario.run(
            name="user interaction test",
            description="User seeks help with Python programming",
            agents=[
                my_programming_agent,
                user_sim,
                scenario.JudgeAgent(criteria=["Provides helpful code examples"])
            ]
        )
        ```

    Note:
        - The user simulator automatically generates short, natural user messages
        - It follows the scenario description to stay on topic
        - Messages are generated in a casual, human-like style (lowercase, brief, etc.)
        - The simulator will not act as an assistant - it only generates user inputs
    """
    role = AgentRole.USER

    model: str
    api_key: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    system_prompt: Optional[str]

    def __init__(
        self,
        *,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
    ):
        """
        Initialize a user simulator agent.

        Args:
            model: LLM model identifier (e.g., "openai/gpt-4.1-mini").
                   If not provided, uses the default model from global configuration.
            api_key: API key for the model provider. If not provided,
                     uses the key from global configuration or environment.
            temperature: Sampling temperature for message generation (0.0-1.0).
                        Lower values make responses more deterministic.
            max_tokens: Maximum number of tokens to generate in user messages.
                       If not provided, uses model defaults.
            system_prompt: Custom system prompt to override default user simulation behavior.
                          Use this to create specialized user personas or behaviors.

        Raises:
            Exception: If no model is configured either in parameters or global config

        Example:
            ```
            # Basic user simulator
            user_sim = UserSimulatorAgent(model="openai/gpt-4.1-mini")

            # User simulator with custom persona
            expert_user = UserSimulatorAgent(
                model="openai/gpt-4.1-mini",
                temperature=0.2,
                system_prompt='''
                You are an expert software developer testing an AI coding assistant.
                Ask challenging, technical questions and be demanding about code quality.
                '''
            )
            ```
        """
        # Override the default system prompt for the user simulator agent
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt

        if model:
            self.model = model

        if ScenarioConfig.default_config is not None and isinstance(
            ScenarioConfig.default_config.default_model, str
        ):
            self.model = model or ScenarioConfig.default_config.default_model
        elif ScenarioConfig.default_config is not None and isinstance(
            ScenarioConfig.default_config.default_model, ModelConfig
        ):
            self.model = model or ScenarioConfig.default_config.default_model.model
            self.api_key = (
                api_key or ScenarioConfig.default_config.default_model.api_key
            )
            self.temperature = (
                temperature or ScenarioConfig.default_config.default_model.temperature
            )
            self.max_tokens = (
                max_tokens or ScenarioConfig.default_config.default_model.max_tokens
            )

        if not hasattr(self, "model"):
            raise Exception(agent_not_configured_error_message("TestingAgent"))

    @scenario_cache()
    async def call(
        self,
        input: AgentInput,
    ) -> AgentReturnTypes:
        """
        Generate the next user message in the conversation.

        This method analyzes the current conversation state and scenario context
        to generate an appropriate user message that moves the conversation forward
        in a realistic, human-like manner.

        Args:
            input: AgentInput containing conversation history and scenario context

        Returns:
            AgentReturnTypes: A user message in OpenAI format that continues the conversation

        Note:
            - Messages are generated in a casual, human-like style
            - The simulator follows the scenario description to stay contextually relevant
            - Uses role reversal internally to work around LLM biases toward assistant roles
            - Results are cached when cache_key is configured for deterministic testing
        """

        scenario = input.scenario_state

        messages = [
            {
                "role": "system",
                "content": self.system_prompt
                or f"""
<role>
You are pretending to be a user, you are testing an AI Agent (shown as the user role) based on a scenario.
Approach this naturally, as a human user would, with very short inputs, few words, all lowercase, imperative, not periods, like when they google or talk to chatgpt.
</role>

<goal>
Your goal (assistant) is to interact with the Agent Under Test (user) as if you were a human user to see if it can complete the scenario successfully.
</goal>

<scenario>
{scenario.description}
</scenario>

<rules>
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user
</rules>
""",
            },
            {"role": "assistant", "content": "Hello, how can I help you today?"},
            *input.messages,
        ]

        # User to assistant role reversal
        # LLM models are biased to always be the assistant not the user, so we need to do this reversal otherwise models like GPT 4.5 is
        # super confused, and Claude 3.7 even starts throwing exceptions.
        messages = reverse_roles(messages)

        response = cast(
            ModelResponse,
            completion(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                tools=[],
            ),
        )

        # Extract the content from the response
        if hasattr(response, "choices") and len(response.choices) > 0:
            message = cast(Choices, response.choices[0]).message

            message_content = message.content
            if message_content is None:
                raise Exception(f"No response from LLM: {response.__repr__()}")

            return {"role": "user", "content": message_content}
        else:
            raise Exception(
                f"Unexpected response format from LLM: {response.__repr__()}"
            )
