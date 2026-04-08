# Plan: UI CRUD & Persistence Fixes

## Context

The user wants two things:
1. Add/remove data scientists and projects from the UI
2. Ensure all changes (DS, projects, assignments) persist to the JSON store and reload correctly

**Key finding from exploration**: DS and project CRUD is already fully implemented end-to-end (UI → API → storage.py → store.json). The gap is **assignments**, which currently use a draft-only pattern: changes are buffered locally and only persisted when the user clicks "Save assignments." If they forget to click Save, all assignment changes are lost.

---

## What's Already Working

| Feature | Status |
|---------|--------|
| Add/edit/delete Data Scientist | ✓ Done — persists immediately |
| Add/edit/delete Project | ✓ Done — persists immediately |
| Add Assignment | Draft only — NOT persisted until "Save all" |
| Remove Assignment | Draft only — NOT persisted until "Save all" |
| Edit allocation % | Draft only — NOT persisted until "Save all" |
| Config update | ✓ Done — persists immediately |

---

## Plan

### 1. Backend: Add individual assignment endpoints

**File**: `backend/app/main.py`
**File**: `backend/app/storage.py`

Add two new endpoints:

```
POST /assignments          → create single assignment, returns it with generated id
DELETE /assignments/{id}   → delete single assignment by id
```

In `storage.py`, add:
- `add_assignment(assignment_data) -> Assignment` — appends to list, saves, returns with id
- `delete_assignment(assignment_id)` — removes from list by id, saves

The existing `PUT /assignments` (batch replace) stays for import use.

### 2. Frontend: Auto-persist assignment changes

**File**: `frontend/src/api.ts`

Add:
- `createAssignment(payload)` → POST `/assignments`
- `deleteAssignment(id)` → DELETE `/assignments/{id}`

**File**: `frontend/src/App.tsx`

Change `handleAddAssignment()`:
- Currently: pushes to local state only
- New: call `api.createAssignment()`, then update local state with the returned assignment (which now has a real server-assigned `id`)

Change remove assignment handler:
- Currently: filters local state only
- New: call `api.deleteAssignment(id)`, then filter local state on success

Change inline allocation edit (on blur/save):
- Currently: edits local state, requires "Save all"
- New: call `api.replaceAssignments(allAssignments)` after each inline edit (reuse existing batch endpoint since there's no individual PUT)

Remove or demote the "Save assignments" button — no longer needed for add/remove. Keep it optionally for bulk edits.

### 3. Persistence verification

All writes go through `storage.py`'s `Store._save()` which writes synchronously to `backend/data/store.json` after each operation. On restart, `Store.__init__` calls `_load()` which reads from that file. No additional changes needed for persistence.

---

## Files to Change

| File | Change |
|------|--------|
| `backend/app/storage.py` | Add `add_assignment()` and `delete_assignment()` methods |
| `backend/app/main.py` | Add `POST /assignments` and `DELETE /assignments/{id}` routes |
| `frontend/src/api.ts` | Add `createAssignment()` and `deleteAssignment()` |
| `frontend/src/App.tsx` | Update `handleAddAssignment()` and remove handler to call API immediately |

---

## Verification

1. Add a data scientist → refresh page → DS should still be there
2. Add a project → refresh page → project should still be there
3. Add an assignment → refresh page → assignment should still be there (currently fails, will pass after fix)
4. Delete an assignment → refresh page → assignment should be gone (currently fails, will pass after fix)
5. Check `backend/data/store.json` directly after each operation to confirm writes
