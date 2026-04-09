import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { ChatPanel } from "./ChatPanel";
import { GanttChart } from "./GanttChart";
import {
  Assignment,
  AssignmentPayload,
  AuditLogItem,
  BulkAssignPayload,
  BulkRemovePayload,
  Config,
  ConflictItem,
  DataScientist,
  DataScientistPayload,
  ImportResult,
  Project,
  ProjectPayload,
  User,
} from "./types";
import "./App.css";

type TabKey =
  | "schedule"
  | "dataScientists"
  | "projects"
  | "dashboard"
  | "conflicts"
  | "auditLog"
  | "settings"
  | "importExport"
  | "console";

const TAB_LABELS: Record<TabKey, string> = {
  dataScientists: "Data Scientists",
  projects: "Projects",
  schedule: "Schedule",
  dashboard: "Dashboard",
  conflicts: "Conflicts",
  auditLog: "Audit Log",
  settings: "Settings",
  importExport: "Import / Export",
  console: "Console",
};

const startOfWeek = (input: Date) => {
  const copy = new Date(input);
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1);
  copy.setDate(diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const toISODate = (date: Date) => date.toISOString().split("T")[0];

// Simple tag input component
function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const add = () => {
    const t = input.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput("");
  };
  return (
    <div className="tag-input">
      <div className="tag-input__tags">
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
            <button onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>
          </span>
        ))}
      </div>
      <div className="tag-input__row">
        <input
          type="text"
          value={input}
          placeholder={placeholder ?? "Add tag..."}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="ghost" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string, username: string, role: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [isRegister, setIsRegister] = useState(false);

  const submit = async () => {
    try {
      if (isRegister) {
        await api.register({ username, password, role: "manager" });
      }
      const { access_token } = await api.login(username, password);
      const user = await api.me(access_token);
      onLogin(access_token, user.username, user.role);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <p className="eyebrow">Staffing Scheduler</p>
        <h1>{isRegister ? "Create account" : "Sign in"}</h1>
        {err && <div className="alert danger">{err}</div>}
        <label>Username<input type="text" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} /></label>
        <button className="primary" onClick={submit}>{isRegister ? "Register & sign in" : "Sign in"}</button>
        <button className="ghost" onClick={() => { setIsRegister(!isRegister); setErr(null); }}>
          {isRegister ? "Already have an account? Sign in" : "No account? Register"}
        </button>
      </div>
    </div>
  );
}

