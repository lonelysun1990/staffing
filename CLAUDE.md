# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A full-stack web app for scheduling data scientists to projects on a weekly basis. Features include: weekly assignment tracking, conflict detection (overallocation), skill matching, role-based auth (admin/manager/viewer), AI chat assistant (OpenAI), and Excel/CSV/JSON import/export.

**Stack:** FastAPI + SQLAlchemy + PostgreSQL (backend) · React 18 + TypeScript + Vite (frontend) · @dnd-kit for drag-drop

## Development Commands

### Backend
```bash
cd backend
source .venv/bin/activate          # activate virtualenv
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
pytest                              # run all tests
pytest tests/test_foo.py::test_bar  # run single test
```

### Frontend
```bash
cd frontend
npm run dev     # dev server at :5173
npm run build   # TypeScript check + Vite build
npm run lint    # ESLint (--max-warnings 0, no warnings allowed)
```

### Environment Setup
- Backend: copy `backend/.env.example` → `backend/.env` (needs `DATABASE_URL`, `SECRET_KEY`, `OPENAI_API_KEY`)
- Frontend: copy `frontend/.env.example` → `frontend/.env` (needs `VITE_API_BASE_URL`, defaults to `http://localhost:8000`)

## Architecture

### Backend (`/backend/app/`)

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app, all route definitions, CORS, lifespan startup (creates tables, seeds DB from `data/store.json` if empty) |
| `storage.py` | Business logic — all CRUD, conflict detection, import/export helpers |
| `orm_models.py` | SQLAlchemy ORM models (DataScientist, Project, Assignment, AuditLog, User, etc.) |
| `models.py` | Pydantic schemas for request/response validation |
| `agent.py` | OpenAI-powered chat agent with structured function tools (`set_assignment`, `clear_assignment`, etc.) |
| `auth.py` | JWT auth, bcrypt hashing, `require_auth` / `require_manager` decorators |
| `database.py` | SQLAlchemy engine + session setup |
| `seed_db.py` | DB seeding logic |

**API route groups:** `/auth/*`, `/data-scientists`, `/projects`, `/assignments`, `/skills`, `/conflicts`, `/audit-logs`, `/import/*`, `/export/*`, `/agent/chat`, `/config`, `/health`

### Frontend (`/frontend/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | Main component — login screen, all tab views, all state management |
| `api.ts` | Fetch wrapper that injects JWT from localStorage; dispatches `unauth` event on 401 |
| `types.ts` | TypeScript interfaces mirroring backend Pydantic schemas |
| `GanttChart.tsx` | Gantt chart visualization component |
| `ChatPanel.tsx` | Chat UI for the AI agent |

Path alias `@/*` → `src/*` is configured in tsconfig/vite.

### Data Model Conventions
- **Allocations** are stored as fractions `0.0–1.0` (e.g., 25% = `0.25`)
- **Time** is weekly granularity using ISO week start dates
- **Efficiency multiplier** on DS allows > 100% capacity (e.g., 1.2 = 120%)
- All mutations are audit-logged with `changed_by`, `changed_at`, `action`

### Deployment
Deployed on Railway.com — see `backend/railway.toml` and `backend/Procfile`.
