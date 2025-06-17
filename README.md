![scenario](https://github.com/langwatch/scenario/raw/main/assets/scenario-wide.webp)

# Scenario: Multi-language Agent Testing Framework

**Scenario** is an Agent Testing Framework for testing AI agents through Simulation Testing. Define conversation scenarios and let them play out—Scenario will simulate conversations with your agent, checking for success or unexpected behavior based on your criteria.

- Test agents end-to-end with specified scenarios (happy paths & edge cases)
- Scripted or fully automated simulations
- Run evaluations at any point in the conversation
- Works with any LLM and agent framework
- Language-agnostic: Python, JavaScript (TypeScript), and Go

[📺 Video Tutorial](https://www.youtube.com/watch?v=f8NLpkY0Av4)

---

## Supported Languages

- **Python**: [`/python`](./python/)  
  _See below for a quickstart!_
- **JavaScript/TypeScript**: [`/javascript`](./javascript/)
- **Go**: _Coming soon!_ [`/go`](./go/)

---

## Quickstart (Python)

Install:

```bash
pip install pytest langwatch-scenario
```

Example test (`test_vegetarian_recipe_agent.py`):

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
    assert result.success

# Example agent implementation
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

- Full docs: [`/python/README.md`](./python/README.md)

<details>
<summary>Quickstart (JavaScript/TypeScript)</summary>

</details>

<details>

---


## Other Languages

- **JavaScript/TypeScript**: [`/javascript`](./javascript/)
- **Go**: Coming soon at [`/go`](./go/)

---

## License

MIT License
