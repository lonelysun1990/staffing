from __future__ import annotations

from datetime import date

from sqlalchemy import (
    Column,
    Date,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship, backref

from .database import Base


class ConfigORM(Base):
    __tablename__ = "config"

    id = Column(Integer, primary_key=True, default=1)
    granularity_weeks = Column(Integer, nullable=False, default=1)
    horizon_weeks = Column(Integer, nullable=False, default=26)


class DataScientistORM(Base):
    __tablename__ = "data_scientists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    level = Column(String, nullable=False)
    max_concurrent_projects = Column(Integer, nullable=False, default=1)
    efficiency = Column(Float, nullable=False, default=1.0)
    notes = Column(Text, nullable=True)

    assignments = relationship(
        "AssignmentORM", back_populates="data_scientist", cascade="all, delete-orphan"
    )
    skills = relationship(
        "DataScientistSkillORM", back_populates="data_scientist", cascade="all, delete-orphan"
    )


class ProjectORM(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)

    fte_requirements = relationship(
        "ProjectWeekORM", back_populates="project", cascade="all, delete-orphan"
    )
    assignments = relationship(
        "AssignmentORM", back_populates="project", cascade="all, delete-orphan"
    )
    required_skills = relationship(
        "ProjectSkillORM", back_populates="project", cascade="all, delete-orphan"
    )


class ProjectWeekORM(Base):
    __tablename__ = "project_weeks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    week_start = Column(Date, nullable=False)
    fte = Column(Float, nullable=False)

    project = relationship("ProjectORM", back_populates="fte_requirements")


class AssignmentORM(Base):
    __tablename__ = "assignments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    data_scientist_id = Column(Integer, ForeignKey("data_scientists.id"), nullable=False)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    week_start = Column(Date, nullable=False)
    allocation = Column(Float, nullable=False)

    data_scientist = relationship("DataScientistORM", back_populates="assignments")
    project = relationship("ProjectORM", back_populates="assignments")
    audit_logs = relationship("AuditLogORM", back_populates="assignment", cascade="all, delete-orphan")


class DataScientistSkillORM(Base):
    __tablename__ = "data_scientist_skills"

    id = Column(Integer, primary_key=True, autoincrement=True)
    data_scientist_id = Column(Integer, ForeignKey("data_scientists.id"), nullable=False)
    skill = Column(String, nullable=False)

    __table_args__ = (UniqueConstraint("data_scientist_id", "skill"),)

    data_scientist = relationship("DataScientistORM", back_populates="skills")


class ProjectSkillORM(Base):
    __tablename__ = "project_skills"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    skill = Column(String, nullable=False)

    __table_args__ = (UniqueConstraint("project_id", "skill"),)

    project = relationship("ProjectORM", back_populates="required_skills")


class AuditLogORM(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=True)
    action = Column(String, nullable=False)  # "created", "updated", "deleted"
    changed_by = Column(String, nullable=True)
    changed_at = Column(String, nullable=False)  # ISO datetime string
    details = Column(Text, nullable=True)  # JSON string of what changed

    assignment = relationship("AssignmentORM", back_populates="audit_logs")


class ChatSessionORM(Base):
    __tablename__ = "chat_sessions"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=True)
    title           = Column(String, nullable=True)
    created_at      = Column(String, nullable=False)
    updated_at      = Column(String, nullable=False)
    message_count   = Column(Integer, nullable=False, default=0)
    context_summary = Column(Text, nullable=True)

    messages = relationship(
        "ChatMessageORM", back_populates="session",
        cascade="all, delete-orphan", order_by="ChatMessageORM.id"
    )


class ChatMessageORM(Base):
    __tablename__ = "chat_messages"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id"), nullable=False)
    role       = Column(String, nullable=False)   # "user" | "assistant" | "tool"
    content    = Column(Text, nullable=True)
    meta       = Column("metadata", Text, nullable=True)  # JSON: tool_calls or {tool_call_id, name}
    created_at = Column(String, nullable=False)

    session = relationship("ChatSessionORM", back_populates="messages")


class AgentMemoryORM(Base):
    __tablename__ = "agent_memories"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    user_id           = Column(Integer, ForeignKey("users.id"), nullable=True)
    category          = Column(String, nullable=False)   # "preference" | "habit" | "note"
    key               = Column(String, nullable=False)
    value             = Column(Text, nullable=False)
    source_session_id = Column(Integer, ForeignKey("chat_sessions.id"), nullable=True)
    confidence        = Column(Integer, nullable=False, default=3)  # 1–5
    created_at        = Column(String, nullable=False)
    updated_at        = Column(String, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "key"),)


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
