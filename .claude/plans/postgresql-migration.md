# Plan: Migrate from JSON to PostgreSQL

## Context
The current app uses a single JSON file (`backend/data/store.json`) as its database. This works for a single user but breaks under concurrent access and doesn't scale. This plan migrates to PostgreSQL + SQLAlchemy while keeping the app fully runnable locally.

---

## Local Setup Required (one-time)
```bash
brew install postgresql
brew services start postgresql
createdb staffing
```

---

## Step 1: Update dependencies

**File**: `backend/requirements.txt`

Add:
- `sqlalchemy>=2.0`
- `psycopg2-binary`
- `alembic`

Remove:
- Nothing — keep existing deps for import/export (pandas, openpyxl)

---

## Step 2: Add SQLAlchemy ORM models

**New file**: `backend/app/database.py`

- `DATABASE_URL` env var (default: `postgresql://localhost/staffing`)
- SQLAlchemy `engine` and `SessionLocal`
- `Base = declarative_base()`
- `get_db()` dependency for FastAPI

**New file**: `backend/app/orm_models.py`

Four tables mirroring the existing Pydantic models:

| Table | Columns |
|-------|---------|
| `config` | id, granularity_weeks, horizon_weeks |
| `data_scientists` | id, name, level, max_concurrent_projects, efficiency, notes |
| `projects` | id, name, start_date, end_date |
| `project_weeks` | id, project_id (FK), week_start, fte |
| `assignments` | id, data_scientist_id (FK), project_id (FK), week_start, allocation |

---

## Step 3: Replace storage.py with DB-backed implementation

**File**: `backend/app/storage.py`

Replace the `Store` class JSON methods with SQLAlchemy session calls. Keep the same public method signatures so `main.py` needs no changes:

| Current method | New implementation |
|---------------|-------------------|
| `list_data_scientists()` | `db.query(DataScientistORM).all()` |
| `create_data_scientist()` | `db.add(...)`, `db.commit()` |
| `update_data_scientist()` | query + update + commit |
| `delete_data_scientist()` | query + delete + commit (cascades via FK) |
| same pattern for projects, assignments | — |
| `replace_assignments()` | delete all + bulk insert |
| `export_assignments()` | query + pandas DataFrame (unchanged) |
| `import_from_file()` | parse file + bulk insert (unchanged logic) |

Remove: `_save()`, `_load()`, `_ensure_seed_file()`, `threading.Lock` (PostgreSQL handles concurrency)

---

## Step 4: Set up Alembic migrations

```bash
cd backend
alembic init alembic
# edit alembic/env.py to point at orm_models.Base
alembic revision --autogenerate -m "initial schema"
alembic upgrade head
```

---

## Step 5: Seed the database

**File**: `backend/app/seed.py` (update or add a CLI entrypoint)

Add a `seed_db()` function that reads the existing `store.json` (or the original CSV/JSON seed files) and inserts rows via SQLAlchemy. Run once after migration:

```bash
python -m app.seed
```

---

## Step 6: Update main.py

**File**: `backend/app/main.py`

- Inject `db: Session = Depends(get_db)` into each route
- Pass `db` to storage methods
- Remove the module-level `store = get_store()` singleton

---

## Step 7: Environment config

**New file**: `backend/.env`
```
DATABASE_URL=postgresql://localhost/staffing
```

Add `python-dotenv` to requirements and load it in `database.py`.

---

## Files Changed

| File | Change |
|------|--------|
| `backend/requirements.txt` | Add sqlalchemy, psycopg2-binary, alembic, python-dotenv |
| `backend/app/database.py` | New — engine, session, Base |
| `backend/app/orm_models.py` | New — SQLAlchemy table definitions |
| `backend/app/storage.py` | Replace JSON logic with SQLAlchemy queries |
| `backend/app/main.py` | Inject db session dependency |
| `backend/app/seed.py` | Add `seed_db()` to load initial data |
| `backend/alembic/` | New — migration scripts |
| `backend/.env` | New — DATABASE_URL |

**Frontend**: No changes needed — API contract is identical.

---

## Verification

1. `alembic upgrade head` — tables created without error
2. `python -m app.seed` — rows inserted
3. Restart backend, hit `GET /data-scientists` — returns seeded data
4. Add a DS via UI, restart backend, confirm DS still present
5. `psql staffing -c "SELECT * FROM data_scientists;"` — confirms data in DB
