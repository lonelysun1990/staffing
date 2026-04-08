from __future__ import annotations

from datetime import date
from typing import List, Optional

from pydantic import BaseModel, Field, FieldValidationInfo, field_validator


class ConfigModel(BaseModel):
    """Application-level scheduling configuration."""

    granularity_weeks: int = Field(1, ge=1, description="Number of weeks per scheduling slot.")
    horizon_weeks: int = Field(26, ge=1, description="How many weeks ahead to plan.")


class ConfigUpdate(BaseModel):
    """Partial configuration update."""

    granularity_weeks: Optional[int] = Field(None, ge=1)
    horizon_weeks: Optional[int] = Field(None, ge=1)


class DataScientistBase(BaseModel):
    name: str
    level: str = Field(..., description="Seniority label such as Junior DS or Senior DS.")
    max_concurrent_projects: int = Field(
        1, ge=1, description="How many projects the person can take on in the same week."
    )
    efficiency: float = Field(
        1.0,
        ge=0.1,
        description="Full-time equivalent capacity (e.g. 1.2 means 120% of a single FTE).",
    )
    notes: Optional[str] = None
    skills: List[str] = Field(default_factory=list)


class DataScientistCreate(DataScientistBase):
    pass


class DataScientist(DataScientistBase):
    id: int


class ProjectWeek(BaseModel):
    week_start: date
    fte: float = Field(..., ge=0.0)


class ProjectBase(BaseModel):
    name: str
    start_date: date
    end_date: date
    fte_requirements: List[ProjectWeek] = Field(default_factory=list)
    required_skills: List[str] = Field(default_factory=list)

    @field_validator("end_date")
    @classmethod
    def validate_dates(cls, end_date: date, info: FieldValidationInfo) -> date:
        """
        Ensure the project end_date is not before the start_date.

        In Pydantic v2, field validators receive a ValidationInfo object instead of a values
        dict, so we must pull the already-validated fields from `info.data`.
        """
        start_date = info.data.get("start_date")
        if start_date and end_date < start_date:
            raise ValueError("end_date must be on or after start_date")
        return end_date


class ProjectCreate(ProjectBase):
    pass


class Project(ProjectBase):
    id: int


class AssignmentBase(BaseModel):
    data_scientist_id: int
    project_id: int
    week_start: date
    allocation: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Percentage of a week dedicated to the project (0-1).",
    )


class AssignmentCreate(AssignmentBase):
    pass


class Assignment(AssignmentBase):
    id: int


class AssignmentsPayload(BaseModel):
    assignments: List[AssignmentCreate]


class ImportResult(BaseModel):
    created_data_scientists: int = 0
    created_projects: int = 0
    created_assignments: int = 0
    replaced_existing_assignments: int = 0


class ConflictItem(BaseModel):
    data_scientist_id: int
    data_scientist_name: str
    week_start: str
    total_allocation: float
    over_by: float


class AuditLogItem(BaseModel):
    id: int
    assignment_id: Optional[int]
    action: str
    changed_by: Optional[str]
    changed_at: str
    details: Optional[dict] = None


class BulkAssignPayload(BaseModel):
    data_scientist_id: int
    project_id: int
    start_date: date
    end_date: date
    allocation: float = Field(..., ge=0.0, le=1.0)


class BulkRemovePayload(BaseModel):
    """Remove all assignments matching the given filters.

    At least one filter must be provided (data_scientist_id, project_id, week_start, or start_date).
    - week_start: remove assignments for exactly this week
    - start_date + end_date: remove assignments whose week_start falls in this date range
    """

    data_scientist_id: Optional[int] = None
    project_id: Optional[int] = None
    week_start: Optional[date] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None


# ---------------------------------------------------------------------------
# Chat session models
# ---------------------------------------------------------------------------

class ChatSessionSummary(BaseModel):
    id: int
    title: Optional[str]
    created_at: str
    updated_at: str
    message_count: int


class ChatSessionDetail(ChatSessionSummary):
    context_summary: Optional[str]


class SessionPatch(BaseModel):
    title: str


class ChatMessageOut(BaseModel):
    id: int
    role: str
    content: Optional[str]
    metadata: Optional[dict]
    created_at: str


class MemoryItem(BaseModel):
    id: int
    category: str
    key: str
    value: str
    confidence: int
    updated_at: str
