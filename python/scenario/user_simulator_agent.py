"""
Simulate realistic user interactions using Scenario’s user simulator tools for robust agent testing

This module provides the UserSimulatorAgent class, which simulates human user
behavior in conversations with agents under test. The simulator generates
contextually appropriate user messages based on the scenario description and
conversation history.
"""

import logging
from contextlib import contextmanager
from typing import Callable, Iterator, List, Optional, cast

import litellm
from litellm import Choices
from litellm.files.main import ModelResponse

from scenario.cache import scenario_cache
from scenario.agent_adapter import AgentAdapter
from scenario._utils.utils import reverse_roles
from scenario.config import ModelConfig, ScenarioConfig

from ._error_messages import agent_not_configured_error_message
from .types import AgentInput, AgentReturnTypes, AgentRole


logger = logging.getLogger("scenario")


def _strip_audio_content(messages: list) -> list:
    """
    Remove audio content blocks from messages before sending to a text-only LLM.

    Voice turns use ``input_audio`` content parts (multimodal) which text-only
    models like ``gpt-4.1-mini`` reject with an "expected text or image_url"
    error.  This helper keeps ``text`` parts as-is and replaces audio-only
    messages with an ``[audio message]`` placeholder so the LLM still has a
    structural turn in the right position.

    Echo-safety (AC4): when an **assistant** message carries BOTH an
    ``input_audio`` part AND a ``text`` part, it is a voiced agent turn whose
    transcript was auto-surfaced by the realtime adapter. The simulator must NOT
    receive that text verbatim — after ``reverse_roles`` the assistant turn
    becomes a "user" turn, which the LLM reads as its own prior words and parrots
    back as the candidate's answer. Instead we reframe the text as third-person
    context ("the agent said: Q") so the simulator understands it as the OTHER
    party's utterance to respond to, not its own line.

    This reframing applies ONLY to the simulator's prompt view. The text part in
    ``result.messages`` is untouched — only the copy passed into the LLM call
    here is transformed. No dict-key markers are used; origin is identified
    structurally (assistant + audio + text = voiced agent turn). AC11 is
    satisfied by construction — no marker key ever appears on the message dict.
    """
    result = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            has_audio = any(
                isinstance(p, dict) and p.get("type") in ("input_audio", "audio")
                for p in content
            )
            text_parts = [
                p["text"]
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            if text_parts:
                joined = " ".join(text_parts)
                # Echo-safety: an assistant turn with BOTH audio and text parts
                # is a voiced agent turn (transcript auto-surfaced by the
                # realtime adapter). Reframe as third-person context so the
                # simulator sees it as the agent's utterance to answer, not its
                # own words to repeat. (AC4)
                if has_audio and msg.get("role") == "assistant":
                    joined = f"[the agent said: {joined}]"
                result.append({**msg, "content": joined})
            else:
                result.append({**msg, "content": "[audio message]"})
        else:
            result.append(msg)
    return result


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
        api_base: Optional base URL where the model is hosted
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
    api_base: Optional[str]
    api_key: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    system_prompt: Optional[str]
    _extra_params: dict

    def __init__(
        self,
        *,
        model: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
        voice: Optional[str] = None,
        persona: Optional[str] = None,
        audio_effects: Optional[List[Callable[[bytes], bytes]]] = None,
        interrupt_probability: float = 0.0,
        **extra_params,
    ):
        """
        Initialize a user simulator agent.

        Args:
            model: LLM model identifier (e.g., "openai/gpt-4.1-mini").
                   If not provided, uses the default model from global configuration.
            api_base: Optional base URL where the model is hosted. If not provided,
                      uses the base URL from global configuration.
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

        Note:
            Advanced usage: Additional parameters can be passed as keyword arguments
            (e.g., headers, timeout, client) for specialized configurations. These are
            experimental and may not be supported in future versions.
        """
        _temp_was_set = temperature is not None

        self.api_base = api_base
        self.api_key = api_key
        self.temperature = temperature if _temp_was_set else 0.0
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        # Voice support (§4.2): when voice is set, generated text is run through
        # TTS (cache key = (text, voice) per locked decision) and audio_effects
        # are applied AFTER the cache hit — effects never enter the cache.
        self.voice = voice
        self.persona = persona
        self.audio_effects: List[Callable[[bytes], bytes]] = audio_effects or []
        if not 0.0 <= interrupt_probability <= 1.0:
            raise ValueError("interrupt_probability must be in [0, 1]")
        self.interrupt_probability = interrupt_probability

        if model:
            self.model = model

        if ScenarioConfig.default_config is not None and isinstance(
            ScenarioConfig.default_config.default_model, str
        ):
            self.model = model or ScenarioConfig.default_config.default_model
            self._extra_params = extra_params
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
            if not _temp_was_set:
                self.temperature = (
                    ScenarioConfig.default_config.default_model.temperature or 0.0
                )
            self.max_tokens = (
                max_tokens or ScenarioConfig.default_config.default_model.max_tokens
            )
            # Extract extra params from ModelConfig
            config_dict = ScenarioConfig.default_config.default_model.model_dump(
                exclude_none=True
            )
            config_dict.pop("model", None)
            config_dict.pop("api_base", None)
            config_dict.pop("api_key", None)
            config_dict.pop("temperature", None)
            config_dict.pop("max_tokens", None)
            # Merge: config extras < agent extra_params
            self._extra_params = {**config_dict, **extra_params}
        else:
            self._extra_params = extra_params

        if not hasattr(self, "model"):
            raise Exception(agent_not_configured_error_message("UserSimulatorAgent"))

    async def call(
        self,
        input: AgentInput,
    ) -> AgentReturnTypes:
        text_message = await self._generate_text(input)
        if not self.voice:
            return text_message
        return await self._voiceify(text_message)  # type: ignore[arg-type]

    async def _voiceify(self, text_message: dict) -> AgentReturnTypes:
        """Convert a text user message into an audio message via TTS + effects."""
        from .voice import AudioChunk, create_audio_message, synthesize

        content = text_message.get("content", "")
        if not isinstance(content, str) or not content:
            return text_message  # type: ignore[return-value]
        if self._voice_style_override is not None:
            self._warn_voice_style_not_wired_once()
        chunk = await synthesize(content, self.voice)  # type: ignore[arg-type]
        audio_bytes = chunk.data
        effects = self._effective_audio_effects()
        for effect in effects:
            audio_bytes = effect(audio_bytes)
        final = AudioChunk(data=audio_bytes, transcript=content)
        return create_audio_message(final, role="user")

    # ---------------------------------------------- per-step overrides (§4.2)
    # Per-step voice_style / audio_effects overrides. The executor uses
    # ``_one_shot_override`` to install a single-turn override that is cleared
    # on exit so subsequent turns revert to the simulator's defaults.

    _voice_style_override: Optional[str] = None
    _audio_effects_override: Optional[List[Callable[[bytes], bytes]]] = None
    _voice_style_warning_emitted: bool = False

    @classmethod
    def _warn_voice_style_not_wired_once(cls) -> None:
        # Emit exactly one UserWarning per process the first time a user passes
        # voice_style. The flag is intentionally stored on the class so every
        # simulator instance shares the one-shot, matching the VAD fallback
        # pattern used elsewhere in the voice package.
        if cls._voice_style_warning_emitted:
            return
        import warnings

        cls._voice_style_warning_emitted = True
        warnings.warn(
            "voice_style=... is accepted for forward compatibility but no "
            "TTS provider currently honours it. The simulator will synthesise "
            "without style modification. This will land as a per-provider "
            "instructions channel in a follow-up.",
            UserWarning,
            stacklevel=2,
        )

    def _effective_audio_effects(self) -> List[Callable[[bytes], bytes]]:
        if self._audio_effects_override is not None:
            return list(self._audio_effects_override)
        return list(self.audio_effects)

    @contextmanager
    def _one_shot_override(
        self,
        *,
        voice_style: Optional[str] = None,
        audio_effects: Optional[List[Callable[[bytes], bytes]]] = None,
    ) -> Iterator[None]:
        prev_style = self._voice_style_override
        prev_effects = self._audio_effects_override
        self._voice_style_override = voice_style
        self._audio_effects_override = audio_effects
        try:
            yield
        finally:
            self._voice_style_override = prev_style
            self._audio_effects_override = prev_effects

    @scenario_cache()
    async def _generate_text(
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

        persona_block = (
            f"\n\n<persona>\n{self.persona}\n</persona>\n"
            if self.persona
            else ""
        )
        messages = [
            {
                "role": "system",
                "content": (self.system_prompt + persona_block) if self.system_prompt
                else (f"""
<role>
You are pretending to be a user, you are testing an AI Agent (shown as the user role) based on a scenario.
You are SPEAKING on a phone call — your words will be read aloud by text-to-speech — so talk the way a real person speaks aloud: in full, natural spoken sentences with normal capitalization and punctuation, full clauses, not telegraphic search-query fragments.
</role>

<goal>
Your goal (assistant) is to interact with the Agent Under Test (user) as if you were a human user to see if it can complete the scenario successfully.
</goal>

<scenario>
{scenario.description}
</scenario>

<rules>
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user, send the user message and just STOP.
</rules>
{persona_block}""" if self.voice else f"""
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
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user, send the user message and just STOP.
</rules>
{persona_block}"""),
            },
            {"role": "assistant", "content": "Hello, how can I help you today?"},
            *_strip_audio_content(input.messages),
        ]

        # User to assistant role reversal
        # LLM models are biased to always be the assistant not the user, so we need to do this reversal otherwise models like GPT 4.5 is
        # super confused, and Claude 3.7 even starts throwing exceptions.
        messages = reverse_roles(messages)

        response = cast(
            ModelResponse,
            litellm.completion(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                api_key=self.api_key,
                api_base=self.api_base,
                max_tokens=self.max_tokens,
                tools=[],
                **self._extra_params,
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
