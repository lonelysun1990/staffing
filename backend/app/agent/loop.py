"""
Agent loop implementations.

run_agent       — synchronous, single-round (legacy, kept for backward compat)
run_agent_stream — async generator, proper multi-turn agentic loop with SSE streaming
"""

from __future__ import annotations

import json
import os
from typing import AsyncGenerator, Optional

from sqlalchemy.orm import Session

from .chat_storage import (
    auto_title_session,
    create_session,
    get_session,
    load_session_messages,
    maybe_summarize,
    save_message,
)
from .context import build_system_prompt
from .executor import _dispatch_tool
from .models import AgentRequest, AgentResponse
from .sse import sse
from .tools import READ_ONLY_TOOLS, TOOLS

MODEL = "gpt-4o"
MAX_ITERATIONS = 8


# ---------------------------------------------------------------------------
# Synchronous loop (legacy — preserves existing /agent/chat behavior)
# ---------------------------------------------------------------------------

def run_agent(request: AgentRequest, db: Session) -> AgentResponse:
    """Single-round synchronous agent. Kept for backward compatibility."""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return AgentResponse(
            reply="OpenAI API key is not configured. Please add OPENAI_API_KEY to backend/.env.",
            data_changed=False,
        )

    try:
        from openai import OpenAI
    except ImportError:
        return AgentResponse(
            reply="openai package is not installed. Run: pip install openai",
            data_changed=False,
        )

    client = OpenAI(api_key=api_key)
    messages: list[dict] = [{"role": "system", "content": build_system_prompt(db)}]
    messages += [{"role": m.role, "content": m.content} for m in request.messages]

    data_changed = False
    response = client.chat.completions.create(model=MODEL, tools=TOOLS, messages=messages)
    msg = response.choices[0].message

    if not msg.tool_calls:
        return AgentResponse(reply=msg.content or "", data_changed=False)

    messages.append(msg.model_dump(exclude_none=True))
    tool_results = []
    clarification_reply: Optional[str] = None

    for tc in msg.tool_calls:
        args = json.loads(tc.function.arguments)
        result = _dispatch_tool(tc.function.name, args, db)

        if result.startswith("CLARIFICATION_NEEDED:"):
            clarification_reply = result[len("CLARIFICATION_NEEDED:"):].strip()
        elif result.startswith("OK:") and tc.function.name not in READ_ONLY_TOOLS:
            data_changed = True

        tool_results.append({"role": "tool", "tool_call_id": tc.id, "content": result})

    if clarification_reply:
        return AgentResponse(reply=clarification_reply, data_changed=data_changed)

    messages += tool_results
    follow_up = client.chat.completions.create(model=MODEL, messages=messages)
    return AgentResponse(reply=follow_up.choices[0].message.content or "Done.", data_changed=data_changed)


# ---------------------------------------------------------------------------
# Async streaming loop (new — /agent/chat/stream)
# ---------------------------------------------------------------------------

