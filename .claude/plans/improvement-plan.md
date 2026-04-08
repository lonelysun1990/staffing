# Staffing App: Improvement Plan

## Context
This is a draft staffing planner for data science teams. The user wants to understand what's built and get suggestions for turning it into a production-ready staffing app.

## Persistence Note
`store.json` is the live database. On restart, the app reads from it if it exists — the original seed files (`pso_schedule.csv`, `data_scientists.json`) are only used once to create `store.json` if it is missing.

---

## What's Currently Implemented

### Tech Stack
- **Backend**: FastAPI + JSON file persistence (no real database)
- **Frontend**: React 18 + TypeScript + Vite

### Core Features
1. **Data Scientist Roster** — CRUD with name, level, efficiency, max concurrent projects
2. **Project Catalog** — CRUD with start/end dates and weekly FTE requirements
3. **Weekly Assignments** — Assign % of a DS's time to a project per week
4. **Gantt Chart** — By-person and by-project views with color-coded bars
5. **Settings** — Configure planning horizon and granularity
6. **Import/Export** — CSV/Excel upload; CSV download

### Known Limitations
- JSON file as database (not scalable, no concurrent multi-user support)
- No authentication or user accounts
- No capacity conflict detection or warnings
- No optimization / auto-scheduling
- No notifications or approval workflows
- No historical tracking or audit trail
- No search/filter capabilities
- Frontend state managed with only useState (no global store)
- No tests on the frontend

---

## Suggested Improvements (Prioritized)

### Priority 1: Foundation (Must-haves for a real app)

1. **Replace JSON with a real database**
   - PostgreSQL with SQLAlchemy ORM
   - Alembic for schema migrations
   - Enables concurrent access, transactions, proper queries

2. **Authentication & Authorization**
   - JWT-based auth (FastAPI-Users or similar)
   - Roles: Admin (manages roster), Manager (assigns), Viewer (read-only)

3. **Capacity Conflict Detection**
   - Backend validation: warn when a DS exceeds 100% allocation in a week
   - Frontend: highlight overbooked weeks in red on the Gantt chart
   - Alert when a project's FTE needs are unmet

### Priority 2: Core UX Improvements

4. **Drag-and-drop assignment on Gantt**
   - Use react-beautiful-dnd or dnd-kit
   - Click a cell on the Gantt to assign, resize bars to change duration

5. **Search & Filter**
   - Filter Gantt by team, project, date range, skill
   - Search bar for data scientists and projects

6. **Dashboard / Overview Page**
   - Team utilization summary (% capacity used per week)
   - Unassigned capacity per person
   - Projects with unmet FTE requirements
   - Charts: bar chart of weekly team utilization

7. **Bulk Scheduling Actions**
   - Assign a DS to a project for an entire date range in one click
   - Copy assignments from one period to another

### Priority 3: Advanced Features

8. **Skills & Matching**
   - Add skill tags to data scientists (Python, ML, NLP, etc.)
   - Add skill requirements to projects
   - Highlight skill gaps when assigning

9. **Auto-Suggest / Optimization**
   - Given project requirements, suggest best-fit DSs based on availability and skills
   - Simple greedy or LP-based scheduling

10. **Notifications & Approvals**
    - Email/Slack notifications when assignments change
    - Manager approval workflow for assignment requests

11. **Historical Tracking & Audit**
    - Track changes to assignments over time (who changed what, when)
    - Compare planned vs. actual allocations after project completion

12. **Multi-team Support**
    - Org hierarchy: teams within departments
    - Cross-team resource sharing and visibility controls

---

## Critical Files to Modify (for Priority 1)
- `backend/app/storage.py` → replace with SQLAlchemy session
- `backend/app/models.py` → add SQLAlchemy ORM models alongside Pydantic schemas
- `backend/app/main.py` → add auth middleware, database dependency injection
- `frontend/src/App.tsx` → extract state into React Context or Zustand store
- `frontend/src/api.ts` → add auth token headers
