"""
Agent package — public API surface.

Importing from .agent in main.py gives exactly what it used to:
    from .agent import AgentRequest, AgentResponse, run_agent
plus the new streaming entry point:
    from .agent import run_agent_stream
"""

from .models import AgentRequest, AgentResponse, ChatMessage
from .loop import run_agent, run_agent_stream

__all__ = [
    "AgentRequest",
    "AgentResponse",
    "ChatMessage",
    "run_agent",
    "run_agent_stream",
]