async def run_agent_stream(
    request: AgentRequest,
    db: Session,
    user_id: Optional[int] = None,
) -> AsyncGenerator[str, None]:
    """
    Agentic loop with SSE streaming and optional session persistence.

    When request.session_id is set, the conversation is loaded from DB and
    each turn is saved incrementally. When None, stateless behavior is used
    (identical to the original implementation).

    Yields SSE-formatted strings. The loop continues calling the model until it
    produces a text-only reply (no tool calls), or until MAX_ITERATIONS is reached.

    Event types emitted:
        text_delta      — streamed assistant text token
        tool_call_start — a tool is about to execute (full args available)
        tool_result     — tool execution complete
        done            — stream finished successfully (includes session_id)
        error           — unrecoverable failure
    """
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        yield sse("error", {"message": "OpenAI API key is not configured."})
        return

    try:
        from openai import AsyncOpenAI
    except ImportError:
        yield sse("error", {"message": "openai package is not installed. Run: pip install openai"})
        return

    client = AsyncOpenAI(api_key=api_key)

    # ---- Session setup ----
    session = None
    if request.session_id:
        session = get_session(db, request.session_id, user_id)
        if session is None:
            yield sse("error", {"message": f"Session {request.session_id} not found."})
            return

    # Build the initial messages list
    if session:
        # Load history from DB; only the last message from request is the new user message
        new_user_msg = request.messages[-1]
        loaded = load_session_messages(db, session)
        messages: list[dict] = [
            {"role": "system", "content": build_system_prompt(db, user_id, session.context_summary)}
        ]
        messages += loaded
        messages.append({"role": new_user_msg.role, "content": new_user_msg.content})
        # Persist the new user message immediately
        save_message(db, session, "user", new_user_msg.content)
        auto_title_session(db, session, new_user_msg.content)
    else:
        # Stateless fallback — original behavior
        messages = [{"role": "system", "content": build_system_prompt(db)}]
        messages += [{"role": m.role, "content": m.content} for m in request.messages]

    data_changed = False

    try:
        for iteration in range(MAX_ITERATIONS):
            # ---- Single model call with streaming ----
            stream = await client.chat.completions.create(
                model=MODEL,
                tools=TOOLS,
                messages=messages,
                stream=True,
            )

            assistant_text = ""
            # pending[index] = {"id": str, "name": str, "arguments": str}
            pending: dict[int, dict] = {}

            async for chunk in stream:
                choice = chunk.choices[0]
                delta = choice.delta

                # Stream text tokens immediately
                if delta.content:
                    assistant_text += delta.content
                    yield sse("text_delta", {"delta": delta.content})

                # Accumulate tool call argument chunks
                # (OpenAI sends name+id in first chunk, arguments across many chunks)
                for tc in delta.tool_calls or []:
                    idx = tc.index
                    if idx not in pending:
                        pending[idx] = {"id": tc.id or "", "name": tc.function.name or "", "arguments": ""}
                    else:
                        if tc.id:
                            pending[idx]["id"] = tc.id
                        if tc.function.name:
                            pending[idx]["name"] = tc.function.name
                    if tc.function.arguments:
                        pending[idx]["arguments"] += tc.function.arguments

            # ---- Turn complete: async for loop has exited ----

            # Append assistant turn to conversation history
            if pending:
                tool_calls_for_history = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in (pending[i] for i in sorted(pending))
                ]
                messages.append({
                    "role": "assistant",
                    "content": assistant_text or None,
                    "tool_calls": tool_calls_for_history,
                })
                if session:
                    save_message(db, session, "assistant", assistant_text or None,
                                 metadata=tool_calls_for_history)
            else:
                messages.append({"role": "assistant", "content": assistant_text})
                if session:
                    save_message(db, session, "assistant", assistant_text)

            # No tool calls → model is done; terminate the loop
            if not pending:
                if session:
                    await maybe_summarize(db, session, client, MODEL)
                yield sse("done", {
                    "data_changed": data_changed,
                    "session_id": session.id if session else None,
                })
                return

            # ---- Execute all tool calls for this turn ----
            for idx in sorted(pending):
                tc = pending[idx]
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}

                # Emit tool_call_start after full arg accumulation
                yield sse("tool_call_start", {
                    "tool_call_id": tc["id"],
                    "name": tc["name"],
                    "args": args,
                })

                result = _dispatch_tool(tc["name"], args, db, user_id=user_id)

                ok = not result.startswith("ERROR:")
                if result.startswith("OK:") and tc["name"] not in READ_ONLY_TOOLS:
                    data_changed = True

                yield sse("tool_result", {
                    "tool_call_id": tc["id"],
                    "name": tc["name"],
                    "result": result,
                    "ok": ok,
                })

                messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
                if session:
                    save_message(db, session, "tool", result,
                                 metadata={"tool_call_id": tc["id"], "name": tc["name"]})

            # Loop continues: model will see tool results and either call more tools or reply

        # Exhausted max iterations without a clean exit
        yield sse("error", {"message": f"Agent reached the maximum of {MAX_ITERATIONS} iterations."})

    except Exception as exc:
        yield sse("error", {"message": f"Agent error: {exc}"})
