"""
System prompt builder.

Reads current DB state and assembles the context string given to the model.
Keeping this separate makes it easy to add or remove context sections
without touching the loop or execution logic.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from .. import storage
from ..orm_models import AgentMemoryORM


def _memory_section(db: Session, user_id: Optional[int]) -> str:
    memories = (
        db.query(AgentMemoryORM)
        .filter(AgentMemoryORM.user_id == user_id)
        .order_by(AgentMemoryORM.category, AgentMemoryORM.key)
        .all()
    )
    if not memories:
        return "\n## Your long-term memory about this user\n  (none stored yet)\n"
    lines = [
        f"  [{m.category}] {m.key}: {m.value} (confidence={m.confidence})"
        for m in memories
    ]
    return "\n## Your long-term memory about this user\n" + "\n".join(lines) + "\n"


def _summary_section(context_summary: Optional[str]) -> str:
    if not context_summary:
        return ""
    return f"\n## Earlier in this conversation (summary)\n{context_summary}\n"


def build_system_prompt(
    db: Session,
    user_id: Optional[int] = None,
    context_summary: Optional[str] = None,
) -> str:
    ds_list = storage.list_data_scientists(db)
    project_list = storage.list_projects(db)
    assignments = storage.list_assignments(db)
    config = storage.get_config(db)
    today = date.today().isoformat()

    # Roster section
    ds_lines_parts = []
    for ds in ds_list:
        skill_part = f", skills=[{', '.join(ds.skills)}]" if ds.skills else ""
        ds_lines_parts.append(
            f"  - {ds.name} (id={ds.id}, level={ds.level}, "
            f"efficiency={ds.efficiency}, max_projects={ds.max_concurrent_projects}{skill_part})"
        )
    ds_lines = "\n".join(ds_lines_parts) or "  (none)"

    # Projects section
    proj_lines_parts = []
    for p in project_list:
        skill_part = f", required_skills=[{', '.join(p.required_skills)}]" if p.required_skills else ""
        proj_lines_parts.append(
            f"  - {p.name} (id={p.id}, {p.start_date} to {p.end_date}{skill_part})"
        )
    proj_lines = "\n".join(proj_lines_parts) or "  (none)"

    # Assignment summary section
    ds_id_map = {ds.id: ds.name for ds in ds_list}
    proj_id_map = {p.id: p.name for p in project_list}
    summary: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for a in assignments:
        ds_name = ds_id_map.get(a.data_scientist_id, str(a.data_scientist_id))
        proj_name = proj_id_map.get(a.project_id, str(a.project_id))
        summary[ds_name][proj_name].append(a.allocation)

    assign_lines = []
    for ds_name, proj_map in sorted(summary.items()):
        parts = [
            f"{pn} ({sum(allocs)/len(allocs):.0%} avg over {len(allocs)} weeks)"
            for pn, allocs in sorted(proj_map.items())
        ]
        assign_lines.append(f"  {ds_name}: {', '.join(parts)}")
    assign_summary = "\n".join(assign_lines) or "  (no assignments)"

    return f"""You are a staffing scheduling assistant for a data science team.
Convert plain-English instructions into assignment changes and answer scheduling questions.

Rules:
- Allocation is a fraction: 25% = 0.25, 50% = 0.5, 100% = 1.0
- If no date range is specified, apply to ALL upcoming weeks (today through planning horizon)
- If a name matches multiple people or projects, do NOT guess — ask for clarification
- After making changes, confirm what you did in plain English
- If the instruction is unclear, ask a focused clarifying question
- Today: {today} | Planning horizon: {config.horizon_weeks} weeks
- Use get_availability to check who is free before suggesting assignments
- Use check_conflicts after bulk assignment changes to verify nothing is over-allocated
- Use suggest_data_scientists to find skill-matched candidates for a project
- Use create_data_scientist / create_project only for entities that do not yet exist
- Use update_data_scientist / update_project to change properties; omit fields you are not changing
- Use remember_fact to store user preferences or patterns you observe across sessions
- Use list_memories to recall stored preferences at the start of a new session

## Current roster (name, level, efficiency, max_projects, skills)
{ds_lines}

## Current projects (name, dates, required skills)
{proj_lines}

## Current assignments (summary)
{assign_summary}
{_memory_section(db, user_id)}{_summary_section(context_summary)}"""