function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem("auth_token"));
  const [currentUser, setCurrentUser] = useState<{ username: string; role: string } | null>(null);
  const [tab, setTab] = useState<TabKey>("schedule");
  const [config, setConfig] = useState<Config>({ granularity_weeks: 1, horizon_weeks: 26 });
  const [dataScientists, setDataScientists] = useState<DataScientist[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // DS form
  const [dsForm, setDsForm] = useState<DataScientistPayload>({
    name: "",
    level: "Junior DS",
    max_concurrent_projects: 1,
    efficiency: 1,
    notes: "",
    skills: [],
  });
  const [editingDsId, setEditingDsId] = useState<number | null>(null);
  const [dsSearch, setDsSearch] = useState("");

  // Project form
  const [projectForm, setProjectForm] = useState({
    name: "",
    start_date: toISODate(startOfWeek(new Date())),
    duration_weeks: 12,
    weeklyFte: 1,
    required_skills: [] as string[],
  });
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [suggestions, setSuggestions] = useState<DataScientist[] | null>(null);

  // Assignment form
  const [newAssignment, setNewAssignment] = useState<AssignmentPayload>({
    data_scientist_id: 0,
    project_id: 0,
    week_start: toISODate(startOfWeek(new Date())),
    allocation: 0.25,
  });

  // Bulk assign form — end_date defaults 4 weeks ahead of start
  const [bulkForm, setBulkForm] = useState<BulkAssignPayload>(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(start.getDate() + 4 * 7);
    return {
      data_scientist_id: 0,
      project_id: 0,
      start_date: toISODate(start),
      end_date: toISODate(end),
      allocation: 0.5,
    };
  });

  // Assign mode toggle: single week vs date range
  const [assignMode, setAssignMode] = useState<"single" | "range">("single");

  // Remove mode toggle: single week vs date range
  const [removeMode, setRemoveMode] = useState<"single" | "range">("single");

  // Bulk remove form
  const [bulkRemoveForm, setBulkRemoveForm] = useState<BulkRemovePayload>({
    data_scientist_id: null,
    project_id: null,
    week_start: null,
    start_date: null,
    end_date: null,
  });

  // Schedule list pagination
  const [schedulePage, setSchedulePage] = useState(0);
  const SCHEDULE_PAGE_SIZE = 20;

  // Schedule list filters
  const [scheduleFilter, setScheduleFilter] = useState({
    ds_id: 0,        // 0 = all
    project_id: 0,   // 0 = all
    date_from: "",
    date_to: "",
    conflicts_only: false,
  });

  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  // User management state (admin only)
  const [users, setUsers] = useState<User[]>([]);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [newUserForm, setNewUserForm] = useState({ username: "", password: "", role: "manager" });
  const [userMgmtError, setUserMgmtError] = useState<string | null>(null);

  // Console state
  const [consoleSql, setConsoleSql] = useState("SELECT * FROM data_scientists LIMIT 50;");
  const [consoleResult, setConsoleResult] = useState<{ columns: string[]; rows: unknown[][]; row_count: number } | null>(null);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [consoleLoading, setConsoleLoading] = useState(false);

  const weeks = useMemo(() => {
    const slots: string[] = [];
    const start = startOfWeek(new Date());
    for (let i = 0; i < config.horizon_weeks; i += config.granularity_weeks) {
      const week = new Date(start);
      week.setDate(start.getDate() + i * 7);
      slots.push(toISODate(week));
    }
    return slots;
  }, [config]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [configRes, dsList, projectList, assignmentList, conflictList] = await Promise.all([
        api.getConfig(),
        api.listDataScientists(),
        api.listProjects(),
        api.listAssignments(),
        api.getConflicts(),
      ]);
      setConfig(configRes);
      setDataScientists(dsList);
      setProjects(projectList);
      setAssignments(assignmentList);
      setConflicts(conflictList);
      setNewAssignment((prev) => ({
        ...prev,
        data_scientist_id: dsList[0]?.id ?? 0,
        project_id: projectList[0]?.id ?? 0,
        week_start: weeks[0] ?? prev.week_start,
      }));
      setBulkForm((prev) => ({
        ...prev,
        data_scientist_id: dsList[0]?.id ?? 0,
        project_id: projectList[0]?.id ?? 0,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ #
  // Handlers
  // ------------------------------------------------------------------ #

  const handleSaveDataScientist = async () => {
    try {
      if (!dsForm.name.trim()) throw new Error("Name is required");
      if (editingDsId) {
        const updated = await api.updateDataScientist(editingDsId, dsForm);
        setDataScientists((prev) => prev.map((ds) => (ds.id === updated.id ? updated : ds)));
        setStatus(`Updated ${updated.name}`);
      } else {
        const created = await api.createDataScientist(dsForm);
        setDataScientists((prev) => [...prev, created]);
        setStatus(`Added ${created.name}`);
      }
      setDsForm({ name: "", level: "Junior DS", max_concurrent_projects: 1, efficiency: 1, notes: "", skills: [] });
      setEditingDsId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save data scientist");
    }
  };

  const handleDeleteDataScientist = async (id: number) => {
    try {
      await api.deleteDataScientist(id);
      setDataScientists((prev) => prev.filter((ds) => ds.id !== id));
      setAssignments((prev) => prev.filter((a) => a.data_scientist_id !== id));
      setStatus("Removed data scientist");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete");
    }
  };

  const buildProjectPayload = (): ProjectPayload => {
    const start = new Date(projectForm.start_date);
    const end = new Date(start);
    end.setDate(start.getDate() + (projectForm.duration_weeks - 1) * 7);
    const fte_requirements = Array.from({ length: projectForm.duration_weeks }).map((_, idx) => {
      const week = new Date(start);
      week.setDate(start.getDate() + idx * 7);
      return { week_start: toISODate(week), fte: Number(projectForm.weeklyFte) };
    });
    return {
      name: projectForm.name,
      start_date: toISODate(start),
      end_date: toISODate(end),
      fte_requirements,
      required_skills: projectForm.required_skills,
    };
  };

  const handleSaveProject = async () => {
    try {
      if (!projectForm.name.trim()) throw new Error("Project name is required");
      const payload = buildProjectPayload();
      if (editingProjectId) {
        const updated = await api.updateProject(editingProjectId, payload);
        setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        setStatus(`Updated project ${updated.name}`);
      } else {
        const created = await api.createProject(payload);
        setProjects((prev) => [...prev, created]);
        setStatus(`Added project ${created.name}`);
      }
      setProjectForm({ name: "", start_date: toISODate(startOfWeek(new Date())), duration_weeks: 12, weeklyFte: 1, required_skills: [] });
      setEditingProjectId(null);
      setSuggestions(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save project");
    }
  };

  const handleDeleteProject = async (id: number) => {
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setAssignments((prev) => prev.filter((a) => a.project_id !== id));
      setStatus("Removed project");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete project");
    }
  };

  const handleAddAssignment = async () => {
    if (!newAssignment.data_scientist_id || !newAssignment.project_id) {
      setError("Select a data scientist and project first");
      return;
    }
    try {
      const created = await api.createAssignment(newAssignment);
      setAssignments((prev) => [...prev, created]);
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
      setStatus("Assignment saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save assignment");
    }
  };

  const handleMoveAssignment = async (
    assignmentId: number,
    newWeekStart: string,
    newDsId: number,
    newProjectId: number
  ) => {
    const assignment = assignments.find((a) => a.id === assignmentId);
    if (!assignment) return;
    if (
      assignment.week_start === newWeekStart &&
      assignment.data_scientist_id === newDsId &&
      assignment.project_id === newProjectId
    ) return;
    try {
      await api.deleteAssignment(assignmentId);
      const created = await api.createAssignment({
        data_scientist_id: newDsId,
        project_id: newProjectId,
        week_start: newWeekStart,
        allocation: assignment.allocation,
      });
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId).concat(created));
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move assignment");
    }
  };

  const handleEditAllocation = async (assignmentId: number, newAllocation: number) => {
    const assignment = assignments.find((a) => a.id === assignmentId);
    if (!assignment || assignment.allocation === newAllocation) return;
    try {
      await api.deleteAssignment(assignmentId);
      const created = await api.createAssignment({
        data_scientist_id: assignment.data_scientist_id,
        project_id: assignment.project_id,
        week_start: assignment.week_start,
        allocation: newAllocation,
      });
      setAssignments((prev) => prev.filter((a) => a.id !== assignmentId).concat(created));
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update allocation");
    }
  };

  const handleCreateAssignmentFromChart = async (
    dsId: number,
    projectId: number,
    weekStart: string,
    allocation: number
  ) => {
    try {
      const created = await api.createAssignment({
        data_scientist_id: dsId,
        project_id: projectId,
        week_start: weekStart,
        allocation,
      });
      setAssignments((prev) => prev.concat(created));
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
      setStatus("Assignment created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create assignment");
    }
  };

  const handleDeleteAssignment = async (id: number) => {
    try {
      await api.deleteAssignment(id);
      setAssignments((prev) => prev.filter((row) => row.id !== id));
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove assignment");
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkForm.data_scientist_id || !bulkForm.project_id) {
      setError("Select a data scientist and project first");
      return;
    }
    if (bulkForm.start_date > bulkForm.end_date) {
      setError("End date must be on or after start date");
      return;
    }
    try {
      const created = await api.bulkAssign(bulkForm);
      setAssignments((prev) => [...prev, ...created]);
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
      setStatus(`Created ${created.length} assignments`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to bulk assign");
    }
  };

  const handleBulkRemove = async () => {
    const { data_scientist_id, project_id, week_start, start_date } = bulkRemoveForm;
    if (!data_scientist_id && !project_id && !week_start && !start_date) {
      setError("Select at least one filter (person, project, or date) to remove");
      return;
    }
    try {
      const result = await api.bulkRemove(bulkRemoveForm);
      // Refresh assignments from server after removal
      const [updated, updatedConflicts] = await Promise.all([
        api.listAssignments(),
        api.getConflicts(),
      ]);
      setAssignments(updated);
      setConflicts(updatedConflicts);
      setStatus(`Removed ${result.removed} assignment${result.removed !== 1 ? "s" : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove assignments");
    }
  };

  const handleSaveAssignments = async () => {
    try {
      const payload: AssignmentPayload[] = assignments.map(
        ({ data_scientist_id, project_id, week_start, allocation }) => ({
          data_scientist_id, project_id, week_start, allocation,
        })
      );
      const saved = await api.replaceAssignments(payload);
      setAssignments(saved);
      const updatedConflicts = await api.getConflicts();
      setConflicts(updatedConflicts);
      setStatus("Assignments saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save assignments");
    }
  };

  const handleImport = async (file?: File | null) => {
    if (!file) return;
    try {
      const result = await api.importSchedule(file);
      setImportResult(result);
      await loadData();
      setStatus("Imported schedule");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import file");
    }
  };

  const handleExport = async () => {
    try {
      const blob = await api.exportSchedule();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "schedule.csv";
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Exported schedule");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to export");
    }
  };

  const handleImportJson = async (file?: File | null) => {
    if (!file) return;
    try {
      const result = await api.importJson(file);
      setImportResult(result);
      await loadData();
      setStatus("Imported JSON backup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import JSON file");
    }
  };

  const handleExportJson = async () => {
    try {
      const blob = await api.exportJson();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "store.json";
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Exported JSON backup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to export JSON");
    }
  };

  const loadUsers = async () => {
    if (currentUser?.role !== "admin") return;
    try {
      setUsers(await api.listUsers());
    } catch { /* non-admin gets 403, silently ignored */ }
  };

  const handleUpdateUserRole = async (userId: number, role: string) => {
    try {
      const updated = await api.updateUser(userId, { role });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setUserMgmtError(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const handleDeleteUser = async (userId: number) => {
    try {
      await api.deleteUser(userId);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (err) {
      setUserMgmtError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const handleAdminCreateUser = async () => {
    setUserMgmtError(null);
    if (!newUserForm.username.trim() || !newUserForm.password.trim()) {
      setUserMgmtError("Username and password are required");
      return;
    }
    try {
      const created = await api.adminCreateUser(newUserForm);
      setUsers((prev) => [...prev, created]);
      setNewUserForm({ username: "", password: "", role: "manager" });
      setUserFormOpen(false);
      setStatus(`User '${created.username}' created`);
    } catch (err) {
      setUserMgmtError(err instanceof Error ? err.message : "Failed to create user");
    }
  };

  const handleConsoleRun = async () => {
    const sql = consoleSql.trim();
    if (!sql) return;
    setConsoleLoading(true);
    setConsoleError(null);
    setConsoleResult(null);
    try {
      const result = await api.consoleQuery(sql);
      setConsoleResult(result);
    } catch (err) {
      setConsoleError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setConsoleLoading(false);
    }
  };

  const handleConfigUpdate = async (updates: Partial<Config>) => {
    try {
      const updated = await api.updateConfig(updates);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update config");
    }
  };

  const handleSuggestDs = async (projectId: number) => {
    try {
      const result = await api.suggestDs(projectId);
      setSuggestions(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch suggestions");
    }
  };

  const handleLoadAuditLogs = async () => {
    try {
      const logs = await api.listAuditLogs(200);
      setAuditLogs(logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit logs");
    }
  };

  // ------------------------------------------------------------------ #
  // Computed
  // ------------------------------------------------------------------ #

  const projectLookup = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects]
  );
  const dsLookup = useMemo(
    () => Object.fromEntries(dataScientists.map((ds) => [ds.id, ds])),
    [dataScientists]
  );

  const weeklySummary = useMemo(() => {
    const summary: Record<string, number> = {};
    assignments.forEach((a) => {
      summary[a.week_start] = (summary[a.week_start] || 0) + a.allocation;
    });
    return summary;
  }, [assignments]);

  // Dashboard: utilization per week (total allocated / total capacity)
  const totalCapacity = useMemo(
    () => dataScientists.reduce((sum, ds) => sum + ds.efficiency, 0),
    [dataScientists]
  );

  const dashboardWeeks = useMemo(() => weeks.slice(0, 12), [weeks]);

  const weeklyUtilization = useMemo(() => {
    return dashboardWeeks.map((week) => ({
      week,
      allocated: weeklySummary[week] ?? 0,
      utilization: totalCapacity > 0 ? ((weeklySummary[week] ?? 0) / totalCapacity) * 100 : 0,
    }));
  }, [dashboardWeeks, weeklySummary, totalCapacity]);

  // Per-person utilization for current week
  const currentWeek = weeks[0];
  const personUtilization = useMemo(() => {
    const byPerson: Record<number, number> = {};
    assignments
      .filter((a) => a.week_start === currentWeek)
      .forEach((a) => {
        byPerson[a.data_scientist_id] = (byPerson[a.data_scientist_id] ?? 0) + a.allocation;
      });
    return dataScientists.map((ds) => ({
      ds,
      allocated: byPerson[ds.id] ?? 0,
      pct: Math.round(((byPerson[ds.id] ?? 0) / ds.efficiency) * 100),
    }));
  }, [dataScientists, assignments, currentWeek]);

  // Projects with unmet FTE (comparing required vs allocated this week)
  const projectFteStatus = useMemo(() => {
    const allocatedByProject: Record<number, number> = {};
    assignments
      .filter((a) => a.week_start === currentWeek)
      .forEach((a) => {
        allocatedByProject[a.project_id] = (allocatedByProject[a.project_id] ?? 0) + a.allocation;
      });
    return projects.map((p) => {
      const required = p.fte_requirements.find((w) => w.week_start === currentWeek)?.fte ?? 0;
      const allocated = allocatedByProject[p.id] ?? 0;
      return { project: p, required, allocated, gap: Math.max(0, required - allocated) };
    }).filter((x) => x.required > 0);
  }, [projects, assignments, currentWeek]);

  const filteredDs = useMemo(
    () =>
      dataScientists.filter(
        (ds) =>
          ds.name.toLowerCase().includes(dsSearch.toLowerCase()) ||
          ds.level.toLowerCase().includes(dsSearch.toLowerCase())
      ),
    [dataScientists, dsSearch]
  );

  const filteredProjects = useMemo(
    () =>
      projects.filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase())),
    [projects, projectSearch]
  );

  // Schedule list: filtered assignments (by person, project, date range, conflicts)
  const filteredAssignments = useMemo(() => {
    const conflictSet = new Set(
      conflicts.map((c) => `${c.data_scientist_id}::${c.week_start}`)
    );
    return assignments.filter((a) => {
      if (scheduleFilter.ds_id && a.data_scientist_id !== scheduleFilter.ds_id) return false;
      if (scheduleFilter.project_id && a.project_id !== scheduleFilter.project_id) return false;
      if (scheduleFilter.date_from && a.week_start < scheduleFilter.date_from) return false;
      if (scheduleFilter.date_to && a.week_start > scheduleFilter.date_to) return false;
      if (scheduleFilter.conflicts_only && !conflictSet.has(`${a.data_scientist_id}::${a.week_start}`)) return false;
      return true;
    });
  }, [assignments, scheduleFilter, conflicts]);

  const totalSchedulePages = Math.max(1, Math.ceil(filteredAssignments.length / SCHEDULE_PAGE_SIZE));
  const pagedAssignments = filteredAssignments.slice(
    schedulePage * SCHEDULE_PAGE_SIZE,
    (schedulePage + 1) * SCHEDULE_PAGE_SIZE
  );

  // Dashboard: lifetime FTE status per project (all weeks, not just current)
  const projectFteLifetimeStatus = useMemo(() => {
    const allocByProject: Record<number, number> = {};
    const firstWeek: Record<number, string> = {};
    const lastWeek: Record<number, string> = {};
    assignments.forEach((a) => {
      allocByProject[a.project_id] = (allocByProject[a.project_id] ?? 0) + a.allocation;
      if (!firstWeek[a.project_id] || a.week_start < firstWeek[a.project_id])
        firstWeek[a.project_id] = a.week_start;
      if (!lastWeek[a.project_id] || a.week_start > lastWeek[a.project_id])
        lastWeek[a.project_id] = a.week_start;
    });
    return projects
      .map((p) => {
        const totalRequired = p.fte_requirements.reduce((s, w) => s + w.fte, 0);
        const numWeeks = p.fte_requirements.length;
        const avgRequired = numWeeks > 0 ? totalRequired / numWeeks : 0;
        const totalAllocated = allocByProject[p.id] ?? 0;
        const lifetimeGap = Math.max(0, totalRequired - totalAllocated);
        const avgAllocated = numWeeks > 0 ? totalAllocated / numWeeks : 0;
        const firstAssignment = firstWeek[p.id] ?? null;
        const lastAssignment = lastWeek[p.id] ?? null;
        // Timing mismatches
        const lateStart = firstAssignment !== null && firstAssignment > p.start_date;
        const earlyEnd = lastAssignment !== null && lastAssignment < p.end_date;
        const overEnd = lastAssignment !== null && lastAssignment > p.end_date;
        return {
          project: p,
          totalRequired,
          totalAllocated,
          lifetimeGap,
          avgRequired,
          avgAllocated,
          firstAssignment,
          lastAssignment,
          lateStart,
          earlyEnd,
          overEnd,
          hasTimingIssue: lateStart || earlyEnd || overEnd,
        };
      })
      .filter((x) => x.totalRequired > 0);
  }, [projects, assignments]);

  const handleLogin = (token: string, username: string, role: string) => {
    localStorage.setItem("auth_token", token);
    setAuthToken(token);
    setCurrentUser({ username, role });
  };

  const handleLogout = () => {
    localStorage.removeItem("auth_token");
    setAuthToken(null);
    setCurrentUser(null);
  };

  useEffect(() => {
    const handler = () => handleLogout();
    window.addEventListener("auth:unauthorized", handler);
    return () => window.removeEventListener("auth:unauthorized", handler);
  }, []);

  const resetMessages = () => {
    setError(null);
    setStatus(null);
  };

  if (!authToken) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <p className="eyebrow">Staffing Scheduler</p>
          <h1>Plan and balance your data science team</h1>
          <p className="subtitle">
            Configure staffing capacity, track FTE demand per project, and allocate people week by week.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {currentUser && (
            <span className="tag" style={{ background: "#374151" }}>
              {currentUser.username} ({currentUser.role})
            </span>
          )}
          <button className="ghost" onClick={handleLogout} style={{ fontSize: 13 }}>Sign out</button>
        </div>
        <div className="tag">
          {config.granularity_weeks} week slots • {config.horizon_weeks} week horizon
          {conflicts.length > 0 && (
            <span className="conflict-badge" onClick={() => setTab("conflicts")}>
              ⚠ {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </header>

      <nav className="tabs">
        {Object.entries(TAB_LABELS)
          .filter(([key]) => key !== "console" || currentUser?.role === "admin")
          .map(([key, label]) => (
          <button
            key={key}
            className={`tab ${tab === key ? "active" : ""}${key === "conflicts" && conflicts.length > 0 ? " tab--warn" : ""}`}
            onClick={() => {
              resetMessages();
              setTab(key as TabKey);
              if (key === "auditLog") handleLoadAuditLogs();
              if (key === "settings") loadUsers();
            }}
          >
            {label}
            {key === "conflicts" && conflicts.length > 0 && (
              <span className="tab-badge">{conflicts.length}</span>
            )}
          </button>
        ))}
      </nav>

      {(loading || error || status) && (
        <div className="alerts">
          {loading && <div className="alert info">Loading...</div>}
          {status && <div className="alert success">{status}</div>}
          {error && <div className="alert danger">{error}</div>}
        </div>
      )}

      <main className="panels">
        {/* ---------------------------------------------------------------- SCHEDULE */}
        {tab === "schedule" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Weekly assignments</p>
                <h2>Balance workload across projects</h2>
              </div>
              <button className="primary" onClick={handleSaveAssignments}>
                Save assignments
              </button>
            </header>

            <div className="grid stats">
              <div className="stat">
                <p className="eyebrow">People</p>
                <strong>{dataScientists.length}</strong>
                <span>Data scientists</span>
              </div>
              <div className="stat">
                <p className="eyebrow">Projects</p>
                <strong>{projects.length}</strong>
                <span>Active</span>
              </div>
              <div className="stat">
                <p className="eyebrow">This week</p>
                <strong>{(weeklySummary[weeks[0]] ?? 0).toFixed(2)}</strong>
                <span>FTE allocated</span>
              </div>
              <div className="stat">
                <p className="eyebrow">Conflicts</p>
                <strong className={conflicts.length > 0 ? "text-danger" : ""}>{conflicts.length}</strong>
                <span>Overbookings</span>
              </div>
            </div>

            {/* ---- Merged Assign section ---- */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">Add assignment</p>
                  <h3>Allocate a person to a project</h3>
                </div>
                <div className="actions">
                  <div className="btn-group">
                    <button
                      className={`ghost${assignMode === "single" ? " active" : ""}`}
                      onClick={() => {
                        // Sync person/project/allocation from bulkForm → newAssignment
                        setNewAssignment((prev) => ({
                          ...prev,
                          data_scientist_id: bulkForm.data_scientist_id || prev.data_scientist_id,
                          project_id: bulkForm.project_id || prev.project_id,
                          allocation: bulkForm.allocation,
                        }));
                        setAssignMode("single");
                      }}
                    >Single week</button>
                    <button
                      className={`ghost${assignMode === "range" ? " active" : ""}`}
                      onClick={() => {
                        // Sync person/project/allocation from newAssignment → bulkForm
                        setBulkForm((prev) => ({
                          ...prev,
                          data_scientist_id: newAssignment.data_scientist_id || prev.data_scientist_id,
                          project_id: newAssignment.project_id || prev.project_id,
                          allocation: newAssignment.allocation,
                        }));
                        setAssignMode("range");
                      }}
                    >Date range</button>
                  </div>
                  <button
                    className="secondary"
                    onClick={assignMode === "single" ? handleAddAssignment : handleBulkAssign}
                  >
                    {assignMode === "single" ? "Add assignment" : "Bulk assign"}
                  </button>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Data scientist
                  <select
                    value={assignMode === "single" ? newAssignment.data_scientist_id : bulkForm.data_scientist_id}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (assignMode === "single") setNewAssignment((prev) => ({ ...prev, data_scientist_id: v }));
                      else setBulkForm((prev) => ({ ...prev, data_scientist_id: v }));
                    }}
                  >
                    {dataScientists.map((ds) => (
                      <option key={ds.id} value={ds.id}>{ds.name} ({ds.level})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Project
                  <select
                    value={assignMode === "single" ? newAssignment.project_id : bulkForm.project_id}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (assignMode === "single") setNewAssignment((prev) => ({ ...prev, project_id: v }));
                      else setBulkForm((prev) => ({ ...prev, project_id: v }));
                    }}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                {assignMode === "single" ? (
                  <label>
                    Week start
                    <select
                      value={newAssignment.week_start}
                      onChange={(e) => setNewAssignment((prev) => ({ ...prev, week_start: e.target.value }))}
                    >
                      {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </label>
                ) : (
                  <>
                    <label>
                      Start date
                      <input type="date" value={bulkForm.start_date}
                        onChange={(e) => setBulkForm((prev) => ({ ...prev, start_date: e.target.value }))} />
                    </label>
                    <label>
                      End date
                      <input type="date" value={bulkForm.end_date}
                        onChange={(e) => setBulkForm((prev) => ({ ...prev, end_date: e.target.value }))} />
                    </label>
                  </>
                )}
                <label>
                  Allocation (0–1)
                  <input
                    type="number" min={0} max={1} step={0.05}
                    value={assignMode === "single" ? newAssignment.allocation : bulkForm.allocation}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (assignMode === "single") setNewAssignment((prev) => ({ ...prev, allocation: v }));
                      else setBulkForm((prev) => ({ ...prev, allocation: v }));
                    }}
                  />
                </label>
              </div>
            </div>

            {/* ---- Remove section ---- */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">Remove assignments</p>
                  <h3>Remove by person, project, or date</h3>
                </div>
                <div className="actions">
                  <div className="btn-group">
                    <button
                      className={`ghost${removeMode === "single" ? " active" : ""}`}
                      onClick={() => setRemoveMode("single")}
                    >Single week</button>
                    <button
                      className={`ghost${removeMode === "range" ? " active" : ""}`}
                      onClick={() => setRemoveMode("range")}
                    >Date range</button>
                  </div>
                  <button
                    className="secondary"
                    style={{ color: "var(--danger, #ef4444)" }}
                    onClick={handleBulkRemove}
                  >
                    {removeMode === "single" ? "Remove" : "Bulk remove"}
                  </button>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Person <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
                  <select
                    value={bulkRemoveForm.data_scientist_id ?? ""}
                    onChange={(e) =>
                      setBulkRemoveForm((prev) => ({
                        ...prev,
                        data_scientist_id: e.target.value ? Number(e.target.value) : null,
                      }))
                    }
                  >
                    <option value="">— Anyone —</option>
                    {dataScientists.map((ds) => (
                      <option key={ds.id} value={ds.id}>{ds.name} ({ds.level})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Project <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
                  <select
                    value={bulkRemoveForm.project_id ?? ""}
                    onChange={(e) =>
                      setBulkRemoveForm((prev) => ({
                        ...prev,
                        project_id: e.target.value ? Number(e.target.value) : null,
                      }))
                    }
                  >
                    <option value="">— Any project —</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                {removeMode === "single" ? (
                  <label>
                    Week <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
                    <select
                      value={bulkRemoveForm.week_start ?? ""}
                      onChange={(e) =>
                        setBulkRemoveForm((prev) => ({
                          ...prev,
                          week_start: e.target.value || null,
                        }))
                      }
                    >
                      <option value="">— Any week —</option>
                      {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </label>
                ) : (
                  <>
                    <label>
                      Start date
                      <input
                        type="date"
                        value={bulkRemoveForm.start_date ?? ""}
                        onChange={(e) =>
                          setBulkRemoveForm((prev) => ({
                            ...prev,
                            start_date: e.target.value || null,
                          }))
                        }
                      />
                    </label>
                    <label>
                      End date
                      <input
                        type="date"
                        value={bulkRemoveForm.end_date ?? ""}
                        onChange={(e) =>
                          setBulkRemoveForm((prev) => ({
                            ...prev,
                            end_date: e.target.value || null,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            </div>

            {/* ---- Assignment list with filters ---- */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">Assignment list</p>
                  <h3>Review and filter</h3>
                </div>
                <span className="muted" style={{ fontSize: 13 }}>
                  {filteredAssignments.length} of {assignments.length} shown
                </span>
              </div>
              <div className="form-grid" style={{ marginBottom: 8 }}>
                <label>
                  Person
                  <select
                    value={scheduleFilter.ds_id}
                    onChange={(e) => { setScheduleFilter((prev) => ({ ...prev, ds_id: Number(e.target.value) })); setSchedulePage(0); }}
                  >
                    <option value={0}>All people</option>
                    {dataScientists.map((ds) => (
                      <option key={ds.id} value={ds.id}>{ds.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Project
                  <select
                    value={scheduleFilter.project_id}
                    onChange={(e) => { setScheduleFilter((prev) => ({ ...prev, project_id: Number(e.target.value) })); setSchedulePage(0); }}
                  >
                    <option value={0}>All projects</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  From week
                  <input type="date" value={scheduleFilter.date_from}
                    onChange={(e) => { setScheduleFilter((prev) => ({ ...prev, date_from: e.target.value })); setSchedulePage(0); }} />
                </label>
                <label>
                  To week
                  <input type="date" value={scheduleFilter.date_to}
                    onChange={(e) => { setScheduleFilter((prev) => ({ ...prev, date_to: e.target.value })); setSchedulePage(0); }} />
                </label>
                <label style={{ flexDirection: "row", alignItems: "center", gap: 8, gridColumn: "span 2" }}>
                  <input
                    type="checkbox"
                    checked={scheduleFilter.conflicts_only}
                    onChange={(e) => { setScheduleFilter((prev) => ({ ...prev, conflicts_only: e.target.checked })); setSchedulePage(0); }}
                    style={{ width: "auto", margin: 0 }}
                  />
                  <span>Show overstaffed weeks only</span>
                  {conflicts.length > 0 && (
                    <span className="tag" style={{ background: "#7f1d1d", color: "#fca5a5", fontSize: 11 }}>
                      {conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </label>
              </div>
              {(scheduleFilter.ds_id || scheduleFilter.project_id || scheduleFilter.date_from || scheduleFilter.date_to || scheduleFilter.conflicts_only) && (
                <div style={{ marginBottom: 8 }}>
                  <button
                    className="ghost"
                    style={{ fontSize: 12 }}
                    onClick={() => { setScheduleFilter({ ds_id: 0, project_id: 0, date_from: "", date_to: "", conflicts_only: false }); setSchedulePage(0); }}
                  >
                    ✕ Clear filters
                  </button>
                </div>
              )}
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Data scientist</th>
                    <th>Project</th>
                    <th>Allocation</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedAssignments.map((a) => {
                    const isConflict = conflicts.some(
                      (c) => c.data_scientist_id === a.data_scientist_id && c.week_start === a.week_start
                    );
                    return (
                      <tr key={a.id} className={isConflict ? "row--conflict" : ""}>
                        <td>{a.week_start}</td>
                        <td>{dsLookup[a.data_scientist_id]?.name ?? a.data_scientist_id}</td>
                        <td>{projectLookup[a.project_id]?.name ?? a.project_id}</td>
                        <td>
                          <input
                            type="number" min={0} max={1} step={0.05}
                            value={a.allocation}
                            onChange={(e) => {
                              const value = Number(e.target.value);
                              setAssignments((prev) =>
                                prev.map((row) => row.id === a.id ? { ...row, allocation: value } : row)
                              );
                            }}
                          />
                        </td>
                        <td>
                          <button className="ghost" onClick={() => handleDeleteAssignment(a.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredAssignments.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        {assignments.length === 0 ? "No assignments yet." : "No assignments match the current filters."}
                      </td>
                    </tr>
                  )}
                  {pagedAssignments.length === 0 && filteredAssignments.length > 0 && (
                    <tr>
                      <td colSpan={5} className="muted">No assignments on this page.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {totalSchedulePages > 1 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <button
                  className="ghost"
                  disabled={schedulePage === 0}
                  onClick={() => setSchedulePage((p) => p - 1)}
                >← Prev</button>
                <span className="muted" style={{ fontSize: 13 }}>
                  Page {schedulePage + 1} of {totalSchedulePages}
                </span>
                <button
                  className="ghost"
                  disabled={schedulePage >= totalSchedulePages - 1}
                  onClick={() => setSchedulePage((p) => p + 1)}
                >Next →</button>
              </div>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- DATA SCIENTISTS */}
        {tab === "dataScientists" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Team roster</p>
                <h2>Manage data scientists</h2>
              </div>
            </header>

            <div className="card">
              <GanttChart
                weeks={weeks}
                assignments={assignments}
                dataScientists={dataScientists}
                projects={projects}
                mode="by-person"
                onMoveAssignment={handleMoveAssignment}
                onEditAllocation={handleEditAllocation}
                onCreateAssignment={handleCreateAssignmentFromChart}
                onDeleteAssignment={handleDeleteAssignment}
              />
            </div>

            <div className="form-grid">
              <label>
                Name
                <input type="text" value={dsForm.name}
                  onChange={(e) => setDsForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>
              <label>
                Level
                <input type="text" value={dsForm.level}
                  onChange={(e) => setDsForm((prev) => ({ ...prev, level: e.target.value }))} />
              </label>
              <label>
                Max concurrent projects
                <input type="number" min={1} value={dsForm.max_concurrent_projects}
                  onChange={(e) => setDsForm((prev) => ({ ...prev, max_concurrent_projects: Number(e.target.value) }))} />
              </label>
              <label>
                Efficiency (FTE)
                <input type="number" step={0.05} min={0.1} value={dsForm.efficiency}
                  onChange={(e) => setDsForm((prev) => ({ ...prev, efficiency: Number(e.target.value) }))} />
              </label>
              <label className="full">
                Notes
                <input type="text" value={dsForm.notes ?? ""}
                  onChange={(e) => setDsForm((prev) => ({ ...prev, notes: e.target.value }))} />
              </label>
              <label className="full">
                Skills
                <TagInput
                  tags={dsForm.skills}
                  onChange={(skills) => setDsForm((prev) => ({ ...prev, skills }))}
                  placeholder="e.g. Python, ML, NLP..."
                />
              </label>
            </div>

            <div className="form-actions">
              <button className="primary" onClick={handleSaveDataScientist}>
                {editingDsId ? "Update person" : "Add person"}
              </button>
            </div>

            <div className="search-bar">
              <input
                type="text"
                placeholder="Search data scientists..."
                value={dsSearch}
                onChange={(e) => setDsSearch(e.target.value)}
              />
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Level</th>
                    <th>Concurrency</th>
                    <th>Efficiency</th>
                    <th>Skills</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDs.map((ds) => (
                    <tr key={ds.id}>
                      <td>{ds.name}</td>
                      <td>{ds.level}</td>
                      <td>{ds.max_concurrent_projects}</td>
                      <td>{ds.efficiency.toFixed(2)}</td>
                      <td>
                        {ds.skills.map((s) => (
                          <span key={s} className="tag small">{s}</span>
                        ))}
                      </td>
                      <td className="muted">{ds.notes}</td>
                      <td className="actions">
                        <button className="ghost" onClick={() => {
                          setEditingDsId(ds.id);
                          setDsForm({
                            name: ds.name, level: ds.level,
                            max_concurrent_projects: ds.max_concurrent_projects,
                            efficiency: ds.efficiency, notes: ds.notes ?? "",
                            skills: ds.skills,
                          });
                        }}>Edit</button>
                        <button className="ghost danger" onClick={() => handleDeleteDataScientist(ds.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- PROJECTS */}
        {tab === "projects" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Project catalog</p>
                <h2>Capture FTE needs</h2>
              </div>
            </header>

            <div className="card">
              <GanttChart
                weeks={weeks}
                assignments={assignments}
                dataScientists={dataScientists}
                projects={projects}
                mode="by-project"
                onMoveAssignment={handleMoveAssignment}
                onEditAllocation={handleEditAllocation}
                onCreateAssignment={handleCreateAssignmentFromChart}
                onDeleteAssignment={handleDeleteAssignment}
              />
            </div>

            <div className="form-grid">
              <label>
                Name
                <input type="text" value={projectForm.name}
                  onChange={(e) => setProjectForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>
              <label>
                Start date
                <input type="date" value={projectForm.start_date}
                  onChange={(e) => setProjectForm((prev) => ({ ...prev, start_date: e.target.value }))} />
              </label>
              <label>
                Duration (weeks)
                <input type="number" min={1} value={projectForm.duration_weeks}
                  onChange={(e) => setProjectForm((prev) => ({ ...prev, duration_weeks: Number(e.target.value) }))} />
              </label>
              <label>
                Weekly FTE need
                <input type="number" min={0} step={0.1} value={projectForm.weeklyFte}
                  onChange={(e) => setProjectForm((prev) => ({ ...prev, weeklyFte: Number(e.target.value) }))} />
              </label>
              <label className="full">
                Required skills
                <TagInput
                  tags={projectForm.required_skills}
                  onChange={(required_skills) => setProjectForm((prev) => ({ ...prev, required_skills }))}
                  placeholder="e.g. Python, ML..."
                />
              </label>
            </div>

            <div className="form-actions">
              <button className="primary" onClick={handleSaveProject}>
                {editingProjectId ? "Update project" : "Add project"}
              </button>
            </div>

            {/* Auto-suggest DS */}
            {editingProjectId && (
              <div className="card">
                <div className="card__header">
                  <div>
                    <p className="eyebrow">Auto-suggest</p>
                    <h3>Best-fit data scientists</h3>
                  </div>
                  <button className="secondary" onClick={() => handleSuggestDs(editingProjectId)}>
                    Suggest DS
                  </button>
                </div>
                {suggestions && (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr><th>Name</th><th>Level</th><th>Skills</th><th>Efficiency</th></tr>
                      </thead>
                      <tbody>
                        {suggestions.map((ds) => (
                          <tr key={ds.id}>
                            <td>{ds.name}</td>
                            <td>{ds.level}</td>
                            <td>{ds.skills.map((s) => <span key={s} className="tag small">{s}</span>)}</td>
                            <td>{ds.efficiency.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="search-bar">
              <input
                type="text"
                placeholder="Search projects..."
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
              />
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Timeline</th>
                    <th>Weekly FTE</th>
                    <th>Skills needed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProjects.map((project) => {
                    const duration =
                      (new Date(project.end_date).getTime() - new Date(project.start_date).getTime()) /
                        (1000 * 60 * 60 * 24 * 7) + 1;
                    const weeklyFte = project.fte_requirements[0]?.fte ?? 0;
                    return (
                      <tr key={project.id}>
                        <td>{project.name}</td>
                        <td>{project.start_date} → {project.end_date}</td>
                        <td>{weeklyFte} ({duration.toFixed(0)}w)</td>
                        <td>{project.required_skills.map((s) => <span key={s} className="tag small">{s}</span>)}</td>
                        <td className="actions">
                          <button className="ghost" onClick={() => {
                            setEditingProjectId(project.id);
                            setProjectForm({
                              name: project.name,
                              start_date: project.start_date,
                              duration_weeks: Number(duration),
                              weeklyFte,
                              required_skills: project.required_skills,
                            });
                            setSuggestions(null);
                          }}>Edit</button>
                          <button className="ghost danger" onClick={() => handleDeleteProject(project.id)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- DASHBOARD */}
        {tab === "dashboard" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Overview</p>
                <h2>Team utilization dashboard</h2>
              </div>
            </header>

            <div className="grid stats">
              <div className="stat">
                <p className="eyebrow">Total capacity</p>
                <strong>{totalCapacity.toFixed(1)}</strong>
                <span>FTE available</span>
              </div>
              <div className="stat">
                <p className="eyebrow">This week</p>
                <strong>{(weeklySummary[currentWeek] ?? 0).toFixed(1)}</strong>
                <span>FTE allocated</span>
              </div>
              <div className="stat">
                <p className="eyebrow">Utilization</p>
                <strong>
                  {totalCapacity > 0
                    ? Math.round(((weeklySummary[currentWeek] ?? 0) / totalCapacity) * 100)
                    : 0}%
                </strong>
                <span>This week</span>
              </div>
              <div className="stat">
                <p className="eyebrow">Conflicts</p>
                <strong className={conflicts.length > 0 ? "text-danger" : ""}>{conflicts.length}</strong>
                <span>Overbookings</span>
              </div>
            </div>

            {/* Weekly utilization chart */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">12-week view</p>
                  <h3>Weekly team utilization</h3>
                </div>
              </div>
              <div className="bar-chart">
                {weeklyUtilization.map(({ week, allocated, utilization }) => (
                  <div key={week} className="bar-chart__col">
                    <div className="bar-chart__label">{Math.round(utilization)}%</div>
                    <div className="bar-chart__bar-wrap">
                      <div
                        className={`bar-chart__bar ${utilization > 100 ? "bar--over" : utilization > 80 ? "bar--high" : ""}`}
                        style={{ height: `${Math.min(utilization, 120)}%` }}
                        title={`${week}: ${allocated.toFixed(1)} FTE / ${totalCapacity.toFixed(1)} cap`}
                      />
                    </div>
                    <div className="bar-chart__week">{week.slice(5)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-person utilization */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">This week</p>
                  <h3>Per-person allocation</h3>
                </div>
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Level</th><th>Allocated</th><th>Capacity</th><th>Utilization</th></tr>
                  </thead>
                  <tbody>
                    {personUtilization.map(({ ds, allocated, pct }) => (
                      <tr key={ds.id} className={pct > 100 ? "row--conflict" : ""}>
                        <td>{ds.name}</td>
                        <td>{ds.level}</td>
                        <td>{allocated.toFixed(2)}</td>
                        <td>{ds.efficiency.toFixed(2)}</td>
                        <td>
                          <div className="mini-bar">
                            <div
                              className={`mini-bar__fill ${pct > 100 ? "bar--over" : pct > 80 ? "bar--high" : ""}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                            <span>{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Projects with unmet FTE — this week + lifetime */}
            <div className="card">
              <div className="card__header">
                <div>
                  <p className="eyebrow">This week &amp; lifetime</p>
                  <h3>Project FTE coverage</h3>
                </div>
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>This Wk Required</th>
                      <th>This Wk Allocated</th>
                      <th>This Wk Gap</th>
                      <th>Lifetime Gap (FTE·wks)</th>
                      <th>Avg Wkly Gap</th>
                      <th>Assignment Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projectFteLifetimeStatus.map(({ project, lifetimeGap, avgRequired, avgAllocated, firstAssignment, lastAssignment, lateStart, earlyEnd, overEnd, hasTimingIssue }) => {
                      const thisWeekRow = projectFteStatus.find((x) => x.project.id === project.id);
                      const wkRequired = thisWeekRow?.required ?? 0;
                      const wkAllocated = thisWeekRow?.allocated ?? 0;
                      const wkGap = thisWeekRow?.gap ?? 0;
                      const avgGap = Math.max(0, avgRequired - avgAllocated);
                      const timingBadges: string[] = [];
                      if (lateStart) timingBadges.push("⚠ Late start");
                      if (earlyEnd) timingBadges.push("⚠ Ends early");
                      if (overEnd) timingBadges.push("⚠ Extends past end");
                      return (
                        <tr
                          key={project.id}
                          className={[
                            wkGap > 0 ? "row--warn" : "",
                            hasTimingIssue ? "row--timing" : "",
                          ].filter(Boolean).join(" ")}
                        >
                          <td>
                            {project.name}
                            {hasTimingIssue && (
                              <span className="tag" style={{ marginLeft: 6, background: "#78350f", color: "#fde68a", fontSize: 10 }}>
                                timing
                              </span>
                            )}
                          </td>
                          <td>{wkRequired > 0 ? wkRequired.toFixed(1) : <span className="muted">—</span>}</td>
                          <td>{wkRequired > 0 ? wkAllocated.toFixed(1) : <span className="muted">—</span>}</td>
                          <td className={wkGap > 0 ? "text-danger" : wkRequired > 0 ? "text-success" : ""}>
                            {wkRequired > 0 ? (wkGap > 0 ? `-${wkGap.toFixed(1)}` : "✓") : <span className="muted">—</span>}
                          </td>
                          <td className={lifetimeGap > 0 ? "text-danger" : "text-success"}>
                            {lifetimeGap > 0 ? `-${lifetimeGap.toFixed(1)}` : "✓"}
                          </td>
                          <td className={avgGap > 0 ? "text-danger" : "text-success"}>
                            {avgGap > 0 ? `-${avgGap.toFixed(2)}/wk` : "✓"}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {firstAssignment ? (
                              <div>
                                <span style={{ color: lateStart ? "var(--warning, #f59e0b)" : undefined }}>
                                  {firstAssignment}
                                </span>
                                {" → "}
                                <span style={{ color: (earlyEnd || overEnd) ? "var(--warning, #f59e0b)" : undefined }}>
                                  {lastAssignment}
                                </span>
                                {timingBadges.length > 0 && (
                                  <div style={{ marginTop: 2 }}>
                                    {timingBadges.map((b) => (
                                      <span key={b} className="tag" style={{ background: "#78350f", color: "#fde68a", fontSize: 10, marginRight: 2 }}>
                                        {b}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div className="muted" style={{ fontSize: 11 }}>
                                  project: {project.start_date} → {project.end_date}
                                </div>
                              </div>
                            ) : (
                              <span className="muted">No assignments</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {projectFteLifetimeStatus.length === 0 && (
                      <tr><td colSpan={7} className="muted">No projects with FTE requirements.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- CONFLICTS */}
        {tab === "conflicts" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Capacity conflicts</p>
                <h2>Overbooked data scientists</h2>
              </div>
              <button className="secondary" onClick={async () => {
                const c = await api.getConflicts();
                setConflicts(c);
                setStatus("Refreshed");
              }}>Refresh</button>
            </header>

            {conflicts.length === 0 ? (
              <div className="card">
                <p className="muted">No conflicts — all data scientists are within 100% allocation.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Data scientist</th>
                      <th>Week</th>
                      <th>Total allocation</th>
                      <th>Over by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conflicts.map((c, i) => (
                      <tr key={i} className="row--conflict">
                        <td>{c.data_scientist_name}</td>
                        <td>{c.week_start}</td>
                        <td>{(c.total_allocation * 100).toFixed(0)}%</td>
                        <td className="text-danger">+{(c.over_by * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- AUDIT LOG */}
        {tab === "auditLog" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Change history</p>
                <h2>Audit log</h2>
              </div>
              <button className="secondary" onClick={handleLoadAuditLogs}>Refresh</button>
            </header>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Assignment</th>
                    <th>Changed by</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="muted">{log.changed_at.replace("T", " ").slice(0, 19)}</td>
                      <td><span className={`action-badge action--${log.action}`}>{log.action}</span></td>
                      <td className="muted">{log.assignment_id ?? "—"}</td>
                      <td>{log.changed_by ?? "system"}</td>
                    </tr>
                  ))}
                  {auditLogs.length === 0 && (
                    <tr><td colSpan={4} className="muted">No audit logs yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------------------- SETTINGS */}
        {tab === "settings" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Scheduling defaults</p>
                <h2>Configure horizon and granularity</h2>
              </div>
            </header>
            <div className="form-grid">
              <label>
                Granularity (weeks per slot)
                <input type="number" min={1} value={config.granularity_weeks}
                  onChange={(e) => handleConfigUpdate({ granularity_weeks: Number(e.target.value) || 1 })} />
              </label>
              <label>
                Planning horizon (weeks)
                <input type="number" min={1} value={config.horizon_weeks}
                  onChange={(e) => handleConfigUpdate({ horizon_weeks: Number(e.target.value) || 1 })} />
              </label>
            </div>

            {currentUser?.role === "admin" && (
              <div className="card" style={{ marginTop: "2rem" }}>
                <div className="panel__header" style={{ marginBottom: "1rem" }}>
                  <div>
                    <p className="eyebrow">Admin only</p>
                    <h3>User Management</h3>
                  </div>
                  <button className="secondary" onClick={() => { setUserFormOpen(true); setUserMgmtError(null); }}>
                    + Add user
                  </button>
                </div>

                {userMgmtError && <div className="alert danger" style={{ marginBottom: "12px" }}>{userMgmtError}</div>}

                {userFormOpen && (
                  <div className="form-grid" style={{ marginBottom: "16px", padding: "14px", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
                    <label>
                      Username
                      <input
                        type="text"
                        value={newUserForm.username}
                        onChange={(e) => setNewUserForm((f) => ({ ...f, username: e.target.value }))}
                      />
                    </label>
                    <label>
                      Password
                      <input
                        type="password"
                        value={newUserForm.password}
                        onChange={(e) => setNewUserForm((f) => ({ ...f, password: e.target.value }))}
                      />
                    </label>
                    <label>
                      Role
                      <select
                        value={newUserForm.role}
                        onChange={(e) => setNewUserForm((f) => ({ ...f, role: e.target.value }))}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="manager">Manager</option>
                        <option value="admin">Admin</option>
                      </select>
                    </label>
                    <div className="actions" style={{ alignSelf: "flex-end", paddingBottom: "2px" }}>
                      <button className="primary" onClick={handleAdminCreateUser}>Create</button>
                      <button className="ghost" onClick={() => { setUserFormOpen(false); setUserMgmtError(null); }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td>
                            {u.username}
                            {u.username === currentUser?.username && (
                              <span className="tag small" style={{ marginLeft: 8 }}>you</span>
                            )}
                          </td>
                          <td>
                            <select
                              value={u.role}
                              disabled={u.username === currentUser?.username}
                              onChange={(e) => { setUserMgmtError(null); handleUpdateUserRole(u.id, e.target.value); }}
                              style={{ fontSize: 13 }}
                            >
                              <option value="viewer">Viewer</option>
                              <option value="manager">Manager</option>
                              <option value="admin">Admin</option>
                            </select>
                          </td>
                          <td className="actions">
                            <button
                              className="ghost danger"
                              disabled={u.username === currentUser?.username}
                              onClick={() => { setUserMgmtError(null); handleDeleteUser(u.id); }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                      {users.length === 0 && (
                        <tr><td colSpan={3} className="muted">No users found.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- IMPORT/EXPORT */}
        {tab === "importExport" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Data exchange</p>
                <h2>Import or export data</h2>
              </div>
            </header>

            <div className="card">
              <h3>Full Backup (JSON)</h3>
              <p className="muted">
                Export or restore the complete database state including all data scientists, projects, assignments, and settings.
                Use this to backup your data before going offline, or to restore from a previous backup.
              </p>
              <div className="actions" style={{ marginTop: "1rem" }}>
                <button className="secondary" onClick={handleExportJson}>Export JSON</button>
                <label className="file-button">
                  Import JSON
                  <input type="file" accept=".json"
                    onChange={(e) => handleImportJson(e.target.files?.[0])} />
                </label>
              </div>
            </div>

            <div className="card">
              <h3>Schedule Import (CSV/Excel)</h3>
              <p className="muted">
                Import assignments from a spreadsheet. This will replace all existing data.
                Required columns: <code>week_start</code>, <code>data_scientist</code>,{" "}
                <code>project</code>, <code>allocation</code>. Optional: <code>level</code>,{" "}
                <code>efficiency</code>, <code>project_start</code>, <code>project_end</code>, <code>fte</code>.
              </p>
              <div className="actions" style={{ marginTop: "1rem" }}>
                <button className="secondary" onClick={handleExport}>Export CSV</button>
                <label className="file-button">
                  Import CSV/Excel
                  <input type="file" accept=".csv,.xlsx,.xls"
                    onChange={(e) => handleImport(e.target.files?.[0])} />
                </label>
              </div>
            </div>

            {importResult && (
              <div className="card import-result">
                <p className="eyebrow">Import summary</p>
                <ul>
                  <li>Assignments created: {importResult.created_assignments}</li>
                  <li>New data scientists: {importResult.created_data_scientists}</li>
                  <li>New projects: {importResult.created_projects}</li>
                  <li>Replaced: {importResult.replaced_existing_assignments}</li>
                </ul>
              </div>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- CONSOLE */}
        {tab === "console" && (
          <section className="panel">
            <header className="panel__header">
              <div>
                <p className="eyebrow">Admin only</p>
                <h2>DB Console</h2>
              </div>
            </header>

            <div className="console-shortcuts">
              {[
                "SELECT * FROM data_scientists LIMIT 50;",
                "SELECT * FROM projects LIMIT 50;",
                "SELECT * FROM assignments LIMIT 50;",
                "SELECT * FROM users;",
                "SELECT * FROM audit_logs ORDER BY changed_at DESC LIMIT 50;",
                "SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 20;",
                "SELECT * FROM chat_messages ORDER BY id DESC LIMIT 50;",
                "SELECT name FROM sqlite_master WHERE type='table';",
              ].map((q) => (
                <button
                  key={q}
                  className="ghost console-shortcut"
                  onClick={() => setConsoleSql(q)}
                >
                  {q.replace(/SELECT \* FROM (\w+).*/i, "$1").replace(/SELECT (.*) FROM.*/i, "$1")}
                </button>
              ))}
            </div>

            <div className="console-editor">
              <textarea
                className="console-sql"
                value={consoleSql}
                onChange={(e) => setConsoleSql(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleConsoleRun();
                  }
                }}
                rows={5}
                spellCheck={false}
              />
              <button className="primary" onClick={handleConsoleRun} disabled={consoleLoading}>
                {consoleLoading ? "Running…" : "Run  ⌘↵"}
              </button>
            </div>

            {consoleError && (
              <div className="alert danger">{consoleError}</div>
            )}

            {consoleResult && (
              <div className="console-result">
                <p className="console-rowcount">{consoleResult.row_count} row{consoleResult.row_count !== 1 ? "s" : ""}</p>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        {consoleResult.columns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {consoleResult.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j} className="console-cell">
                              {cell === null ? <span className="console-null">NULL</span> : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <button className="chat-toggle" onClick={() => setChatOpen(true)} title="Open staffing assistant">
        💬
      </button>
      <ChatPanel
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        onDataChanged={loadData}
      />
    </div>
  );
}

export default App;
