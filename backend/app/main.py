from __future__ import annotations

import json
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from . import storage
from .auth import (
    Token,
    UserCreate,
    UserORM,
    UserOut,
    create_access_token,
    get_current_user,
    get_user_or_none,
    hash_password,
    require_auth,
    require_manager,
    verify_password,
)
from .database import Base, engine, get_db, SessionLocal
from .models import (
    Assignment,
    AssignmentCreate,
    AssignmentsPayload,
    AuditLogItem,
    BulkAssignPayload,
    BulkRemovePayload,
    ChatMessageOut,
    ChatSessionDetail,
    ChatSessionSummary,
    ConfigModel,
    ConfigUpdate,
    ConflictItem,
    DataScientist,
    DataScientistCreate,
    ImportResult,
    MemoryItem,
    Project,
    ProjectCreate,
    SessionPatch,
)
from .orm_models import AgentMemoryORM, ChatSessionORM, ChatMessageORM
from .agent import AgentRequest, AgentResponse, run_agent, run_agent_stream
from .agent.chat_storage import create_session, get_session
from .seed_db import seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create tables and seed from store.json if database is empty."""
    Base.metadata.create_all(bind=engine)
    seed()  # Only seeds if database is empty
    yield


app = FastAPI(title="Staffing Scheduler", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_class=PlainTextResponse)
def health() -> str:
    return "ok"


# Auth ----------------------------------------------------------------------- #

@app.post("/auth/register", response_model=UserOut, status_code=201)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> UserOut:
    existing = db.query(UserORM).filter(UserORM.username == payload.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already taken")
    user = UserORM(username=payload.username, hashed_password=hash_password(payload.password), role=payload.role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserOut(id=user.id, username=user.username, role=user.role)


@app.post("/auth/token", response_model=Token)
def login(username: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)) -> Token:
    user = db.query(UserORM).filter(UserORM.username == username).first()
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": user.username, "role": user.role})
    return Token(access_token=token, token_type="bearer")


@app.get("/auth/me", response_model=UserOut)
def me(current_user: UserORM = Depends(require_auth)) -> UserOut:
    return UserOut(id=current_user.id, username=current_user.username, role=current_user.role)


# Config -------------------------------------------------------------------- #

@app.get("/config", response_model=ConfigModel)
def get_config(db: Session = Depends(get_db)) -> ConfigModel:
    return storage.get_config(db)


@app.put("/config", response_model=ConfigModel)
def update_config(payload: ConfigUpdate, db: Session = Depends(get_db)) -> ConfigModel:
    return storage.update_config(db, payload)


# Data scientists ------------------------------------------------------------ #

@app.get("/data-scientists", response_model=List[DataScientist])
def list_data_scientists(db: Session = Depends(get_db)) -> List[DataScientist]:
    return storage.list_data_scientists(db)


@app.post("/data-scientists", response_model=DataScientist, status_code=201)
def create_data_scientist(payload: DataScientistCreate, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> DataScientist:
    return storage.create_data_scientist(db, payload)


@app.put("/data-scientists/{ds_id}", response_model=DataScientist)
def update_data_scientist(ds_id: int, payload: DataScientistCreate, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> DataScientist:
    try:
        return storage.update_data_scientist(db, ds_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/data-scientists/{ds_id}", status_code=204, response_model=None)
def delete_data_scientist(ds_id: int, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> None:
    try:
        storage.delete_data_scientist(db, ds_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# Projects ------------------------------------------------------------------ #

@app.get("/projects", response_model=List[Project])
def list_projects(db: Session = Depends(get_db)) -> List[Project]:
    return storage.list_projects(db)


@app.post("/projects", response_model=Project, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> Project:
    return storage.create_project(db, payload)


@app.put("/projects/{project_id}", response_model=Project)
def update_project(project_id: int, payload: ProjectCreate, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> Project:
    try:
        return storage.update_project(db, project_id, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/projects/{project_id}", status_code=204, response_model=None)
def delete_project(project_id: int, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> None:
    try:
        storage.delete_project(db, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# Assignments --------------------------------------------------------------- #

@app.get("/assignments", response_model=List[Assignment])
def list_assignments(db: Session = Depends(get_db)) -> List[Assignment]:
    return storage.list_assignments(db)


@app.post("/assignments", response_model=Assignment, status_code=201)
def create_assignment(payload: AssignmentCreate, db: Session = Depends(get_db), current_user: Optional[UserORM] = Depends(get_user_or_none)) -> Assignment:
    try:
        changed_by = current_user.username if current_user else "anonymous"
        return storage.add_assignment(db, payload, changed_by=changed_by)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/assignments/{assignment_id}", status_code=204, response_model=None)
def delete_assignment(assignment_id: int, db: Session = Depends(get_db), current_user: Optional[UserORM] = Depends(get_user_or_none)) -> None:
    try:
        changed_by = current_user.username if current_user else "anonymous"
        storage.delete_assignment(db, assignment_id, changed_by=changed_by)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.put("/assignments", response_model=List[Assignment])
def replace_assignments(payload: AssignmentsPayload, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> List[Assignment]:
    try:
        return storage.replace_assignments(db, payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/assignments/bulk", status_code=200)
def bulk_remove(
    payload: BulkRemovePayload,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> dict:
    """Remove all assignments matching the given filters."""
    if all(v is None for v in [payload.data_scientist_id, payload.project_id, payload.week_start, payload.start_date]):
        raise HTTPException(status_code=400, detail="At least one filter must be specified")
    changed_by = current_user.username if current_user else "anonymous"
    count = storage.bulk_remove_assignments(
        db,
        data_scientist_id=payload.data_scientist_id,
        project_id=payload.project_id,
        week_start=payload.week_start,
        start_date=payload.start_date,
        end_date=payload.end_date,
        changed_by=changed_by,
    )
    return {"removed": count}


@app.post("/assignments/bulk", response_model=List[Assignment], status_code=201)
def bulk_assign(payload: BulkAssignPayload, db: Session = Depends(get_db), _: UserORM = Depends(require_manager)) -> List[Assignment]:
    """Assign a DS to a project for every week in a date range."""
    try:
        from datetime import timedelta
        results = []
        current = payload.start_date
        while current <= payload.end_date:
            a = storage.add_assignment(db, AssignmentCreate(
                data_scientist_id=payload.data_scientist_id,
                project_id=payload.project_id,
                week_start=current,
                allocation=payload.allocation,
            ))
            results.append(a)
            current += timedelta(weeks=1)
        return results
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# Capacity conflicts --------------------------------------------------------- #

@app.get("/conflicts", response_model=List[ConflictItem])
def get_conflicts(db: Session = Depends(get_db)) -> List[ConflictItem]:
    return storage.get_conflicts(db)


# Skills -------------------------------------------------------------------- #

@app.get("/skills", response_model=List[str])
def list_skills(db: Session = Depends(get_db)) -> List[str]:
    return storage.list_skills(db)


@app.get("/projects/{project_id}/suggest-ds", response_model=List[DataScientist])
def suggest_ds(project_id: int, db: Session = Depends(get_db)) -> List[DataScientist]:
    try:
        return storage.get_skill_suggestions(db, project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# Audit log ----------------------------------------------------------------- #

@app.get("/audit-logs", response_model=List[AuditLogItem])
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)) -> List[AuditLogItem]:
    return storage.list_audit_logs(db, limit=limit)


# Import/export ------------------------------------------------------------- #

@app.get("/export/csv")
def export_schedule(db: Session = Depends(get_db)) -> StreamingResponse:
    csv_content = storage.export_assignments(db)
    return StreamingResponse(
        iter([csv_content]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="schedule.csv"'},
    )


@app.get("/export/json")
def export_json(db: Session = Depends(get_db)) -> JSONResponse:
    """Export the full database state as JSON (store.json format).
    
    Use this to backup your data before the app goes offline.
    Save the response as store.json and commit to your repo to persist changes.
    """
    data = storage.export_full_json(db)
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": 'attachment; filename="store.json"'},
    )


@app.post("/import/json", response_model=ImportResult)
async def import_json(file: UploadFile = File(...), db: Session = Depends(get_db)) -> ImportResult:
    """Import data from a store.json file, replacing all existing data.
    
    Use this to restore a previously exported database state.
    """
    try:
        contents = await file.read()
        data = json.loads(contents.decode("utf-8"))
        return storage.import_full_json(db, data)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/agent/chat", response_model=AgentResponse)
def agent_chat(request: AgentRequest, db: Session = Depends(get_db)) -> AgentResponse:
    return run_agent(request, db)


@app.post("/agent/chat/stream")
async def agent_chat_stream(
    request: AgentRequest,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> StreamingResponse:
    """Streaming SSE endpoint. Events: text_delta, tool_call_start, tool_result, done, error."""
    return StreamingResponse(
        run_agent_stream(request, db, user_id=current_user.id if current_user else None),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Chat session routes
# ---------------------------------------------------------------------------

@app.get("/sessions", response_model=List[ChatSessionSummary])
def list_sessions(
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> List[ChatSessionSummary]:
    user_id = current_user.id if current_user else None
    q = db.query(ChatSessionORM).filter(ChatSessionORM.user_id == user_id)
    rows = q.order_by(ChatSessionORM.updated_at.desc()).all()
    return [
        ChatSessionSummary(
            id=r.id, title=r.title, created_at=r.created_at,
            updated_at=r.updated_at, message_count=r.message_count,
        )
        for r in rows
    ]


@app.post("/sessions", response_model=ChatSessionDetail, status_code=201)
def new_session(
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> ChatSessionDetail:
    user_id = current_user.id if current_user else None
    s = create_session(db, user_id)
    return ChatSessionDetail(
        id=s.id, title=s.title, created_at=s.created_at,
        updated_at=s.updated_at, message_count=s.message_count,
        context_summary=s.context_summary,
    )


@app.get("/sessions/{session_id}", response_model=ChatSessionDetail)
def get_session_detail(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> ChatSessionDetail:
    user_id = current_user.id if current_user else None
    s = get_session(db, session_id, user_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return ChatSessionDetail(
        id=s.id, title=s.title, created_at=s.created_at,
        updated_at=s.updated_at, message_count=s.message_count,
        context_summary=s.context_summary,
    )


@app.patch("/sessions/{session_id}", response_model=ChatSessionDetail)
def rename_session(
    session_id: int,
    body: SessionPatch,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> ChatSessionDetail:
    user_id = current_user.id if current_user else None
    s = get_session(db, session_id, user_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")
    s.title = body.title
    db.commit()
    return ChatSessionDetail(
        id=s.id, title=s.title, created_at=s.created_at,
        updated_at=s.updated_at, message_count=s.message_count,
        context_summary=s.context_summary,
    )


@app.delete("/sessions/{session_id}", status_code=204, response_class=Response)
def delete_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> Response:
    user_id = current_user.id if current_user else None
    s = get_session(db, session_id, user_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(s)
    db.commit()
    return Response(status_code=204)


@app.get("/sessions/{session_id}/messages", response_model=List[ChatMessageOut])
def get_session_messages(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> List[ChatMessageOut]:
    user_id = current_user.id if current_user else None
    s = get_session(db, session_id, user_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")
    import json as _json
    rows = (
        db.query(ChatMessageORM)
        .filter(ChatMessageORM.session_id == session_id)
        .order_by(ChatMessageORM.id)
        .all()
    )
    return [
        ChatMessageOut(
            id=r.id,
            role=r.role,
            content=r.content,
            metadata=_json.loads(r.meta) if r.meta else None,
            created_at=r.created_at,
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Memory routes
# ---------------------------------------------------------------------------

@app.get("/memories", response_model=List[MemoryItem])
def list_memories(
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> List[MemoryItem]:
    user_id = current_user.id if current_user else None
    rows = (
        db.query(AgentMemoryORM)
        .filter(AgentMemoryORM.user_id == user_id)
        .order_by(AgentMemoryORM.category, AgentMemoryORM.key)
        .all()
    )
    return [
        MemoryItem(
            id=r.id, category=r.category, key=r.key,
            value=r.value, confidence=r.confidence, updated_at=r.updated_at,
        )
        for r in rows
    ]


@app.delete("/memories/{memory_id}", status_code=204, response_class=Response)
def delete_memory(
    memory_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[UserORM] = Depends(get_user_or_none),
) -> Response:
    user_id = current_user.id if current_user else None
    m = db.query(AgentMemoryORM).filter(
        AgentMemoryORM.id == memory_id,
        AgentMemoryORM.user_id == user_id,
    ).first()
    if m is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    db.delete(m)
    db.commit()
    return Response(status_code=204)


@app.post("/import/schedule", response_model=ImportResult)
async def import_schedule(file: UploadFile = File(...), db: Session = Depends(get_db)) -> ImportResult:
    try:
        suffix = Path(file.filename or "schedule.xlsx").suffix.lower()
        if suffix not in (".csv", ".xlsx", ".xls"):
            raise ValueError(f"Unsupported file type: {suffix}")
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            contents = await file.read()
            tmp.write(contents)
            tmp_path = Path(tmp.name)
        result = storage.import_from_file(db, tmp_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        if "tmp_path" in locals() and tmp_path.exists():
            tmp_path.unlink()
    return result
