# Agent Harness Engineering

## Context

The current agent (`/backend/app/agent.py`) is a monolithic ~758-line file implementing a minimal single-round harness: one model call → one optional round of tool execution → one follow-up call → done. This has two problems:

1. **Capability**: The loop is capped at one tool-call round, so the agent can never plan multi-step actions (e.g. check availability → assign → verify conflicts). It's also synchronous with no streaming, so the UI blocks until the full response is ready.
2. **Maintainability**: All tool definitions, execution logic, utilities, and the loop are in one file. Adding a new tool means editing multiple sections of a long file with no clear seams.

The goal is to deliver four improvements simultaneously: a proper agentic loop, SSE streaming, tool call transparency in the UI, and four new tools — while restructuring the code into a package that makes future agent work straightforward.

---

## New Package Structure

`agent.py` is converted into a package `backend/app/agent/`:

```
backend/app/agent/
├── __init__.py      # Public API: run_agent, run_agent_stream, AgentRequest, AgentResponse
├── tools.py         # TOOLS list (OpenAI JSON schema definitions for all 9 tools)
├── executor.py      # _dispatch_tool + all _execute_* functions + resolve_name
├── context.py       # _build_snapshot, _build_system_prompt (reads DB, assembles context)
├── loop.py          # run_agent (sync/legacy) + run_agent_stream (async, new agentic loop)
└── sse.py           # _sse() helper, AgentStreamEvent TypedDict
```

**Adding a new tool in the future = 3 focused edits:**
1. `tools.py` — add the JSON schema entry
2. `executor.py` — add `_execute_<name>()` + one branch in `_dispatch_tool`
3. `context.py` — add to system prompt if the tool needs context

No other files need to change.

---

## The Agentic Loop (Explicit)

### Current behavior (single-round)
```
user message
  → model call #1 (with tools)
    → if tool calls: execute all serially (exactly 1 round)
      → model call #2 (follow-up)
        → return final text
    → else: return text from call #1
```
The agent cannot perform multi-step reasoning. If it needs to check availability first, then assign, then verify — it can't; it only gets one shot at tool use.

### New behavior (agentic loop, max 8 iterations)
```
user message
  └─ loop (up to 8 iterations):
       model call with streaming
         ├─ stream text_delta events as tokens arrive
         └─ if tool calls in response:
              for each tool call:
                emit tool_call_start event
                execute tool
                emit tool_result event
                append result to message history
              → continue loop (model sees results, may call more tools)
            else (no tool calls):
              emit done event
              stop
```

This enables natural multi-step plans like:
- "assign Alice 50% to Project X, then check if it creates any conflicts"
- "find who has Python skills, then assign the most available one to Project Y"
- "create a new project, then assign the team leads to it"

The 8-iteration cap prevents runaway loops. Each iteration = one model call.

---

## SSE Event Schema

```
data: {"type": "text_delta",      "delta": "..."}
data: {"type": "tool_call_start", "tool_call_id": "...", "name": "...", "args": {...}}
data: {"type": "tool_result",     "tool_call_id": "...", "name": "...", "result": "...", "ok": bool}
data: {"type": "done",            "data_changed": bool}
data: {"type": "error",           "message": "..."}
```

`tool_call_start` is emitted **after** full arg accumulation (OpenAI streams args as tiny chunks of partial JSON — emitting partials is noise). Terminal event is always `done` or `error`.

---

## Files to Change

| File | Change |
|---|---|
| `backend/app/agent.py` → `backend/app/agent/` | Convert to package with 6 modules |
| `backend/app/main.py` | Update import path; add `POST /agent/chat/stream` endpoint |
| `frontend/src/api.ts` | Add `AgentStreamEvent` type and `streamAgentMessage` async generator |
| `frontend/src/ChatPanel.tsx` | Switch to streaming, add tool step state/rendering |
| `frontend/src/App.css` | Tool step styles, streaming cursor |

---

## Step 1 — Create `backend/app/agent/` Package

Delete `agent.py` and create the package directory with 6 files.

### `sse.py`
```python
import json
from typing import AsyncGenerator

def sse(event_type: str, payload: dict) -> str:
    """Format a single SSE data line."""
    return f"data: {json.dumps({'type': event_type, **payload})}\n\n"
```

### `tools.py`
Contains the `TOOLS` list — all 9 tool JSON schemas (5 existing + 4 new).

**Existing (unchanged schemas):** `set_assignment`, `clear_assignment`, `get_availability`, `update_data_scientist`, `update_project`

**New tools to add:**
```python
# check_conflicts — no params; checks storage.get_conflicts()
# create_data_scientist — name, level, efficiency=1.0, max_concurrent_projects=2, notes?, skills?
# create_project — name, start_date (ISO), end_date (ISO), required_skills?
# suggest_data_scientists — project_name (partial match ok)
```

### `executor.py`
Contains `resolve_name()`, all `_execute_*` functions, and `_dispatch_tool`.

**Key new execute functions:**

