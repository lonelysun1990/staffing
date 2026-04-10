# Dynamic Tool Generation Implementation Plan

## Overview

Allow the agent to create, store, and execute custom Python tools at runtime. Each tool gets its own isolated virtual environment with its declared dependencies. Tools are stored in PostgreSQL and survive across sessions. The agent can call them by name just like static tools.

## Architecture

- **Per-tool venvs** at `/sandbox-envs/<tool_name>/` — created dynamically at runtime, not at build time
- **No Docker required** — nixpacks build continues unchanged; venvs are created by the running app
- **Subprocess execution** — tool code runs in a child process using the tool's venv Python; no env vars leaked
- **Railway Volume** — mount a persistent volume at `/sandbox-envs/` so venvs survive redeploys

---

## Files to Change

| File | Change |
|------|--------|
| `backend/app/orm_models.py` | Add `DynamicToolORM` |
| `backend/app/agent/env_manager.py` | **New** — venv create/delete/check helpers |
| `backend/app/agent/sandbox.py` | **New** — subprocess executor |
| `backend/app/agent/dynamic_tools.py` | **New** — DB CRUD |
| `backend/app/agent/tools.py` | Add 3 new tool schemas; update `READ_ONLY_TOOLS` |
| `backend/app/agent/executor.py` | Add handlers; update `_dispatch_tool` fallback |
| `backend/app/agent/context.py` | Inject available dynamic tools into system prompt |
| `backend/app/main.py` | Add startup venv recovery; add REST endpoints for tool management |

---

## Fix Index (applied throughout this plan)

| # | Issue | Fix |
|---|-------|-----|
| 1 | pip install blocks async event loop | Background `threading.Thread`; tool created in DB instantly with `env_status="pending"` |
| 2 | Railway ephemeral filesystem destroys venvs on redeploy | Railway Volume mounted at `/sandbox-envs/`; startup recovery recreates any missing ones |
| 3 | `session_id` not in `_dispatch_tool` call site | Remove `created_by_session_id` FK from ORM entirely |
| 4 | `env={}` breaks package imports (no PATH/HOME) | Use `{"PATH": "/usr/bin:/bin", "HOME": "/tmp"}` |
| 5 | `resource.setrlimit` silently fails in containers | Remove entirely; subprocess `timeout=30` is the real guard |
| 6 | `python_version` field stored but never used | Remove from ORM |
| 7 | `context.py` injection shown as handwavy `lines.append` | Exact injection shown matching actual `build_system_prompt` string construction |
| 8 | Dynamic tool name can shadow static tool names | `RESERVED_NAMES` frozenset checked before creation |
| 9 | `ensure_tool_environments` uses `db` as free variable | Use `with SessionLocal() as db:` inside the function |
| 10 | `os.unlink(script_path)` skipped on timeout | Move to `finally` block |

---

## Step 1 — ORM Model (`orm_models.py`)

Add after `AgentMemoryORM`. **Removed vs. original**: `python_version` (fix 6), `created_by_session_id` (fix 3), `is_verified`.

```python
class DynamicToolORM(Base):
    __tablename__ = "dynamic_tools"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=False)
    parameters_schema = Column(Text, nullable=False)  # JSON string of JSON Schema
    code = Column(Text, nullable=False)
    requirements = Column(Text, nullable=False, default="[]")  # JSON array: ["pandas==2.2.3"]
    env_status = Column(String(20), nullable=False, default="pending")  # pending | ready | failed
    env_error = Column(Text, nullable=True)

    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    usage_count = Column(Integer, default=0)
    last_used_at = Column(String, nullable=True)
    tags = Column(Text, nullable=True)  # JSON array string
```

Auto-created by the existing `Base.metadata.create_all()` in lifespan — no migration script needed.

---

## Step 2 — Environment Manager (`agent/env_manager.py`) — New File

