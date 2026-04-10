"""
Tool execution layer.

Each _execute_* function maps 1:1 to a tool in tools.py.
_dispatch_tool is the single routing entry point called by both loop variants.

To add a new tool:
  1. Write _execute_<name>() here.
  2. Add a case in _dispatch_tool().
  3. Add the schema in tools.py.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from .. import storage
from ..models import (
    AssignmentCreate,
    AssignmentsPayload,
    DataScientistCreate,
    ProjectCreate,
    ProjectWeek,
)
from ..orm_models import AgentMemoryORM, DynamicToolORM
from .tools import READ_ONLY_TOOLS  # re-exported for loop.py convenience
from .dynamic_tools import (
    RESERVED_NAMES, validate_tool_code,
    create_dynamic_tool, get_dynamic_tool_by_name,
    list_dynamic_tools, delete_dynamic_tool, increment_usage,
)
from .sandbox import execute_in_sandbox


# ---------------------------------------------------------------------------
# Name resolution
# ---------------------------------------------------------------------------

def resolve_name(query: str, candidates: list[str]) -> list[str]:
    """Case-insensitive substring match. Returns all matching candidate names."""
    q = query.strip().lower()
    return [c for c in candidates if q in c.lower()]


# ---------------------------------------------------------------------------
# Week helpers
# ---------------------------------------------------------------------------

def _next_monday(d: date) -> date:
    days_ahead = (7 - d.weekday()) % 7
    return d + timedelta(days=days_ahead) if days_ahead else d


def _upcoming_mondays(horizon_weeks: int) -> list[str]:
    today = date.today()
    start = _next_monday(today)
    return [(start + timedelta(weeks=i)).isoformat() for i in range(horizon_weeks)]


def _week_start_str(w) -> str:
    return w.isoformat() if isinstance(w, date) else str(w)


# ---------------------------------------------------------------------------
# Execute functions
# ---------------------------------------------------------------------------

def _execute_set_assignment(
    db: Session,
    ds_name_query: str,
    proj_name_query: str,
    allocation: float,
    week_start_str: Optional[str],
    week_end_str: Optional[str],
) -> str:
    ds_names = [ds.name for ds in storage.list_data_scientists(db)]
    proj_names = [p.name for p in storage.list_projects(db)]

    ds_matches = resolve_name(ds_name_query, ds_names)
    proj_matches = resolve_name(proj_name_query, proj_names)

    if len(ds_matches) == 0:
        return f"ERROR: No data scientist matching '{ds_name_query}' found. Available: {', '.join(ds_names)}"
    if len(ds_matches) > 1:
        return f"CLARIFICATION_NEEDED: '{ds_name_query}' matches multiple people: {', '.join(ds_matches)}. Please specify."
    if len(proj_matches) == 0:
        return f"ERROR: No project matching '{proj_name_query}' found. Available: {', '.join(proj_names)}"
    if len(proj_matches) > 1:
        return f"CLARIFICATION_NEEDED: '{proj_name_query}' matches multiple projects: {', '.join(proj_matches)}. Please specify."

    ds_name = ds_matches[0]
    proj_name = proj_matches[0]
    config = storage.get_config(db)
    ds = next(d for d in storage.list_data_scientists(db) if d.name == ds_name)
    proj = next(p for p in storage.list_projects(db) if p.name == proj_name)

    if week_start_str is None:
        target_weeks = set(_upcoming_mondays(config.horizon_weeks))
    else:
        start = date.fromisoformat(week_start_str)
        end = date.fromisoformat(week_end_str) if week_end_str else None
        if end is None:
            target_weeks = {w for w in _upcoming_mondays(config.horizon_weeks) if w >= week_start_str}
        else:
            target_weeks = set()
            current = start
            while current <= end:
                target_weeks.add(current.isoformat())
                current += timedelta(weeks=1)

    existing = storage.list_assignments(db)
    kept = [
        a for a in existing
        if not (
            a.data_scientist_id == ds.id
            and a.project_id == proj.id
            and _week_start_str(a.week_start) in target_weeks
        )
    ]
    new_rows = [
        AssignmentCreate(
            data_scientist_id=ds.id,
            project_id=proj.id,
            week_start=w,
            allocation=allocation,
        )
        for w in sorted(target_weeks)
    ]
    payload = AssignmentsPayload(assignments=[
        AssignmentCreate(
            data_scientist_id=a.data_scientist_id,
            project_id=a.project_id,
            week_start=a.week_start,
            allocation=a.allocation,
        )
        for a in kept
    ] + new_rows)
    storage.replace_assignments(db, payload)
    return f"OK: Set {ds_name} at {allocation:.0%} on '{proj_name}' for {len(target_weeks)} week(s)."


def _execute_clear_assignment(
    db: Session,
    ds_name_query: str,
    proj_name_query: str,
    week_start_str: Optional[str],
    week_end_str: Optional[str],
) -> str:
    ds_names = [ds.name for ds in storage.list_data_scientists(db)]
    ds_matches = resolve_name(ds_name_query, ds_names)
    if len(ds_matches) == 0:
        return f"ERROR: No data scientist matching '{ds_name_query}' found."
    if len(ds_matches) > 1:
        return f"CLARIFICATION_NEEDED: '{ds_name_query}' matches multiple people: {', '.join(ds_matches)}."

    ds = next(d for d in storage.list_data_scientists(db) if d.name == ds_matches[0])
    clear_all = proj_name_query.strip().upper() == "ALL"

    if not clear_all:
        proj_names = [p.name for p in storage.list_projects(db)]
        proj_matches = resolve_name(proj_name_query, proj_names)
        if len(proj_matches) == 0:
            return f"ERROR: No project matching '{proj_name_query}' found."
        if len(proj_matches) > 1:
            return f"CLARIFICATION_NEEDED: '{proj_name_query}' matches multiple projects: {', '.join(proj_matches)}."
        proj = next(p for p in storage.list_projects(db) if p.name == proj_matches[0])
    else:
        proj = None

    ws, we = week_start_str, week_end_str
    existing = storage.list_assignments(db)

    def _matches(a) -> bool:
        if a.data_scientist_id != ds.id:
            return False
        if not clear_all and a.project_id != proj.id:
            return False
        w = _week_start_str(a.week_start)
        if ws is not None and w < ws:
            return False
        if we is not None and w > we:
            return False
        return True

    kept = [a for a in existing if not _matches(a)]
    removed = len(existing) - len(kept)
    payload = AssignmentsPayload(assignments=[
        AssignmentCreate(
            data_scientist_id=a.data_scientist_id,
            project_id=a.project_id,
            week_start=a.week_start,
            allocation=a.allocation,
        )
        for a in kept
    ])
    storage.replace_assignments(db, payload)
    proj_label = "all projects" if clear_all else f"'{proj.name}'"
    return f"OK: Removed {removed} assignment(s) for {ds.name} on {proj_label}."


def _execute_get_availability(
    db: Session,
    ds_name_query: Optional[str],
    week_start_str: Optional[str],
    week_end_str: Optional[str],
) -> str:
    ds_list = storage.list_data_scientists(db)
    assignments = storage.list_assignments(db)

    if week_start_str is None:
        start = _next_monday(date.today())
        weeks = [(start + timedelta(weeks=i)).isoformat() for i in range(4)]
    else:
        start = date.fromisoformat(week_start_str)
        end = date.fromisoformat(week_end_str) if week_end_str else start + timedelta(weeks=4)
        weeks, current = [], start
        while current <= end:
            weeks.append(current.isoformat())
            current += timedelta(weeks=1)

    if ds_name_query:
        matches = resolve_name(ds_name_query, [ds.name for ds in ds_list])
        if len(matches) == 0:
            return f"ERROR: No data scientist matching '{ds_name_query}' found."
        if len(matches) > 1:
            return f"CLARIFICATION_NEEDED: '{ds_name_query}' matches multiple people: {', '.join(matches)}."
        ds_list = [ds for ds in ds_list if ds.name == matches[0]]

    alloc_map: dict[tuple[int, str], float] = defaultdict(float)
    for a in assignments:
        alloc_map[(a.data_scientist_id, _week_start_str(a.week_start))] += a.allocation

    lines = []
    for ds in ds_list:
        week_avail = [
            f"{w}: {max(0.0, 1.0 - alloc_map.get((ds.id, w), 0.0)):.0%} free"
            for w in weeks
        ]
        lines.append(f"  {ds.name}:\n    " + "\n    ".join(week_avail))

    return "OK:\n" + "\n".join(lines) if lines else "OK: No data scientists found."


def _execute_check_conflicts(db: Session) -> str:
    conflicts = storage.get_conflicts(db)
    if not conflicts:
        return "OK: No conflicts. All data scientists are within 100% allocation."
    lines = [
        f"  {c['data_scientist_name']} on {c['week_start']}: "
        f"{c['total_allocation']:.0%} total (over by {c['over_by']:.0%})"
        for c in conflicts
    ]
    return "OK: Conflicts detected:\n" + "\n".join(lines)


def _execute_suggest_data_scientists(db: Session, proj_name_query: str) -> str:
    proj_names = [p.name for p in storage.list_projects(db)]
    matches = resolve_name(proj_name_query, proj_names)
    if len(matches) == 0:
        return f"ERROR: No project matching '{proj_name_query}' found. Available: {', '.join(proj_names)}"
    if len(matches) > 1:
        return f"CLARIFICATION_NEEDED: '{proj_name_query}' matches multiple projects: {', '.join(matches)}."

    proj = next(p for p in storage.list_projects(db) if p.name == matches[0])
    suggestions = storage.get_skill_suggestions(db, proj.id)
    if not suggestions:
        return f"OK: No matching data scientists found for '{proj.name}'."
    lines = [
        f"  {ds.name} (level={ds.level}, skills=[{', '.join(ds.skills)}])"
        for ds in suggestions
    ]
    return f"OK: Suggested data scientists for '{proj.name}':\n" + "\n".join(lines)


def _execute_update_data_scientist(
    db: Session,
    ds_name_query: str,
    new_name: Optional[str],
    level: Optional[str],
    efficiency: Optional[float],
    max_concurrent_projects: Optional[int],
    notes,
    skills: Optional[list],
) -> str:
    ds_names = [ds.name for ds in storage.list_data_scientists(db)]
    matches = resolve_name(ds_name_query, ds_names)
    if len(matches) == 0:
        return f"ERROR: No data scientist matching '{ds_name_query}' found. Available: {', '.join(ds_names)}"
    if len(matches) > 1:
        return f"CLARIFICATION_NEEDED: '{ds_name_query}' matches multiple people: {', '.join(matches)}."

    ds = next(d for d in storage.list_data_scientists(db) if d.name == matches[0])
    payload = DataScientistCreate(
        name=new_name if new_name is not None else ds.name,
        level=level if level is not None else ds.level,
        efficiency=efficiency if efficiency is not None else ds.efficiency,
        max_concurrent_projects=max_concurrent_projects if max_concurrent_projects is not None else ds.max_concurrent_projects,
        notes=notes if notes is not None else ds.notes,
        skills=skills if skills is not None else ds.skills,
    )
    storage.update_data_scientist(db, ds.id, payload)

    changes = []
    if new_name is not None and new_name != ds.name:
        changes.append(f"name: '{ds.name}' → '{new_name}'")
    if level is not None and level != ds.level:
        changes.append(f"level: '{ds.level}' → '{level}'")
    if efficiency is not None and efficiency != ds.efficiency:
        changes.append(f"efficiency: {ds.efficiency} → {efficiency}")
    if max_concurrent_projects is not None and max_concurrent_projects != ds.max_concurrent_projects:
        changes.append(f"max_concurrent_projects: {ds.max_concurrent_projects} → {max_concurrent_projects}")
    if notes is not None:
        changes.append("notes updated")
    if skills is not None:
        changes.append(f"skills → [{', '.join(skills)}]")

    summary = "; ".join(changes) if changes else "none (values already matched)"
    return f"OK: Updated {ds.name}. Changes: {summary}."


def _execute_update_project(
    db: Session,
    proj_name_query: str,
    new_name: Optional[str],
    start_date_str: Optional[str],
    end_date_str: Optional[str],
    required_skills: Optional[list],
) -> str:
    proj_names = [p.name for p in storage.list_projects(db)]
    matches = resolve_name(proj_name_query, proj_names)
    if len(matches) == 0:
        return f"ERROR: No project matching '{proj_name_query}' found. Available: {', '.join(proj_names)}"
    if len(matches) > 1:
        return f"CLARIFICATION_NEEDED: '{proj_name_query}' matches multiple projects: {', '.join(matches)}."

    proj = next(p for p in storage.list_projects(db) if p.name == matches[0])
    new_start = date.fromisoformat(start_date_str) if start_date_str else proj.start_date
    new_end = date.fromisoformat(end_date_str) if end_date_str else proj.end_date

    payload = ProjectCreate(
        name=new_name if new_name is not None else proj.name,
        start_date=new_start,
        end_date=new_end,
        fte_requirements=proj.fte_requirements,
        required_skills=required_skills if required_skills is not None else proj.required_skills,
    )
    storage.update_project(db, proj.id, payload)

    changes = []
    if new_name is not None and new_name != proj.name:
        changes.append(f"name: '{proj.name}' → '{new_name}'")
    if start_date_str is not None and new_start != proj.start_date:
        changes.append(f"start_date: {proj.start_date} → {new_start}")
    if end_date_str is not None and new_end != proj.end_date:
        changes.append(f"end_date: {proj.end_date} → {new_end}")
    if required_skills is not None:
        changes.append(f"required_skills → [{', '.join(required_skills)}]")

    summary = "; ".join(changes) if changes else "none (values already matched)"
    return f"OK: Updated project '{proj.name}'. Changes: {summary}."


def _execute_create_data_scientist(
    db: Session,
    name: str,
    level: str,
    efficiency: float,
    max_concurrent_projects: int,
    notes: Optional[str],
    skills: Optional[list],
) -> str:
    existing_names = [ds.name for ds in storage.list_data_scientists(db)]
    if resolve_name(name, existing_names):
        matches = resolve_name(name, existing_names)
        return (
            f"CLARIFICATION_NEEDED: A data scientist matching '{name}' already exists: "
            f"{', '.join(matches)}. Did you mean update_data_scientist?"
        )
    payload = DataScientistCreate(
        name=name,
        level=level,
        efficiency=efficiency,
        max_concurrent_projects=max_concurrent_projects,
        notes=notes,
        skills=skills or [],
    )
    ds = storage.create_data_scientist(db, payload)
    return f"OK: Created data scientist '{ds.name}' (id={ds.id}, level={ds.level}, efficiency={ds.efficiency})."


def _execute_create_project(
    db: Session,
    name: str,
    start_date_str: str,
    end_date_str: str,
    required_skills: Optional[list],
) -> str:
    existing_names = [p.name for p in storage.list_projects(db)]
    if resolve_name(name, existing_names):
        matches = resolve_name(name, existing_names)
        return (
            f"CLARIFICATION_NEEDED: A project matching '{name}' already exists: "
            f"{', '.join(matches)}. Did you mean update_project?"
        )
    start = date.fromisoformat(start_date_str)
    end = date.fromisoformat(end_date_str)

    # Auto-generate weekly FTE rows at 1.0 — adjustable later via update_project
    weeks: list[ProjectWeek] = []
    current = start
    while current <= end:
        weeks.append(ProjectWeek(week_start=current, fte=1.0))
        current += timedelta(weeks=1)

    payload = ProjectCreate(
        name=name,
        start_date=start,
        end_date=end,
        fte_requirements=weeks,
        required_skills=required_skills or [],
    )
    proj = storage.create_project(db, payload)
    return f"OK: Created project '{proj.name}' (id={proj.id}, {proj.start_date} to {proj.end_date}, {len(weeks)} weeks)."


# ---------------------------------------------------------------------------
# Dispatch table — add new tools here
# ---------------------------------------------------------------------------
# Long-term memory tools
# ---------------------------------------------------------------------------

def _execute_remember_fact(
    db: Session,
    user_id: Optional[int],
    category: str,
    key: str,
    value: str,
    confidence: int = 3,
) -> str:
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    existing = (
        db.query(AgentMemoryORM)
        .filter(AgentMemoryORM.user_id == user_id, AgentMemoryORM.key == key)
        .first()
    )
    if existing:
        existing.category = category
        existing.value = value
        existing.confidence = confidence
        existing.updated_at = now
    else:
        db.add(AgentMemoryORM(
            user_id=user_id,
            category=category,
            key=key,
            value=value,
            confidence=confidence,
            created_at=now,
            updated_at=now,
        ))
    db.commit()
    return f"OK: Remembered [{category}] '{key}': {value}"


def _execute_list_memories(
    db: Session,
    user_id: Optional[int],
    category: Optional[str] = None,
) -> str:
    q = db.query(AgentMemoryORM).filter(AgentMemoryORM.user_id == user_id)
    if category:
        q = q.filter(AgentMemoryORM.category == category)
    memories = q.order_by(AgentMemoryORM.category, AgentMemoryORM.key).all()
    if not memories:
        return "OK: No memories stored yet."
    lines = [
        f"[{m.category}] {m.key}: {m.value} (confidence={m.confidence})"
        for m in memories
    ]
    return "OK:\n" + "\n".join(lines)


# ---------------------------------------------------------------------------

def _execute_create_dynamic_tool(db: Session, args: dict) -> str:
    name = args["name"]
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
    import json as _json
    tools = list_dynamic_tools(db)
    if not tools:
        return "OK: No dynamic tools created yet."
    lines = ["OK: Dynamic tools:"]
    for t in tools:
        reqs = _json.loads(t.requirements) if t.requirements else []
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


def _dispatch_tool(fn_name: str, args: dict, db: Session, user_id: Optional[int] = None) -> str:
    """Route a tool call to the appropriate execute function."""
    match fn_name:
        case "set_assignment":
            return _execute_set_assignment(
                db, args["data_scientist_name"], args["project_name"],
                args["allocation"], args.get("week_start"), args.get("week_end"),
            )
        case "clear_assignment":
            return _execute_clear_assignment(
                db, args["data_scientist_name"], args["project_name"],
                args.get("week_start"), args.get("week_end"),
            )
        case "get_availability":
            return _execute_get_availability(
                db, args.get("data_scientist_name"),
                args.get("week_start"), args.get("week_end"),
            )
        case "check_conflicts":
            return _execute_check_conflicts(db)
        case "suggest_data_scientists":
            return _execute_suggest_data_scientists(db, args["project_name"])
        case "update_data_scientist":
            return _execute_update_data_scientist(
                db, args["data_scientist_name"], args.get("new_name"),
                args.get("level"), args.get("efficiency"),
                args.get("max_concurrent_projects"), args.get("notes"), args.get("skills"),
            )
        case "update_project":
            return _execute_update_project(
                db, args["project_name"], args.get("new_name"),
                args.get("start_date"), args.get("end_date"), args.get("required_skills"),
            )
        case "create_data_scientist":
            return _execute_create_data_scientist(
                db, args["name"], args["level"],
                args.get("efficiency", 1.0), args.get("max_concurrent_projects", 2),
                args.get("notes"), args.get("skills"),
            )
        case "create_project":
            return _execute_create_project(
                db, args["name"], args["start_date"], args["end_date"],
                args.get("required_skills"),
            )
        case "remember_fact":
            return _execute_remember_fact(
                db, user_id, args["category"], args["key"], args["value"],
                args.get("confidence", 3),
            )
        case "list_memories":
            return _execute_list_memories(db, user_id, args.get("category"))
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