```python
def _execute_check_conflicts(db: Session) -> str:
    # storage.get_conflicts(db) → List[dict] with keys:
    #   data_scientist_name, week_start, total_allocation, over_by
    conflicts = storage.get_conflicts(db)
    if not conflicts:
        return "OK: No conflicts. All allocations are within 100%."
    lines = [f"  {c['data_scientist_name']} on {c['week_start']}: "
             f"{c['total_allocation']:.0%} (over by {c['over_by']:.0%})"
             for c in conflicts]
    return "OK: Conflicts:\n" + "\n".join(lines)

def _execute_create_data_scientist(db, name, level, efficiency, max_concurrent_projects, notes, skills) -> str:
    # 1. resolve_name(name, existing_ds_names) — collision check → CLARIFICATION_NEEDED if match
    # 2. storage.create_data_scientist(db, DataScientistCreate(...))

def _execute_create_project(db, name, start_date_str, end_date_str, required_skills) -> str:
    # 1. Collision check
    # 2. Auto-generate weekly FTE rows at 1.0 between start_date and end_date
    # 3. storage.create_project(db, ProjectCreate(...))

def _execute_suggest_data_scientists(db, proj_name_query) -> str:
    # 1. resolve_name → project_id
    # 2. storage.get_skill_suggestions(db, project_id)  ← signature is (db, project_id: int)
    # 3. Format ranked list
```

**`_dispatch_tool`** — single place that maps tool name → execute function. Both the sync loop and async loop call this:
```python
READ_ONLY_TOOLS = {"get_availability", "check_conflicts", "suggest_data_scientists"}

def _dispatch_tool(fn_name: str, args: dict, db: Session) -> str:
    match fn_name:
        case "set_assignment": return _execute_set_assignment(db, ...)
        case "clear_assignment": return _execute_clear_assignment(db, ...)
        case "get_availability": return _execute_get_availability(db, ...)
        case "update_data_scientist": return _execute_update_data_scientist(db, ...)
        case "update_project": return _execute_update_project(db, ...)
        case "check_conflicts": return _execute_check_conflicts(db)
        case "create_data_scientist": return _execute_create_data_scientist(db, ...)
        case "create_project": return _execute_create_project(db, ...)
        case "suggest_data_scientists": return _execute_suggest_data_scientists(db, ...)
        case _: return f"ERROR: Unknown tool '{fn_name}'"
```

### `context.py`
Extracts `_build_snapshot()` and `_build_system_prompt()` from the current `run_agent`. Keeping DB snapshot logic separate makes it easy to change what context the agent receives.

```python
def build_system_prompt(db: Session) -> str:
    """Build the dynamic system prompt from current DB state."""
    # same logic as current run_agent lines 641–664
    # lists all DSs, projects, assignment summary, today's date, horizon
    # add new tool hints: create_data_scientist, create_project, check_conflicts, suggest_data_scientists
```

### `loop.py`
Two public functions: `run_agent` (sync, preserves existing behavior) and `run_agent_stream` (async, new agentic loop).

```python
# run_agent: unchanged behavior, just calls _dispatch_tool from executor.py
# run_agent_stream: the new async generator (see agentic loop section above)

async def run_agent_stream(request: AgentRequest, db: Session):
    """AsyncGenerator[str, None] — yields SSE-formatted strings."""
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=...)
    
    messages = [{"role": "system", "content": build_system_prompt(db)}]
    messages += [{"role": m.role, "content": m.content} for m in request.messages]
    
    data_changed = False
    MAX_ITERATIONS = 8

    try:
        for _ in range(MAX_ITERATIONS):
            # Stream one model call
            stream = await client.chat.completions.create(
                model="gpt-4o", tools=TOOLS, messages=messages, stream=True
            )
            
            assistant_text = ""
            pending: dict[int, dict] = {}  # index → {id, name, arguments}
            
            async for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    assistant_text += delta.content
                    yield sse("text_delta", {"delta": delta.content})
                for tc in (delta.tool_calls or []):
                    # accumulate chunks into pending[tc.index]
                    ...
            
            # Append assistant turn to history
            messages.append(build_assistant_message(assistant_text, pending))
            
            if not pending:
                # Model returned text only — conversation is complete
                yield sse("done", {"data_changed": data_changed})
                return
            
            # Execute each tool call, emit events, append results to history
            for idx in sorted(pending):
                tc = pending[idx]
                args = json.loads(tc["arguments"] or "{}")
                yield sse("tool_call_start", {"tool_call_id": tc["id"], "name": tc["name"], "args": args})
                
                result = _dispatch_tool(tc["name"], args, db)
                
                if result.startswith("OK:") and tc["name"] not in READ_ONLY_TOOLS:
                    data_changed = True
                
                yield sse("tool_result", {
                    "tool_call_id": tc["id"], "name": tc["name"],
                    "result": result, "ok": not result.startswith("ERROR:")
                })
                messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
            
            # Loop: model will see tool results and either call more tools or reply with text
        
        yield sse("error", {"message": f"Reached max {MAX_ITERATIONS} iterations."})
    except Exception as exc:
        yield sse("error", {"message": str(exc)})
```

