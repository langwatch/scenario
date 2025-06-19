from textwrap import indent
from typing import Any
import termcolor


def agent_not_configured_error_message(class_name: str):
    return f"""

 {termcolor.colored("->", "cyan")} {class_name} was initialized without a model, please set the model when defining the testing agent, for example:

    {class_name}(model="openai/gpt-4.1-mini")
    {termcolor.colored("^" * (29 + len(class_name)), "green")}

 {termcolor.colored("->", "cyan")} Alternatively, you can set the default model globally, for example:

    scenario.configure(default_model="openai/gpt-4.1-mini")
    {termcolor.colored("^" * 55, "green")}
"""


def message_return_error_message(got: Any, class_name: str):
    got_ = repr(got)
    if len(got_) > 100:
        got_ = got_[:100] + "..."

    return f"""
 {termcolor.colored("->", "cyan")} On the {termcolor.colored("call", "green")} method of the {class_name} agent adapter, you returned:

{indent(got_, ' ' * 4)}

 {termcolor.colored("->", "cyan")} But the adapter should return either a string, a dict on the OpenAI messages format, or a list of messages in the OpenAI messages format so the testing agent can understand what happened. For example:

    class MyAgentAdapter(ScenarioAgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            response = call_my_agent(message)

            return response.output_text
            {termcolor.colored("^" * 27, "green")}

 {termcolor.colored("->", "cyan")} Alternatively, you can return a list of messages in OpenAI messages format, this is useful for capturing tool calls and other before the final response:

    class MyAgentAdapter(ScenarioAgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            response = call_my_agent(message)

            return [
                {{"role": "assistant", "content": response.output_text}},
                {termcolor.colored("^" * 55, "green")}
            ]
"""


def message_invalid_agent_type(got: Any):
    got_ = repr(got)
    if len(got_) > 100:
        got_ = got_[:100] + "..."

    return f"""
 {termcolor.colored("->", "cyan")} The {termcolor.colored("agent", "green")} argument of Scenario needs to receive a class that inherits from {termcolor.colored("ScenarioAgentAdapter", "green")}, but you passed:

{indent(got_, ' ' * 4)}

 {termcolor.colored("->", "cyan")} Instead, wrap your agent in a ScenarioAgentAdapter subclass. For example:

    class MyAgentAdapter(ScenarioAgentAdapter):
    {termcolor.colored("^" * 43, "green")}
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            response = call_my_agent(message)

            return response.output_text

 {termcolor.colored("->", "cyan")} And then you can use that on your scenario definition:

    @pytest.mark.agent_test
    def test_my_agent():
        scenario = Scenario(
            name="first scenario",
            description=\"\"\"
                Example scenario description to test your agent.
            \"\"\",
            agent=MyAgentAdapter,
            {termcolor.colored("^" * 20, "green")}
            criteria=[
                "Requirement One",
                "Requirement Two",
            ],
        )
        result = scenario.run()

        assert result.success
"""


def agent_response_not_awaitable(class_name: str):
    return f"""
 {termcolor.colored("->", "cyan")} The {termcolor.colored("call", "green")} method of the {class_name} agent adapter returned a non-awaitable response, you probably forgot to add the {termcolor.colored("async", "green")} keyword to the method definition, make sure your code looks like this:

    class {class_name}(ScenarioAgentAdapter):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
        {termcolor.colored("^" * 5, "green")}
            response = call_my_agent(message)

            return response.output_text
"""