```python
import os
import shutil
import subprocess
from pathlib import Path
from typing import List

SANDBOX_ENVS_DIR = Path(os.environ.get("SANDBOX_ENVS_DIR", "/sandbox-envs"))


def get_tool_python(tool_name: str) -> str:
    return str(SANDBOX_ENVS_DIR / tool_name / "bin" / "python")


def environment_exists(tool_name: str) -> bool:
    return Path(get_tool_python(tool_name)).exists()


def create_tool_environment(tool_name: str, requirements: List[str]) -> dict:
    """Create venv and install dependencies. Blocking — call from a background thread."""
    venv_path = SANDBOX_ENVS_DIR / tool_name
    try:
        subprocess.run(
            ["python", "-m", "venv", str(venv_path)],
            check=True, capture_output=True, timeout=60,
        )
        if requirements:
            pip = venv_path / "bin" / "pip"
            subprocess.run(
                [str(pip), "install", "--no-cache-dir"] + requirements,
                check=True, capture_output=True, timeout=300,
            )
        return {"ok": True}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "error": e.stderr.decode() if e.stderr else str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def delete_tool_environment(tool_name: str) -> None:
    venv_path = SANDBOX_ENVS_DIR / tool_name
    if venv_path.exists():
        shutil.rmtree(venv_path)
```

---

## Step 3 — Sandbox Executor (`agent/sandbox.py`) — New File

Key fixes applied: `env={"PATH":..., "HOME":...}` not `env={}` (fix 4), `os.unlink` in `finally` (fix 10), no `resource.setrlimit` (fix 5).

```python
import json
import os
import subprocess
import tempfile
from .env_manager import get_tool_python, environment_exists

TIMEOUT_SECONDS = 30


def execute_in_sandbox(tool_name: str, code: str, function_name: str, args: dict) -> dict:
    """Execute tool code in its isolated venv subprocess.
    Returns {"ok": True, "result": ...} or {"ok": False, "error": "..."}
    """
    if not environment_exists(tool_name):
        return {"ok": False, "error": f"Environment for '{tool_name}' not ready yet"}

    runner = f"""
import json, sys
{code}

if __name__ == "__main__":
    args = json.loads(sys.argv[1])
    try:
        result = {function_name}(**args)
        print(json.dumps({{"ok": True, "result": result}}, default=str))
    except Exception as e:
        print(json.dumps({{"ok": False, "error": str(e)}}))
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(runner)
        script_path = f.name

    try:
        proc = subprocess.run(
            [get_tool_python(tool_name), script_path, json.dumps(args)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"},  # fix 4: no app secrets, minimal env
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout.strip())
        return {"ok": False, "error": proc.stderr.strip() or "No output"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Timed out after {TIMEOUT_SECONDS}s"}
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Unparseable output: {proc.stdout[:300]}"}
    finally:
        os.unlink(script_path)  # fix 10: always cleans up even on timeout
```

---

## Step 4 — Dynamic Tool CRUD (`agent/dynamic_tools.py`) — New File

Fix 8 (reserved names), fix 3 (no session_id), max code size guard included.

