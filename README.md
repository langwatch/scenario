![scenario](https://github.com/langwatch/scenario/raw/main/assets/scenario-wide.webp)

<div align="center">
<!-- Discord, PyPI, Docs, etc links -->
</div>

# Scenario: Use an Agent to test your Agent

Scenario is a library for testing agents end-to-end as a human would, but without having to manually do it. The automated testing agent covers every single scenario for you.

You define the scenarios, and the testing agent will simulate your users as it follows them, it will keep chatting and evaluating your agent until it reaches the desired goal or detects an unexpected behavior.

## Getting Started

Install pytest and scenario:

```bash
pip install pytest langwatch-scenario
```

Now create your first scenario:

```python
import pytest

from scenario import Scenario, TestingAgent

Scenario.configure(testing_agent=TestingAgent(model="openai/gpt-4o-mini"))


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_vegetarian_recipe_agent():
    def vegetarian_recipe_agent(message, context):
        # Call your agent here
        response = "<Your agent's response>"

        return {"message": response}

    scenario = Scenario(
        "User is looking for a dinner idea",
        agent=vegetarian_recipe_agent,
        success_criteria=[
            "Recipe agent generates a vegetarian recipe",
            "Recipe includes step-by-step cooking instructions",
        ],
        failure_criteria=[
            "The recipe includes meat",
            "The agent asks more than two follow-up questions",
        ],
    )

    result = await scenario.run()

    assert result.success
```

Save it as `tests/test_vegetarian_recipe_agent.py` and run it with pytest:

```bash
pytest -s tests/test_vegetarian_recipe_agent.py
```

Once you connect to callback to a real agent, this is how it will look like:

[![asciicast](https://asciinema.org/a/nvO5GWGzqKTTCd8gtNSezQw11.svg)](https://asciinema.org/a/nvO5GWGzqKTTCd8gtNSezQw11)

You can find a fully working example in [examples/test_vegetarian_recipe_agent.py](examples/test_vegetarian_recipe_agent.py).

## Customize strategy and max_turns

You can customize how should the testing agent go about testing by defining a `strategy` field. You can also limit the maximum number of turns the scenario will take by setting the `max_turns` field (defaults to 10).

For example, in this Lovable Clone scenario test:

```python
scenario = Scenario(
    "user wants to create a new landing page for their dog walking startup",
    agent=lovable_agent,
    strategy="send the first message to generate the landing page, then a single follow up request to extend it, then give your final verdict",
    success_criteria=[
        "agent reads the files before go and making changes",
        "agent modified the index.css file",
        "agent modified the Index.tsx file",
        "agent created a comprehensive landing page",
        "agent extended the landing page with a new section",
    ],
    failure_criteria=[
        "agent says it can't read the file",
        "agent produces incomplete code or is too lazy to finish",
    ],
    max_turns=5,
)

result = await scenario.run()
```

You can find a fully working Lovable Clone example in [examples/test_lovable_clone.py](examples/test_lovable_clone.py).

## Debug mode

You can enable debug mode by setting the `debug` field to `True` in the `Scenario.configure` method or in the specific scenario you are running.

Debug mode allows you to see the messages in slow motion step by step, and intervene with your own inputs to debug your agent from the middle of the conversation.

```python
Scenario.configure(testing_agent=TestingAgent(model="openai/gpt-4o-mini"), debug=True)
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
