"""
OpenAI tool schema definitions.

To add a new tool:
  1. Add its JSON schema entry to TOOLS below.
  2. Add _execute_<name>() in executor.py.
  3. Add a case in _dispatch_tool() in executor.py.
"""

TOOLS: list[dict] = [
    # ------------------------------------------------------------------ #
    # Assignment tools
    # ------------------------------------------------------------------ #
    {
        "type": "function",
        "function": {
            "name": "set_assignment",
            "description": (
                "Set a data scientist's allocation on a project for a range of weeks. "
                "Existing assignments for that person+project within the date range are replaced. "
                "If week_start is null, applies to ALL upcoming weeks within the planning horizon."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_scientist_name": {
                        "type": "string",
                        "description": "Name of the data scientist (partial match accepted)",
                    },
                    "project_name": {
                        "type": "string",
                        "description": "Name of the project (partial match accepted)",
                    },
                    "allocation": {
                        "type": "number",
                        "description": "Allocation fraction 0.0–1.0 (e.g. 0.25 = 25%)",
                    },
                    "week_start": {
                        "type": ["string", "null"],
                        "description": "ISO date (YYYY-MM-DD) of first week to set, or null for all upcoming weeks",
                    },
                    "week_end": {
                        "type": ["string", "null"],
                        "description": "ISO date (YYYY-MM-DD) of last week to set (inclusive), or null for open-ended",
                    },
                },
                "required": ["data_scientist_name", "project_name", "allocation"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clear_assignment",
            "description": (
                "Remove all assignments for a data scientist on a project, optionally within a date range. "
                "If no dates given, removes all weeks. "
                "If only week_start is given, removes from that date onwards through the planning horizon. "
                "Specify project_name as 'ALL' to remove the DS from all projects in the date range."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_scientist_name": {
                        "type": "string",
                        "description": "Name of the data scientist (partial match accepted)",
                    },
                    "project_name": {
                        "type": "string",
                        "description": "Name of the project (partial match accepted), or 'ALL' to clear across all projects",
                    },
                    "week_start": {
                        "type": ["string", "null"],
                        "description": "ISO date of first week to clear, or null for all weeks",
                    },
                    "week_end": {
                        "type": ["string", "null"],
                        "description": "ISO date of last week to clear (inclusive), or null for open-ended",
                    },
                },
                "required": ["data_scientist_name", "project_name"],
            },
        },
    },
    # ------------------------------------------------------------------ #
    # Query tools
    # ------------------------------------------------------------------ #
    {
        "type": "function",
        "function": {
            "name": "get_availability",
            "description": (
                "Get weekly free capacity (unallocated fraction) for one or all data scientists "
                "over a date range. Returns each DS's available allocation per week. "
                "Use this to find who is free to take on work, or to check scheduling gaps."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_scientist_name": {
                        "type": ["string", "null"],
                        "description": "Name of the data scientist (partial match), or null to return all",
                    },
                    "week_start": {
                        "type": ["string", "null"],
                        "description": "ISO date of first week to check, or null for next 4 weeks",
                    },
                    "week_end": {
                        "type": ["string", "null"],
                        "description": "ISO date of last week to check (inclusive), or null for open-ended (4 weeks from start)",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_conflicts",
            "description": (
                "Check for over-allocation conflicts across the entire schedule. "
                "Returns every data scientist / week pair where total allocation exceeds 100%. "
                "Call this after making assignments to verify the schedule is still valid."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_data_scientists",
            "description": (
                "Suggest data scientists best suited for a project based on skill matching. "
                "Returns a ranked list of DSs whose skills overlap with the project's required skills. "
                "Use this when asked who should work on a project."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {
                        "type": "string",
                        "description": "Name of the project (partial match accepted)",
                    },
                },
                "required": ["project_name"],
            },
        },
    },
    # ------------------------------------------------------------------ #
    # Update tools
    # ------------------------------------------------------------------ #
    {
        "type": "function",
        "function": {
            "name": "update_data_scientist",
            "description": (
                "Update one or more properties of a data scientist: "
                "name, level, efficiency, max_concurrent_projects, notes, or skills. "
                "Only specified fields are changed; omitted fields keep their current values. "
                "Skills list fully replaces existing skills if provided."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_scientist_name": {
                        "type": "string",
                        "description": "Current name of the data scientist (partial match accepted)",
                    },
                    "new_name": {
                        "type": ["string", "null"],
                        "description": "New name to rename to, or null to keep current",
                    },
                    "level": {
                        "type": ["string", "null"],
                        "description": "New seniority level (e.g. 'Junior DS', 'Senior DS'), or null to keep current",
                    },
                    "efficiency": {
                        "type": ["number", "null"],
                        "description": "New FTE capacity (e.g. 1.0 = 100%, 0.5 = part-time), or null to keep current",
                    },
                    "max_concurrent_projects": {
                        "type": ["integer", "null"],
                        "description": "Max projects at once, or null to keep current",
                    },
                    "notes": {
                        "type": ["string", "null"],
                        "description": "Notes to set (use empty string '' to clear notes), or null to keep current",
                    },
                    "skills": {
                        "type": ["array", "null"],
                        "items": {"type": "string"},
                        "description": "Full replacement list of skill tags (e.g. ['Python','SQL']), or null to keep current",
                    },
                },
                "required": ["data_scientist_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_project",
            "description": (
                "Update one or more properties of a project: "
                "name, start_date, end_date, or required_skills. "
                "Only specified fields are changed; omitted fields keep their current values."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {
                        "type": "string",
                        "description": "Current name of the project (partial match accepted)",
                    },
                    "new_name": {
                        "type": ["string", "null"],
                        "description": "New project name, or null to keep current",
                    },
                    "start_date": {
                        "type": ["string", "null"],
                        "description": "New start date (ISO format YYYY-MM-DD), or null to keep current",
                    },
                    "end_date": {
                        "type": ["string", "null"],
                        "description": "New end date (ISO format YYYY-MM-DD), or null to keep current",
                    },
                    "required_skills": {
                        "type": ["array", "null"],
                        "items": {"type": "string"},
                        "description": "Full replacement list of required skill tags, or null to keep current",
                    },
                },
                "required": ["project_name"],
            },
        },
    },
    # ------------------------------------------------------------------ #
    # Creation tools
    # ------------------------------------------------------------------ #
    {
        "type": "function",
        "function": {
            "name": "create_data_scientist",
            "description": (
                "Create a new data scientist record. "
                "Use only when the person does not yet exist — use update_data_scientist for existing people."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Full name of the new data scientist",
                    },
                    "level": {
                        "type": "string",
                        "description": "Seniority level, e.g. 'Junior DS', 'Senior DS'",
                    },
                    "efficiency": {
                        "type": "number",
                        "description": "FTE capacity multiplier, default 1.0",
                    },
                    "max_concurrent_projects": {
                        "type": "integer",
                        "description": "Max projects in parallel, default 2",
                    },
                    "notes": {
                        "type": ["string", "null"],
                        "description": "Optional free-text notes",
                    },
                    "skills": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of skill tags (e.g. ['Python', 'SQL'])",
                    },
                },
                "required": ["name", "level"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_project",
            "description": (
                "Create a new project. "
                "Use only when the project does not yet exist — use update_project for existing ones. "
                "Weekly FTE requirements default to 1.0 and can be adjusted later."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Project name",
                    },
                    "start_date": {
                        "type": "string",
                        "description": "Start date (ISO format YYYY-MM-DD)",
                    },
                    "end_date": {
                        "type": "string",
                        "description": "End date (ISO format YYYY-MM-DD)",
                    },
                    "required_skills": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Required skill tags for this project",
                    },
                },
                "required": ["name", "start_date", "end_date"],
            },
        },
    },
    # ------------------------------------------------------------------ #
    # Long-term memory tools
    # ------------------------------------------------------------------ #
    {
        "type": "function",
        "function": {
            "name": "remember_fact",
            "description": (
                "Store a user preference, habit, or note for future sessions. "
                "Use when the user states a general preference or when you observe a repeating pattern. "
                "Examples: 'user prefers 50% default allocation', 'user always assigns Yunxuan to ML projects'. "
                "If a memory with this key already exists, it is updated."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["preference", "habit", "note"],
                        "description": "Type of memory: preference=how the user likes things done, habit=observed pattern, note=misc fact",
                    },
                    "key": {
                        "type": "string",
                        "description": "Short identifier for this memory, e.g. 'default_allocation' or 'yunxuan_ml_affinity'",
                    },
                    "value": {
                        "type": "string",
                        "description": "The fact or preference to remember, in plain English",
                    },
                    "confidence": {
                        "type": "integer",
                        "description": "How certain you are this is a lasting preference (1=low, 5=high). Default 3.",
                        "minimum": 1,
                        "maximum": 5,
                    },
                },
                "required": ["category", "key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_memories",
            "description": (
                "Retrieve all stored long-term memories about the user's preferences and habits. "
                "Call this at the start of a new session or when you need to recall past context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": ["string", "null"],
                        "enum": ["preference", "habit", "note", None],
                        "description": "Filter by category, or null/omit for all memories",
                    },
                },
                "required": [],
            },
        },
    },
]

# Tools that do not modify data — used by the loop to decide whether to set data_changed=True.
READ_ONLY_TOOLS: frozenset[str] = frozenset({
    "get_availability",
    "check_conflicts",
    "suggest_data_scientists",
    "list_memories",
})