```python
import ast
import json
import threading
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy.orm import Session
from ..orm_models import DynamicToolORM
from ..database import SessionLocal
from .env_manager import create_tool_environment, delete_tool_environment, environment_exists

# Fix 8: names that dynamic tools cannot shadow
RESERVED_NAMES = frozenset({
    "set_assignment", "clear_assignment", "get_availability", "check_conflicts",
    "suggest_data_scientists", "update_data_scientist", "update_project",
    "create_data_scientist", "create_project", "remember_fact", "list_memories",
    "create_dynamic_tool", "list_dynamic_tools", "delete_dynamic_tool",
})

MAX_CODE_BYTES = 10_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_tool_code(code: str, function_name: str) -> Optional[str]:
    """Returns error string or None if valid."""
    if len(code.encode()) > MAX_CODE_BYTES:
        return f"Code exceeds {MAX_CODE_BYTES} byte limit"
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return f"Syntax error: {e}"
    names = [n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    if function_name not in names:
        return f"Code must define a function named '{function_name}'"
    return None


def _setup_env_background(tool_id: int, tool_name: str, requirements: list) -> None:
    """Fix 1: runs in a background thread so pip install never blocks the event loop."""
    with SessionLocal() as db:  # fix 9: own session, not a free variable
        result = create_tool_environment(tool_name, requirements)
        tool = db.query(DynamicToolORM).filter(DynamicToolORM.id == tool_id).first()
        if tool:
            tool.env_status = "ready" if result["ok"] else "failed"
            tool.env_error = result.get("error") if not result["ok"] else None
            db.commit()


def create_dynamic_tool(
    db: Session,
    name: str,
    description: str,
    parameters_schema: dict,
    code: str,
    requirements: list,
    tags: Optional[list] = None,
) -> tuple[DynamicToolORM, str]:
    """
    Inserts the tool row immediately. If requirements exist, kicks off background
    thread for pip install and returns env_status="pending".
    Returns (tool, status_message).
    """
    tool = DynamicToolORM(
        name=name,
        description=description,
        parameters_schema=json.dumps(parameters_schema),
        code=code,
        requirements=json.dumps(requirements),
        env_status="pending" if requirements else "ready",
        created_at=_now(),
        updated_at=_now(),
        tags=json.dumps(tags) if tags else None,
    )
    db.add(tool)
    db.commit()
    db.refresh(tool)

    if requirements:
        threading.Thread(
            target=_setup_env_background,
            args=(tool.id, tool.name, requirements),
            daemon=True,
        ).start()
        msg = (
            f"Tool '{name}' created. Installing {len(requirements)} package(s) "
            f"in background: {', '.join(requirements)}. "
            f"Check status with list_dynamic_tools before running."
        )
    else:
        msg = f"Tool '{name}' created and ready (no additional packages needed)."

    return tool, msg


def get_dynamic_tool_by_name(db: Session, name: str) -> Optional[DynamicToolORM]:
    return db.query(DynamicToolORM).filter(DynamicToolORM.name == name).first()


def list_dynamic_tools(db: Session) -> list[DynamicToolORM]:
    return db.query(DynamicToolORM).order_by(DynamicToolORM.name).all()


def increment_usage(db: Session, tool_id: int) -> None:
    tool = db.query(DynamicToolORM).filter(DynamicToolORM.id == tool_id).first()
    if tool:
        tool.usage_count += 1
        tool.last_used_at = _now()
        db.commit()


def delete_dynamic_tool(db: Session, name: str) -> bool:
    tool = get_dynamic_tool_by_name(db, name)
    if tool:
        delete_tool_environment(name)
        db.delete(tool)
        db.commit()
        return True
    return False


def ensure_tool_environments() -> None:
    """Fix 1+9: called at startup to recreate any venvs missing due to redeploy."""
    with SessionLocal() as db:  # fix 9: own session, not a free variable
        tools = db.query(DynamicToolORM).filter(DynamicToolORM.env_status == "ready").all()
        missing = [(t.id, t.name, json.loads(t.requirements)) for t in tools
                   if not environment_exists(t.name)]

    for tool_id, tool_name, reqs in missing:
        print(f"[startup] Recreating missing venv for tool '{tool_name}'...")
        threading.Thread(
            target=_setup_env_background,
            args=(tool_id, tool_name, reqs),
            daemon=True,
        ).start()
```

---

## Step 5 — Tool Schemas (`agent/tools.py`)

Add to `TOOLS` list:

```python
{
    "type": "function",
    "function": {
        "name": "create_dynamic_tool",
        "description": (
            "Create a reusable Python tool stored in the database with its own isolated environment. "
            "Specify required packages and they will be installed in the background. "
            "Check env_status with list_dynamic_tools before running a tool with packages."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "snake_case name, e.g. 'calculate_fte_gap'"},
                "description": {"type": "string", "description": "What the tool does"},
                "parameters_schema": {"type": "object", "description": "JSON Schema for the function's parameters"},
                "code": {"type": "string", "description": "Python code. Must define a function with the same name as the tool."},
                "requirements": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Packages to install, e.g. ['gurobipy', 'pandas==2.2.3']. Empty list if none needed.",
                },
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags"},
            },
            "required": ["name", "description", "parameters_schema", "code", "requirements"],
        },
    },
},
{
    "type": "function",
    "function": {
        "name": "list_dynamic_tools",
        "description": "List all dynamic tools, their env_status (pending/ready/failed), and usage count.",
        "parameters": {"type": "object", "properties": {}},
    },
},
{
    "type": "function",
    "function": {
        "name": "delete_dynamic_tool",
        "description": "Delete a dynamic tool and its virtual environment.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Tool name to delete"},
            },
            "required": ["name"],
        },
    },
},
```

