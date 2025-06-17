![scenario](https://github.com/langwatch/scenario/raw/main/assets/scenario-wide.webp)

<div align="center">
<!-- Discord, PyPI, Docs, etc links -->
</div>

# Scenario

Scenario is an Agent Testing Framework for testing AI agents through Simulation Testing.

You define the conversation scenario and let it play out, it will keep chatting back and forth with _your_ agent until it reaches the desired goal or detects an unexpected behavior based on the criteria you defined.

- Test your agents end-to-end conversations with specified scenarios to capture both happy paths and edge cases
- Full flexibility of how much you want to guide the conversation, from fully scripted scenarios to completely automated simulations
- Run evaluations at any point of the conversation, designed for multi-turn
- Works in combination with any testing and LLM evaluation frameworks, completely agnostic
- Works with any LLM and Agent Framework, easy integration

[📺 Video Tutorial](https://www.youtube.com/watch?v=f8NLpkY0Av4)

### See also

- [Scenario TypeScript](https://github.com/langwatch/scenario-ts/)
- [Scenario Go](https://github.com/langwatch/scenario-go/)

## Example

```python
@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_weather_agent():
    # Integrate with your agent
    class WeatherAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return weather_agent(input.messages)

    # Define any custom assertions
    def check_for_weather_tool_call(state: scenario.ScenarioState):
        assert state.has_tool_call("get_current_weather")

    # Run the scenario
    result = await scenario.run(
        name="checking the weather",
        description="""
            The user is planning a boat trip from Barcelona to Rome,
            and is wondering what the weather will be like.
        """,
        agents=[
            WeatherAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini"),
        ],
        script=[
            scenario.user(),
            scenario.agent(),
            check_for_weather_tool_call, # check for tool call after the first agent response
            scenario.succeed(),
        ],
    )

    # Assert the simulation was successful
    assert result.success
```

> [!NOTE]
> This is a very basic example, keep reading to see how to run a simulation completely script-free, using a Judge Agent to evaluate in real-time.

Check out more examples in the [examples folder](./examples/).

## Getting Started

Install pytest and scenario:

```bash
pip install pytest langwatch-scenario
```

Now create your first scenario and save it as `tests/test_vegetarian_recipe_agent.py`, copy the full working example below:

```python
import pytest
import scenario
import litellm

scenario.configure(default_model="openai/gpt-4.1-mini")


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_vegetarian_recipe_agent():
    class Agent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return vegetarian_recipe_agent(input.messages)

    # Run a simulation scenario
    result = await scenario.run(
        name="dinner idea",
        description="""
            It's saturday evening, the user is very hungry and tired,
            but have no money to order out, so they are looking for a recipe.
        """,
        agents=[
            Agent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "Agent should not ask more than two follow-up questions",
                    "Agent should generate a recipe",
                    "Recipe should include a list of ingredients",
                    "Recipe should include step-by-step cooking instructions",
                    "Recipe should be vegetarian and not include any sort of meat",
                ]
            ),
        ],
    )

    # Assert for pytest to know whether the test passed
    assert result.success


# Example agent implementation
import litellm


@scenario.cache()
def vegetarian_recipe_agent(messages) -> scenario.AgentReturnTypes:
    response = litellm.completion(
        model="openai/gpt-4.1-mini",
        messages=[
            {
                "role": "system",
                "content": """
                    You are a vegetarian recipe agent.
                    Given the user request, ask AT MOST ONE follow-up question,
                    then provide a complete recipe. Keep your responses concise and focused.
                """,
            },
            *messages,
        ],
    )

    return response.choices[0].message  # type: ignore
```

Create a `.env` file and put your OpenAI API key in it:

```bash
OPENAI_API_KEY=<your-api-key>
```

Now run it with pytest:

```bash
pytest -s tests/test_vegetarian_recipe_agent.py
```

This is how it will look like:

[![asciicast](https://asciinema.org/a/nvO5GWGzqKTTCd8gtNSezQw11.svg)](https://asciinema.org/a/nvO5GWGzqKTTCd8gtNSezQw11)

You can find the same code example in [examples/test_vegetarian_recipe_agent.py](examples/test_vegetarian_recipe_agent.py).

## Script-free Simulation

By providing a User Simulator Agent and a description of the Scenario, the simulated user will automatically generate messages to the agent until the scenario is successful or the maximum number of turns is reached.

You can then use a Judge Agent to evaluate the scenario in real-time given certain criteria, at every turn, the Judge Agent will decide if it should let the simulation proceed or end it with a verdict.

You can combine it with a script, to control for example the beginning of the conversation, or simply let it run scriptless, this is very useful to test an open case like a vibe coding assistant:

```python
result = await scenario.run(
    name="dog walking startup landing page",
    description="""
        the user wants to create a new landing page for their dog walking startup

        send the first message to generate the landing page, then a single follow up request to extend it, then give your final verdict
    """,
    agents=[
        LovableAgentAdapter(template_path=template_path),
        scenario.UserSimulatorAgent(),
        scenario.JudgeAgent(
            criteria=[
                "agent reads the files before go and making changes",
                "agent modified the index.css file, not only the Index.tsx file",
                "agent created a comprehensive landing page",
                "agent extended the landing page with a new section",
                "agent should NOT say it can't read the file",
                "agent should NOT produce incomplete code or be too lazy to finish",
            ],
        ),
    ],
    max_turns=5, # optional
)
```

Check out the fully working Lovable Clone example in [examples/test_lovable_clone.py](examples/test_lovable_clone.py).

## Full Control of the Conversation

You can specify a script for guiding the scenario by passing a list of steps to the `script` field, those steps are simply arbitrary functions that take the current state of the scenario as an argument, so you can do things like:

- Control what the user says, or let it be generated automatically
- Control what the agent says, or let it be generated automatically
- Add custom assertions, for example making sure a tool was called
- Add a custom evaluation, from an external library
- Let the simulation proceed for a certain number of turns, and evaluate at each new turn
- Trigger the judge agent to decide on a verdict
- Add arbitrary messages like mock tool calls in the middle of the conversation

Everything is possible, using the same simple structure:

```python
@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_ai_assistant_agent():
    scenario = Scenario(
        name="false assumptions",
        description="""
            The agent makes false assumption that the user is talking about an ATM bank, and user corrects it that they actually mean river banks
        """,
        agent=AiAssistantAgentAdapter,
        criteria=[
            "user should get good recommendations on river crossing",
            "agent should NOT follow up about ATM recommendation after user has corrected them they are just hiking",
        ],
        max_turns=5,
    )

    def check_if_tool_was_called(state: ScenarioExecutor) -> None:
        assert state.has_tool_call("web_search")

    result = await scenario.script(
        [
            # Define existing history of messages
            scenario.user("how do I safely approach a bank?"),

            # Or let it be generate automatically
            scenario.agent(),

            # Add custom assertions, for example making sure a tool was called
            check_if_tool_was_called,

            # Another user message
            scenario.user(),

            # Let the simulation proceed for 2 more turns, print at every turn
            scenario.proceed(
                turns=2,
                on_turn=lambda state: print(f"Turn {state.current_turn}: {state.messages}"),
            ),

            # Time to make a judgment call
            scenario.judge(),
        ]
    ).run()

    assert result.success
```

## Debug mode

You can enable debug mode by setting the `debug` field to `True` in the `Scenario.configure` method or in the specific scenario you are running, or by passing the `--debug` flag to pytest.

Debug mode allows you to see the messages in slow motion step by step, and intervene with your own inputs to debug your agent from the middle of the conversation.

```python
Scenario.configure(testing_agent=TestingAgent(model="openai/gpt-4o-mini"), debug=True)
```

or

```bash
pytest -s tests/test_vegetarian_recipe_agent.py --debug
```

## Cache

Each time the scenario runs, the testing agent might chose a different input to start, this is good to make sure it covers the variance of real users as well, however we understand that the non-deterministic nature of it might make it less repeatable, costly and harder to debug. To solve for it, you can use the `cache_key` field in the `Scenario.configure` method or in the specific scenario you are running, this will make the testing agent give the same input for given the same scenario:

```python
Scenario.configure(testing_agent=TestingAgent(model="openai/gpt-4o-mini"), cache_key="42")
```

To bust the cache, you can simply pass a different `cache_key`, disable it, or delete the cache files located at `~/.scenario/cache`.

To go a step further and fully cache the test end-to-end, you can also wrap the LLM calls or any other non-deterministic functions in your application side with the `@scenario_cache` decorator:

```python
class MyAgent:
    @scenario_cache(ignore=["self"])
    def invoke(self, message, context):
        return client.chat.completions.create(
            # ...
        )
```

This will cache any function call you decorate when running the tests and make them repeatable, hashed by the function arguments, the scenario being executed, and the `cache_key` you provided. You can exclude arguments that should not be hashed for the cache key by naming them in the `ignore` argument.

## Disable Output

You can remove the `-s` flag from pytest to hide the output during test, which will only show up if the test fails. Alternatively, you can set `verbose=False` in the `Scenario.configure` method or in the specific scenario you are running.

## Running in parallel

As the number of your scenarios grows, you might want to run them in parallel to speed up your whole test suite. We suggest you to use the [pytest-asyncio-concurrent](https://pypi.org/project/pytest-asyncio-concurrent/) plugin to do so.

Simply install the plugin from the link above, then replace the `@pytest.mark.asyncio` annotation in the tests with `@pytest.mark.asyncio_concurrent`, adding a group name to it to mark the group of scenarions that should be run in parallel together, e.g.:

```python
@pytest.mark.agent_test
@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent")
async def test_vegetarian_recipe_agent():
    # ...

@pytest.mark.agent_test
@pytest.mark.asyncio_concurrent(group="vegetarian_recipe_agent")
async def test_user_is_very_hungry():
    # ...
```

Those two scenarios should now run in parallel.

## License

MIT License
