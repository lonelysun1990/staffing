import ast
import json
import threading
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..orm_models import DynamicToolORM
from ..database import SessionLocal
from .env_manager import create_tool_environment, delete_tool_environment, environment_exists

# Names that dynamic tools cannot shadow
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
    """Runs in a background thread so pip install never blocks the event loop."""
    with SessionLocal() as db:
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
    """Called at startup to recreate any venvs missing due to redeploy."""
    with SessionLocal() as db:
        tools = db.query(DynamicToolORM).filter(DynamicToolORM.env_status == "ready").all()
        missing = [
            (t.id, t.name, json.loads(t.requirements))
            for t in tools
            if not environment_exists(t.name)
        ]

    for tool_id, tool_name, reqs in missing:
        print(f"[startup] Recreating missing venv for tool '{tool_name}'...")
        threading.Thread(
            target=_setup_env_background,
            args=(tool_id, tool_name, reqs),
            daemon=True,
        ).start()