Add `"list_dynamic_tools"` to `READ_ONLY_TOOLS`.

---

## Step 6 — Executor Integration (`agent/executor.py`)

Add imports:
```python
import json
from .dynamic_tools import (
    RESERVED_NAMES, validate_tool_code,
    create_dynamic_tool, get_dynamic_tool_by_name,
    list_dynamic_tools, delete_dynamic_tool, increment_usage,
)
from .sandbox import execute_in_sandbox
```

Add four handler functions:

```python
def _execute_create_dynamic_tool(db: Session, args: dict) -> str:
    name = args["name"]
    # fix 8: block reserved names
    if name in RESERVED_NAMES:
        return f"ERROR: '{name}' is a reserved tool name and cannot be used"
    if get_dynamic_tool_by_name(db, name):
        return f"ERROR: Tool '{name}' already exists. Delete it first to recreate."
    err = validate_tool_code(args["code"], name)
    if err:
        return f"ERROR: {err}"
    _, msg = create_dynamic_tool(
        db, name=name, description=args["description"],
        parameters_schema=args["parameters_schema"],
        code=args["code"], requirements=args.get("requirements", []),
        tags=args.get("tags"),
    )
    return f"OK: {msg}"


def _execute_list_dynamic_tools(db: Session) -> str:
    tools = list_dynamic_tools(db)
    if not tools:
        return "OK: No dynamic tools created yet."
    lines = ["OK: Dynamic tools:"]
    for t in tools:
        reqs = json.loads(t.requirements) if t.requirements else []
        req_str = f" [{', '.join(reqs)}]" if reqs else ""
        lines.append(f"  - {t.name}: {t.description}")
        lines.append(f"    status={t.env_status}{req_str}, used={t.usage_count}x")
        if t.env_status == "failed" and t.env_error:
            lines.append(f"    error: {t.env_error}")
    return "\n".join(lines)


def _execute_delete_dynamic_tool(db: Session, args: dict) -> str:
    name = args["name"]
    return f"OK: Deleted tool '{name}'" if delete_dynamic_tool(db, name) \
        else f"ERROR: Tool '{name}' not found"


def _execute_run_dynamic_tool(db: Session, tool: DynamicToolORM, args: dict) -> str:
    if tool.env_status == "pending":
        return f"ERROR: Tool '{tool.name}' is still installing packages. Try again shortly."
    if tool.env_status == "failed":
        return f"ERROR: Tool '{tool.name}' environment setup failed: {tool.env_error}"
    result = execute_in_sandbox(tool.name, tool.code, tool.name, args)
    increment_usage(db, tool.id)
    return f"OK: {result['result']}" if result["ok"] else f"ERROR: {result['error']}"
```

Update `_dispatch_tool` — add cases before `case _:`, and change the fallback:

```python
case "create_dynamic_tool":
    return _execute_create_dynamic_tool(db, args)
case "list_dynamic_tools":
    return _execute_list_dynamic_tools(db)
case "delete_dynamic_tool":
    return _execute_delete_dynamic_tool(db, args)
case _:
    tool = get_dynamic_tool_by_name(db, fn_name)
    if tool:
        return _execute_run_dynamic_tool(db, tool, args)
    return f"ERROR: Unknown tool '{fn_name}'"
```

---

## Step 7 — System Prompt Injection (`agent/context.py`)

