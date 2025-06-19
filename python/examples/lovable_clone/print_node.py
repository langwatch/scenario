from textwrap import indent
from typing import Any
from pydantic_ai import Agent
from pydantic_ai.agent import AgentRun
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPartDelta,
    ToolCallPartDelta,
    FinalResultEvent,
    TextPart,
)
from pydantic_graph.nodes import End
from pydantic_ai._agent_graph import AgentNode
import termcolor


async def print_node(run: AgentRun, node: AgentNode[Any, Any] | End[Any]):
    if Agent.is_user_prompt_node(node):
        # A user prompt node => The user has provided input
        pass
    elif Agent.is_model_request_node(node):
        async with node.stream(run.ctx) as request_stream:
            async for event in request_stream:
                if isinstance(event, PartStartEvent):
                    if isinstance(event.part, TextPart):
                        print(
                            f"{termcolor.colored('Agent:', 'blue')} {event.part.content}",
                            end="",
                        )
                    else:
                        pass
                elif isinstance(event, PartDeltaEvent):
                    if isinstance(event.delta, TextPartDelta):
                        print(
                            f"{event.delta.content_delta}",
                            end="",
                        )
                    elif isinstance(event.delta, ToolCallPartDelta):
                        # print(
                        #     f"\n[ToolCall({event.delta.tool_name_delta})] args={event.delta.args_delta}"
                        # )
                        pass
                elif isinstance(event, FinalResultEvent):
                    pass
    elif Agent.is_call_tools_node(node):
        async with node.stream(run.ctx) as handle_stream:
            async for event in handle_stream:
                if isinstance(event, FunctionToolCallEvent):
                    print(
                        f"\n{termcolor.colored('ToolCall(' + event.part.tool_name + '):', 'magenta')} {event.part.args}"
                    )
                elif isinstance(event, FunctionToolResultEvent):
                    lines = str(event.result.content).split("\n")
                    if len(lines) > 5:
                        lines = lines[:5] + ["..."]
                    lines = "\n".join(lines)

                    print(f"\n\n{indent(lines, ' ' * 4)}\n\n")
    elif Agent.is_end_node(node):
        assert run.result is not None
        assert run.result.data == node.data.data
