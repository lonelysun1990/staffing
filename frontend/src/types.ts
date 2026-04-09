export interface Config {
  granularity_weeks: number;
  horizon_weeks: number;
}

export interface DataScientist {
  id: number;
  name: string;
  level: string;
  max_concurrent_projects: number;
  efficiency: number;
  notes?: string | null;
  skills: string[];
}

export interface DataScientistPayload {
  name: string;
  level: string;
  max_concurrent_projects: number;
  efficiency: number;
  notes?: string | null;
  skills: string[];
}

export interface ProjectWeek {
  week_start: string;
  fte: number;
}

export interface Project {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  fte_requirements: ProjectWeek[];
  required_skills: string[];
}

export interface ProjectPayload {
  name: string;
  start_date: string;
  end_date: string;
  fte_requirements: ProjectWeek[];
  required_skills: string[];
}

export interface Assignment {
  id: number;
  data_scientist_id: number;
  project_id: number;
  week_start: string;
  allocation: number;
}

export interface AssignmentPayload {
  data_scientist_id: number;
  project_id: number;
  week_start: string;
  allocation: number;
}

export interface BulkAssignPayload {
  data_scientist_id: number;
  project_id: number;
  start_date: string;
  end_date: string;
  allocation: number;
}

export interface BulkRemovePayload {
  data_scientist_id?: number | null;
  project_id?: number | null;
  week_start?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface ImportResult {
  created_data_scientists: number;
  created_projects: number;
  created_assignments: number;
  replaced_existing_assignments: number;
}

export interface ConflictItem {
  data_scientist_id: number;
  data_scientist_name: string;
  week_start: string;
  total_allocation: number;
  over_by: number;
}

export interface AuditLogItem {
  id: number;
  assignment_id: number | null;
  action: string;
  changed_by: string | null;
  changed_at: string;
  details: Record<string, unknown> | null;
}

export interface User {
  id: number;
  username: string;
  role: string;
}

export interface ChatSession {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessageOut {
  id: number;
  role: string;
  content: string | null;
  metadata: Record<string, unknown> | unknown[] | null;
  created_at: string;
}

export interface MemoryItem {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  updated_at: string;
}