Fix 7: exact injection matching the actual `build_system_prompt` string structure.
`build_system_prompt` returns an f-string that ends with `{_memory_section(...)}{_summary_section(...)}`.
Add a new helper and inject it at the end of the return value:

```python
from .dynamic_tools import list_dynamic_tools as _list_dyn_tools
import json as _json

def _dynamic_tools_section(db: Session) -> str:
    tools = [t for t in _list_dyn_tools(db) if t.env_status == "ready"]
    if not tools:
        return ""
    lines = ["\n## Available custom dynamic tools (call by name)"]
    for t in tools:
        params = _json.loads(t.parameters_schema).get("properties", {})
        param_str = ", ".join(params.keys()) if params else "no parameters"
        lines.append(f"  - {t.name}({param_str}): {t.description}")
    return "\n".join(lines) + "\n"
```

In `build_system_prompt`, change the return to:
```python
    return f"""...(existing f-string)...
{_memory_section(db, user_id)}{_summary_section(context_summary)}{_dynamic_tools_section(db)}"""
```

Only `env_status == "ready"` tools are shown — pending/failed tools are not advertised to the agent.

---

## Step 8 — Startup Recovery (`main.py`)

Fix 1+2+9: call `ensure_tool_environments()` in the existing `lifespan` hook.

```python
from .agent.dynamic_tools import ensure_tool_environments

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    seed()
    with SessionLocal() as db:
        bootstrap_admin(db)
    ensure_tool_environments()  # spawns background threads; returns immediately
    yield
```

`ensure_tool_environments` only recreates venvs for tools marked `env_status="ready"` whose filesystem path is missing — safe no-op if all venvs exist.

---

## Step 9 — Railway Volume Configuration (Fix 2)

One-time setup in the Railway dashboard:

1. **Railway dashboard → your backend service → Settings → Volumes**
2. Click **Add Volume**
3. Set mount path: `/sandbox-envs`
4. Set size: start with 5 GB (enough for dozens of tool venvs)
5. Deploy — Railway persists the volume across all future redeploys

Add `SANDBOX_ENVS_DIR=/sandbox-envs` to Railway environment variables (matches the default in `env_manager.py`).

No code changes required for this step — the path is already the default in `env_manager.py`.

---

## What Changed vs. Original Plan

| Original | Revised |
|----------|---------|
| `create_tool_environment` called synchronously (blocks loop) | Called in `threading.Thread`; returns "pending" immediately (fix 1) |
| Startup recovery used `db` free variable | Uses `with SessionLocal() as db:` (fix 9) |
| `env={}` in subprocess | `env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"}` (fix 4) |
| `resource.setrlimit` | Removed entirely (fix 5) |
| `python_version` ORM field | Removed (fix 6) |
| `created_by_session_id` FK | Removed — not available at dispatch call site (fix 3) |
| No name collision guard | `RESERVED_NAMES` check before creation (fix 8) |
| `context.py` injection handwavy | Exact `_dynamic_tools_section()` helper with correct injection point (fix 7) |
| `os.unlink` outside `finally` | Moved to `finally` block (fix 10) |
| Railway persistence: documented but not implemented | Railway Volume config steps provided (fix 2) |

---

## Verification

1. Create a tool with no requirements → `env_status="ready"` immediately, can run right away
2. Create a tool with `requirements=["pandas"]` → `env_status="pending"` returned instantly; poll `list_dynamic_tools` until `ready`; run it
3. Create a tool named `set_assignment` → should get `ERROR: reserved tool name`
4. Create a tool with a syntax error → should get `ERROR: Syntax error` before any DB write
5. Create a tool where the function name doesn't match the tool name → should get `ERROR: Code must define a function named '...'`
6. Call a tool that is `env_status="pending"` → should get `ERROR: still installing packages`
7. Redeploy the backend → venvs for `ready` tools automatically recreated in background via `ensure_tool_environments`
8. Confirm dynamic tools section appears in system prompt only for `ready` tools
9. Confirm tools with `requirements=["gurobipy"]` run in their own venv (gurobipy not importable in main app)
