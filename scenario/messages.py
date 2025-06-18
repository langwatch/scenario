from typing import Union, Optional, List
from ag_ui.core import (
    UserMessage as AgUiUserMessage,
    AssistantMessage as AgUiAssistantMessage,
    SystemMessage as AgUiSystemMessage,
    ToolMessage as AgUiToolMessage,
    ToolCall as AgUiToolCall,
    FunctionCall as AgUiFunctionCall,
)

class UserMessage(AgUiUserMessage):
    """
    An AG-UI user message extended with the to_dict method.
    Enforces role='user' and requires content.
    """
    def __init__(self, id: str, content: str, name: Optional[str] = None):
        super().__init__(id=id, role="user", content=content, name=name)
        
    def to_dict(self):
        """Convert the UserMessage to a dictionary representation."""
        return self.model_dump(exclude_none=True)

class AssistantMessage(AgUiAssistantMessage):
    """
    An AG-UI assistant message extended with the to_dict method.
    Enforces role='assistant' and allows optional content and tool_calls.
    """
    def __init__(self, id: str, content: Optional[str] = None, tool_calls: Optional[List['ToolCall']] = None, name: Optional[str] = None):
        super().__init__(id=id, role="assistant", content=content, tool_calls=tool_calls, name=name)
        
    def to_dict(self):
        """Convert the AssistantMessage to a dictionary representation."""
        return self.model_dump(exclude_none=True)

class SystemMessage(AgUiSystemMessage):
    """
    An AG-UI system message extended with the to_dict method.
    Enforces role='system' and requires content.
    """
    def __init__(self, id: str, content: str, name: Optional[str] = None):
        super().__init__(id=id, role="system", content=content, name=name)
        
    def to_dict(self):
        """Convert the SystemMessage to a dictionary representation."""
        return self.model_dump(exclude_none=True)

class ToolMessage(AgUiToolMessage):
    """
    An AG-UI tool message extended with the to_dict method.
    Enforces role='tool' and requires content and tool_call_id.
    """
    def __init__(self, id: str, content: str, tool_call_id: str):
        super().__init__(id=id, role="tool", content=content, tool_call_id=tool_call_id)
        
    def to_dict(self):
        """Convert the ToolMessage to a dictionary representation."""
        return self.model_dump(exclude_none=True)

class ToolCall(AgUiToolCall):
    """
    An AG-UI tool call extended with the to_dict method.
    Enforces type='function' and requires id and function.
    """
    def __init__(self, id: str, function: 'FunctionCall'):
        super().__init__(id=id, type="function", function=function)
        
    def to_dict(self):
        """Convert the ToolCall to a dictionary representation."""
        return self.model_dump(exclude_none=True)

class FunctionCall(AgUiFunctionCall):
    """
    An AG-UI function call extended with the to_dict method.
    Requires name and arguments.
    """
    def __init__(self, name: str, arguments: str):
        super().__init__(name=name, arguments=arguments)
        
    def to_dict(self):
        """Convert the FunctionCall to a dictionary representation."""
        return self.model_dump(exclude_none=True)

# Union type alias for all message types
Message = Union[UserMessage, AssistantMessage, SystemMessage, ToolMessage, ToolCall, FunctionCall]
