"""
Judge agent module for evaluating scenario conversations.

This module provides the JudgeAgent class, which evaluates ongoing conversations
between users and agents to determine if success criteria are met. The judge
makes real-time decisions about whether scenarios should continue or end with
success/failure verdicts.
"""

import json
import logging
import re
from typing import List, Optional, cast

from litellm import Choices, completion
from litellm.files.main import ModelResponse

from scenario.cache import scenario_cache
from scenario.agent_adapter import AgentAdapter
from scenario.config import ModelConfig, ScenarioConfig

from ._error_messages import agent_not_configured_error_message
from .types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


logger = logging.getLogger("scenario")


class JudgeAgent(AgentAdapter):
    """
    Agent that evaluates conversations against success criteria.

    The JudgeAgent watches conversations in real-time and makes decisions about
    whether the agent under test is meeting the specified criteria. It can either
    allow the conversation to continue or end it with a success/failure verdict.

    The judge uses function calling to make structured decisions and provides
    detailed reasoning for its verdicts. It evaluates each criterion independently
    and provides comprehensive feedback about what worked and what didn't.

    Attributes:
        role: Always AgentRole.JUDGE for judge agents
        model: LLM model identifier to use for evaluation
        api_base: Optional base URL where the model is hosted
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for evaluation consistency
        max_tokens: Maximum tokens for judge reasoning
        criteria: List of success criteria to evaluate against
        system_prompt: Custom system prompt to override default judge behavior

    Example:
        ```
        import scenario

        # Basic judge agent with criteria
        judge = scenario.JudgeAgent(
            criteria=[
                "Agent provides helpful responses",
                "Agent asks relevant follow-up questions",
                "Agent does not provide harmful information"
            ]
        )

        # Customized judge with specific model and behavior
        strict_judge = scenario.JudgeAgent(
            model="openai/gpt-4.1",
            criteria=[
                "Code examples are syntactically correct",
                "Explanations are technically accurate",
                "Security best practices are mentioned"
            ],
            temperature=0.0,  # More deterministic evaluation
            system_prompt="You are a strict technical reviewer evaluating code quality."
        )

        # Use in scenario
        result = await scenario.run(
            name="coding assistant test",
            description="User asks for help with Python functions",
            agents=[
                coding_agent,
                scenario.UserSimulatorAgent(),
                judge
            ]
        )

        print(f"Passed criteria: {result.passed_criteria}")
        print(f"Failed criteria: {result.failed_criteria}")
        ```

    Note:
        - Judge agents evaluate conversations continuously, not just at the end
        - They can end scenarios early if clear success/failure conditions are met
        - Provide detailed reasoning for their decisions
        - Support both positive criteria (things that should happen) and negative criteria (things that shouldn't)
    """

    role = AgentRole.JUDGE

    model: str
    api_base: Optional[str]
    api_key: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    criteria: List[str]
    system_prompt: Optional[str]

    def __init__(
        self,
        *,
        criteria: Optional[List[str]] = None,
        model: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
    ):
        """
        Initialize a judge agent with evaluation criteria.

        Args:
            criteria: List of success criteria to evaluate the conversation against.
                     Can include both positive requirements ("Agent provides helpful responses")
                     and negative constraints ("Agent should not provide personal information").
            model: LLM model identifier (e.g., "openai/gpt-4.1").
                   If not provided, uses the default model from global configuration.
            api_base: Optional base URL where the model is hosted. If not provided,
                      uses the base URL from global configuration.
            api_key: API key for the model provider. If not provided,
                     uses the key from global configuration or environment.
            temperature: Sampling temperature for evaluation (0.0-1.0).
                        Lower values (0.0-0.2) recommended for consistent evaluation.
            max_tokens: Maximum number of tokens for judge reasoning and explanations.
            system_prompt: Custom system prompt to override default judge behavior.
                          Use this to create specialized evaluation perspectives.

        Raises:
            Exception: If no model is configured either in parameters or global config

        Example:
            ```
            # Customer service judge
            cs_judge = JudgeAgent(
                criteria=[
                    "Agent replies with the refund policy",
                    "Agent offers next steps for the customer",
                ],
                temperature=0.1
            )

            # Technical accuracy judge
            tech_judge = JudgeAgent(
                criteria=[
                    "Agent adds a code review pointing out the code compilation errors",
                    "Agent adds a code review about the missing security headers"
                ],
                system_prompt="You are a senior software engineer reviewing code for production use."
            )
            ```
        """
        # Override the default system prompt for the judge agent
        self.criteria = criteria or []
        self.api_base = api_base
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
            self.api_base = (
                api_base or ScenarioConfig.default_config.default_model.api_base
            )
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
        Evaluate the current conversation state against the configured criteria.

        This method analyzes the conversation history and determines whether the
        scenario should continue or end with a verdict. It uses function calling
        to make structured decisions and provides detailed reasoning.

        Args:
            input: AgentInput containing conversation history and scenario context

        Returns:
            AgentReturnTypes: Either an empty list (continue scenario) or a
                            ScenarioResult (end scenario with verdict)

        Raises:
            Exception: If the judge cannot make a valid decision or if there's an
                      error in the evaluation process

        Note:
            - Returns empty list [] to continue the scenario
            - Returns ScenarioResult to end with success/failure
            - Provides detailed reasoning for all decisions
            - Evaluates each criterion independently
            - Can end scenarios early if clear violation or success is detected
        """

        scenario = input.scenario_state

        criteria_str = "\n".join(
            [f"{idx + 1}. {criterion}" for idx, criterion in enumerate(self.criteria)]
        )

        messages = [
            {
                "role": "system",
                "content": self.system_prompt
                or f"""
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to determine if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to determine if you already have enough information to make a verdict of the scenario below, or if the conversation should continue for longer.
If you do have enough information, use the finish_test tool to determine if all the criteria have been met, if not, use the continue_test tool to let the next step play out.
</goal>

