from __future__ import annotations

from typing import List

from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AgentRequest(BaseModel):
    messages: List[ChatMessage]


class AgentResponse(BaseModel):
    reply: str
    data_changed: bool
