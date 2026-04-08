from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class AgentRequest(BaseModel):
    messages: List[ChatMessage]
    session_id: Optional[int] = None   # None = stateless (backward-compatible)


class AgentResponse(BaseModel):
    reply: str
    data_changed: bool