<scenario>
{scenario.description}
</scenario>

<criteria>
{criteria_str}
</criteria>

<rules>
- Be strict, do not let the conversation continue if the agent already broke one of the "do not" or "should not" criterias.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
</rules>
""",
            },
            *input.messages,
        ]

        is_last_message = (
            input.scenario_state.current_turn == input.scenario_state.config.max_turns
        )

        if is_last_message:
            messages.append(
                {
                    "role": "user",
                    "content": """
System:

<finish_test>
This is the last message, conversation has reached the maximum number of turns, give your final verdict,
if you don't have enough information to make a verdict, say inconclusive with max turns reached.
</finish_test>
""",
                }
            )

        # Define the tools
        criteria_names = [
            re.sub(
                r"[^a-zA-Z0-9]",
                "_",
                criterion.replace(" ", "_").replace("'", "").lower(),
            )[:70]
            for criterion in self.criteria
        ]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "continue_test",
                    "description": "Continue the test with the next step",
                    "strict": True,
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": [],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "finish_test",
                    "description": "Complete the test with a final verdict",
                    "strict": True,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "criteria": {
                                "type": "object",
                                "properties": {
                                    criteria_names[idx]: {
                                        "enum": [True, False, "inconclusive"],
                                        "description": criterion,
                                    }
                                    for idx, criterion in enumerate(self.criteria)
                                },
                                "required": criteria_names,
                                "additionalProperties": False,
                                "description": "Strict verdict for each criterion",
                            },
                            "reasoning": {
                                "type": "string",
                                "description": "Explanation of what the final verdict should be",
                            },
                            "verdict": {
                                "type": "string",
                                "enum": ["success", "failure", "inconclusive"],
                                "description": "The final verdict of the test",
                            },
                        },
                        "required": ["criteria", "reasoning", "verdict"],
                        "additionalProperties": False,
                    },
                },
            },
        ]

        enforce_judgment = input.judgment_request
        has_criteria = len(self.criteria) > 0

        if enforce_judgment and not has_criteria:
            return ScenarioResult(
                success=False,
                messages=[],
                reasoning="TestingAgent was called as a judge, but it has no criteria to judge against",
            )

        response = cast(
            ModelResponse,
            completion(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                api_key=self.api_key,
                api_base=self.api_base,
                max_tokens=self.max_tokens,
                tools=tools,
                tool_choice=(
                    {"type": "function", "function": {"name": "finish_test"}}
                    if (is_last_message or enforce_judgment) and has_criteria
                    else "required"
                ),
            ),
        )

        # Extract the content from the response
        if hasattr(response, "choices") and len(response.choices) > 0:
            message = cast(Choices, response.choices[0]).message

            # Check if the LLM chose to use the tool
            if message.tool_calls:
                tool_call = message.tool_calls[0]
                if tool_call.function.name == "continue_test":
                    return []

                if tool_call.function.name == "finish_test":
                    # Parse the tool call arguments
                    try:
                        args = json.loads(tool_call.function.arguments)
                        verdict = args.get("verdict", "inconclusive")
                        reasoning = args.get("reasoning", "No reasoning provided")
                        criteria = args.get("criteria", {})

                        passed_criteria = [
                            self.criteria[idx]
                            for idx, criterion in enumerate(criteria.values())
                            if criterion == True
                        ]
                        failed_criteria = [
                            self.criteria[idx]
                            for idx, criterion in enumerate(criteria.values())
                            if criterion == False
                        ]

                        # Return the appropriate ScenarioResult based on the verdict
                        return ScenarioResult(
                            success=verdict == "success" and len(failed_criteria) == 0,
                            messages=messages,
                            reasoning=reasoning,
                            passed_criteria=passed_criteria,
                            failed_criteria=failed_criteria,
                        )
                    except json.JSONDecodeError:
                        raise Exception(
                            f"Failed to parse tool call arguments from judge agent: {tool_call.function.arguments}"
                        )

                else:
                    raise Exception(
                        f"Invalid tool call from judge agent: {tool_call.function.name}"
                    )

            else:
                raise Exception(
                    f"Invalid response from judge agent, tool calls not found: {message.__repr__()}"
                )

        else:
            raise Exception(
                f"Unexpected response format from LLM: {response.__repr__()}"
            )