**Critical implementation note:** `finish_reason` and all tool call argument chunks arrive on different streaming chunks. Only execute tools **after** the `async for chunk in stream` loop fully exits.

### `__init__.py`
```python
from .loop import run_agent, run_agent_stream
from .sse import AgentStreamEvent  # if defined as TypedDict
# Re-export AgentRequest, AgentResponse from models (or define here)
```

---

## Step 2 — `main.py`: New Endpoint

`StreamingResponse` is already imported. Update the agent import and add one endpoint:

```python
from .agent import run_agent, run_agent_stream  # updated import path

@app.post("/agent/chat/stream")
async def agent_chat_stream(request: AgentRequest, db: Session = Depends(get_db)):
    return StreamingResponse(
        run_agent_stream(request, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# Existing endpoint unchanged:
@app.post("/agent/chat", response_model=AgentResponse)
def agent_chat(request: AgentRequest, db: Session = Depends(get_db)):
    return run_agent(request, db)
```

`Depends(get_db)` works with `async def` — FastAPI runs sync dependencies before the async handler starts, so `db` is a live session object when `run_agent_stream` is called.

---

## Step 3 — `api.ts`: Stream Function

```typescript
export type AgentStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; tool_call_id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id: string; name: string; result: string; ok: boolean }
  | { type: "done"; data_changed: boolean }
  | { type: "error"; message: string };

// Add to api object alongside existing sendAgentMessage:
streamAgentMessage: async function* (messages: ChatMessage[]): AsyncGenerator<AgentStreamEvent> {
  const response = await fetch(`${API_BASE}/agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) throw new Error(response.statusText);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;  // keep incomplete tail for next chunk
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      try { yield JSON.parse(line.slice(6)); } catch { /* skip malformed */ }
    }
  }
},
```

`sendAgentMessage` stays unchanged for backward compatibility.

---

## Step 4 — `ChatPanel.tsx`: Streaming UI

**Widen message state to include tool steps:**
```typescript
type ToolStep = {
  kind: "tool_step"; toolCallId: string; name: string;
  args: Record<string, unknown>; result: string | null; ok: boolean; collapsed: boolean;
};
type MessageItem = { kind: "message"; role: "user" | "assistant"; content: string } | ToolStep;

const [items, setItems] = useState<MessageItem[]>([initialGreeting]);
const [streamingText, setStreamingText] = useState(""); // live token buffer
const [streaming, setStreaming] = useState(false);
```

**`handleSend` event handling** (replace `api.sendAgentMessage` call):
```typescript
for await (const event of api.streamAgentMessage(history)) {
  if (event.type === "text_delta")      → append to streamingText
  if (event.type === "tool_call_start") → append pending ToolStep (result: null) to items
  if (event.type === "tool_result")     → update matching ToolStep by toolCallId
  if (event.type === "done")            → flush streamingText → MessageItem; call onDataChanged() if needed; break
  if (event.type === "error")           → append error MessageItem; break
}
```

**Render:** `items.map()` — `kind === "message"` renders as before; `kind === "tool_step"` renders a collapsible pill (spinner while result is null, ✓/✗ when done). Live `streamingText` renders as an assistant bubble below the list. "Thinking…" shows only when `streaming && !streamingText && no pending tool steps`.

**Tool name display helper:**
```typescript
const TOOL_LABELS: Record<string, string> = {
  set_assignment: "Set assignment",       clear_assignment: "Clear assignment",
  get_availability: "Check availability", update_data_scientist: "Update person",
  update_project: "Update project",       check_conflicts: "Check conflicts",
  create_data_scientist: "Create person", create_project: "Create project",
  suggest_data_scientists: "Suggest candidates",
};
```

---

## Step 5 — `App.css`: Tool Step Styles

Add at end of chat section: `.tool-step`, `.tool-step.ok`, `.tool-step.error`, `.tool-step__header`, `.tool-step__name`, `.tool-step__body`, `.tool-step__result` (monospace, pre-wrap), `.streaming-cursor` (blinking `|` via `@keyframes blink`).

---

## Verification

1. **Backend smoke test** (curl, multi-step):
   ```bash
   curl -N -X POST http://localhost:8000/agent/chat/stream \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"check for conflicts"}]}'
   # Expect: tool_call_start(check_conflicts) → tool_result → text_delta × N → done

   curl -N ... -d '{"messages":[{"role":"user","content":"assign Alice 50% to ProjectX then verify no conflicts"}]}'
   # Expect: tool_call_start(set_assignment) → tool_result → tool_call_start(check_conflicts) → tool_result → text_delta × N → done
   # This proves the multi-iteration loop is working
   ```

2. **New tool test:** "Create a new DS named Jane Smith, senior level" → `create_data_scientist` visible in chat as a tool step.

3. **Frontend:** `npm run build` (TypeScript) and `npm run lint` (`--max-warnings 0`) must both pass.

4. **Old endpoint compatibility:** `POST /agent/chat` still returns JSON `AgentResponse` (not SSE).

5. **Import paths:** All existing references to `from .agent import AgentRequest, AgentResponse, run_agent` in `main.py` still work via `__init__.py` re-exports.
