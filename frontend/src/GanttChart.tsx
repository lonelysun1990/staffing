import { useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Assignment, DataScientist, Project } from "./types";

const COLORS = [
  "#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6",
  "#06b6d4", "#f97316", "#84cc16", "#ef4444", "#3b82f6",
  "#a855f7", "#10b981", "#eab308", "#0ea5e9", "#d946ef", "#22c55e",
];

function generateAcronym(name: string): string {
  const words = name.split(/[\s\-_+]+/).filter(Boolean);
  if (words.length === 1) return name.slice(0, 4).toUpperCase();
  return words
    .map((word) => (/^\d+$/.test(word) || word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase()))
    .join("")
    .slice(0, 5);
}

interface EntityOption {
  id: number;
  label: string;
  acronym: string;
}

interface GanttBar {
  id: string;
  assignmentId: number;
  label: string;
  acronym: string;
  allocation: number;
  color: string;
  entityId: number; // project_id in by-person mode; data_scientist_id in by-project mode
}

interface GanttRow {
  id: number;
  name: string;
  bars: Map<number, GanttBar[]>;
}

interface ProjectMetrics {
  totalLoe: number;
  consumedLoe: number;
  remainingLoe: number;
  currentAssigned: number;
  currentRequired: number;
  gap: number;
}

interface GanttChartProps {
  weeks: string[];
  assignments: Assignment[];
  dataScientists: DataScientist[];
  projects: Project[];
  mode: "by-person" | "by-project";
  onMoveAssignment?: (assignmentId: number, newWeekStart: string, newDsId: number, newProjectId: number) => void;
  onEditAllocation?: (assignmentId: number, newAllocation: number) => void;
  onCreateAssignment?: (dsId: number, projectId: number, weekStart: string, allocation: number) => void;
  onDeleteAssignment?: (assignmentId: number) => void;
}

// ── Draggable bar ──────────────────────────────────────────────────────────────
function DraggableBar({
  bar,
  mode,
  entityOptions,
  onEditAllocation,
  onChangeEntity,
  onDelete,
}: {
  bar: GanttBar;
  mode: "by-person" | "by-project";
  entityOptions: EntityOption[];
  onEditAllocation?: (assignmentId: number, newAllocation: number) => void;
  onChangeEntity?: (assignmentId: number, newEntityId: number) => void;
  onDelete?: (assignmentId: number) => void;
}) {
  const [editingPct, setEditingPct] = useState(false);
  const [editingEntity, setEditingEntity] = useState(false);
  const [pctValue, setPctValue] = useState("");

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `bar-${bar.assignmentId}`,
    data: { assignmentId: bar.assignmentId },
  });

  const commitPct = () => {
    const pct = parseInt(pctValue, 10);
    if (!isNaN(pct) && pct > 0 && pct <= 100) {
      onEditAllocation?.(bar.assignmentId, pct / 100);
    }
    setEditingPct(false);
  };

  const barLabel = mode === "by-person" ? bar.acronym : bar.label.split(" (")[0];
  const entityHint = mode === "by-person" ? "project" : "data scientist";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      className="gantt-bar"
      style={{ backgroundColor: bar.color, opacity: isDragging ? 0.4 : 1 }}
      title={`${bar.label}: ${(bar.allocation * 100).toFixed(0)}%`}
    >
      {/* Drag handle — only this triggers dragging */}
      <span {...listeners} className="gantt-bar-drag-handle" title="Drag to move">⠿</span>

      {/* Entity name — click to change via dropdown */}
      {editingEntity ? (
        <select
          className="gantt-bar-select"
          defaultValue={bar.entityId}
          autoFocus
          onChange={(e) => {
            onChangeEntity?.(bar.assignmentId, Number(e.target.value));
            setEditingEntity(false);
          }}
          onBlur={() => setEditingEntity(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditingEntity(false); }}
        >
          {entityOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <span
          className="gantt-bar-text gantt-bar-text--clickable"
          onClick={() => onChangeEntity && setEditingEntity(true)}
          title={onChangeEntity ? `Click to change ${entityHint}` : bar.label}
        >
          {barLabel}
        </span>
      )}

      {/* Allocation % — click to edit */}
      {editingPct ? (
        <>
          <input
            className="gantt-bar-input"
            type="number"
            value={pctValue}
            min={1}
            max={100}
            autoFocus
            onChange={(e) => setPctValue(e.target.value)}
            onBlur={commitPct}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingPct(false);
            }}
          />
          <span className="gantt-bar-pct-suffix">%</span>
        </>
      ) : (
        <button
          className="gantt-bar-pct"
          onClick={() => {
            setPctValue(String(Math.round(bar.allocation * 100)));
            setEditingPct(true);
          }}
          title="Click to edit %"
        >
          {(bar.allocation * 100).toFixed(0)}%
        </button>
      )}

      {onDelete && (
        <button
          className="gantt-bar-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(bar.assignmentId); }}
          title="Delete assignment"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Creation form shown inside an empty cell ───────────────────────────────────
function CellCreationForm({
  entityOptions,
  entityLabel,
  onCommit,
  onCancel,
}: {
  entityOptions: EntityOption[];
  entityLabel: string;
  onCommit: (entityId: number, allocation: number) => void;
  onCancel: () => void;
}) {
  const [entityId, setEntityId] = useState(String(entityOptions[0]?.id ?? ""));
  const [alloc, setAlloc] = useState("100");

  const commit = () => {
    const eid = parseInt(entityId, 10);
    const pct = parseInt(alloc, 10);
    if (!isNaN(eid) && !isNaN(pct) && pct > 0 && pct <= 100) {
      onCommit(eid, pct / 100);
    }
  };

  return (
    <div className="gantt-create-form" onClick={(e) => e.stopPropagation()}>
      <div className="gantt-create-label">{entityLabel}</div>
      <select
        className="gantt-create-select"
        value={entityId}
        autoFocus
        onChange={(e) => setEntityId(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      >
        {entityOptions.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
      <div className="gantt-create-alloc-row">
        <input
          className="gantt-create-alloc"
          type="number"
          value={alloc}
          min={1}
          max={100}
          onChange={(e) => setAlloc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="%"
        />
        <span className="gantt-create-alloc-suffix">%</span>
      </div>
      <div className="gantt-create-actions">
        <button className="gantt-create-ok" onClick={commit} title="Confirm">✓</button>
        <button className="gantt-create-cancel" onClick={onCancel} title="Cancel">✕</button>
      </div>
    </div>
  );
}

// ── Droppable cell ─────────────────────────────────────────────────────────────
function DroppableCell({
  id,
  children,
  isEmpty,
  onEmptyClick,
  creationContent,
}: {
  id: string;
  children: React.ReactNode;
  isEmpty: boolean;
  onEmptyClick?: () => void;
  creationContent?: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  const clickable = isEmpty && !!onEmptyClick && !creationContent;
  return (
    <div
      ref={setNodeRef}
      className={[
        "gantt-cell",
        isOver ? "gantt-cell--over" : "",
        creationContent ? "gantt-cell--creating" : "",
        clickable ? "gantt-cell--empty" : "",
      ].filter(Boolean).join(" ")}
      onClick={clickable ? onEmptyClick : undefined}
    >
      {creationContent ?? children}
    </div>
  );
}

// ── Main chart component ───────────────────────────────────────────────────────
export function GanttChart({
  weeks,
  assignments,
  dataScientists,
  projects,
  mode,
  onMoveAssignment,
  onEditAllocation,
  onCreateAssignment,
  onDeleteAssignment,
}: GanttChartProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const [creatingCell, setCreatingCell] = useState<{ rowId: number; weekIndex: number } | null>(null);

  const dsLookup = useMemo(
    () => Object.fromEntries(dataScientists.map((ds) => [ds.id, ds])),
    [dataScientists]
  );
  const projectLookup = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects]
  );
  const weekIndexMap = useMemo(
    () => Object.fromEntries(weeks.map((w, i) => [w, i])),
    [weeks]
  );
  const projectData = useMemo(
    () =>
      Object.fromEntries(
        projects.map((p, i) => [p.id, { color: COLORS[i % COLORS.length], acronym: generateAcronym(p.name), name: p.name }])
      ),
    [projects]
  );
  const dsColors = useMemo(
    () => Object.fromEntries(dataScientists.map((ds, i) => [ds.id, COLORS[i % COLORS.length]])),
    [dataScientists]
  );

  // Options for the entity dropdown (what you can change a bar TO)
  const entityOptions = useMemo((): EntityOption[] => {
    if (mode === "by-person") {
      return projects.map((p) => ({
        id: p.id,
        label: p.name,
        acronym: projectData[p.id]?.acronym ?? "?",
      }));
    }
    return dataScientists.map((ds) => ({
      id: ds.id,
      label: ds.name,
      acronym: ds.name.split(" ").map((n) => n[0]).join(""),
    }));
  }, [mode, projects, dataScientists, projectData]);

  const currentWeek = weeks[0] ?? "";

  const projectMetrics = useMemo((): Record<number, ProjectMetrics> => {
    if (mode !== "by-project") return {};
    return Object.fromEntries(
      projects.map((project) => {
        const totalLoe = project.fte_requirements.reduce((s, pw) => s + pw.fte, 0);

        const consumedLoe = assignments
          .filter((a) => a.project_id === project.id && a.week_start < currentWeek)
          .reduce((s, a) => {
            const ds = dsLookup[a.data_scientist_id];
            return s + a.allocation * (ds?.efficiency ?? 1);
          }, 0);

        const currentAssigned = assignments
          .filter((a) => a.project_id === project.id && a.week_start === currentWeek)
          .reduce((s, a) => {
            const ds = dsLookup[a.data_scientist_id];
            return s + a.allocation * (ds?.efficiency ?? 1);
          }, 0);

        const currentRequired =
          project.fte_requirements.find((pw) => pw.week_start === currentWeek)?.fte ?? 0;

        return [
          project.id,
          {
            totalLoe,
            consumedLoe,
            remainingLoe: totalLoe - consumedLoe,
            currentAssigned,
            currentRequired,
            gap: currentRequired - currentAssigned,
          },
        ];
      })
    );
  }, [mode, projects, assignments, currentWeek, dsLookup]);

  const visibleWeeks = weeks.slice(0, Math.min(weeks.length, 16));

  const rows = useMemo((): GanttRow[] => {
    if (mode === "by-person") {
      return dataScientists.map((ds) => {
        const bars = new Map<number, GanttBar[]>();
        assignments
          .filter((a) => a.data_scientist_id === ds.id)
          .forEach((a) => {
            const weekIndex = weekIndexMap[a.week_start];
            if (weekIndex === undefined) return;
            const pData = projectData[a.project_id];
            const bar: GanttBar = {
              id: `${a.id}`,
              assignmentId: a.id,
              label: projectLookup[a.project_id]?.name ?? `Project ${a.project_id}`,
              acronym: pData?.acronym ?? "?",
              allocation: a.allocation,
              color: pData?.color ?? COLORS[0],
              entityId: a.project_id,
            };
            if (!bars.has(weekIndex)) bars.set(weekIndex, []);
            bars.get(weekIndex)!.push(bar);
          });
        return { id: ds.id, name: ds.name, bars };
      });
    } else {
      return projects.map((project) => {
        const bars = new Map<number, GanttBar[]>();
        assignments
          .filter((a) => a.project_id === project.id)
          .forEach((a) => {
            const weekIndex = weekIndexMap[a.week_start];
            if (weekIndex === undefined) return;
            const ds = dsLookup[a.data_scientist_id];
            const bar: GanttBar = {
              id: `${a.id}`,
              assignmentId: a.id,
              label: ds ? `${ds.name} (${(a.allocation * 100).toFixed(0)}%)` : `DS ${a.data_scientist_id}`,
              acronym: ds?.name.split(" ").map((n) => n[0]).join("") ?? "?",
              allocation: a.allocation,
              color: dsColors[a.data_scientist_id] ?? COLORS[0],
              entityId: a.data_scientist_id,
            };
            if (!bars.has(weekIndex)) bars.set(weekIndex, []);
            bars.get(weekIndex)!.push(bar);
          });
        return { id: project.id, name: project.name, bars };
      });
    }
  }, [mode, dataScientists, projects, assignments, weekIndexMap, projectLookup, dsLookup, projectData, dsColors]);

  const formatWeek = (week: string) => {
    const d = new Date(week + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !onMoveAssignment) return;

    const assignmentId = Number(String(active.id).replace("bar-", ""));
    const parts = String(over.id).split("-"); // "cell-{rowId}-{weekIndex}"
    const weekIndex = Number(parts[parts.length - 1]);
    const rowId = Number(parts[parts.length - 2]);
    const newWeekStart = visibleWeeks[weekIndex];
    if (!newWeekStart) return;

    const sourceAssignment = assignments.find((a) => a.id === assignmentId);
    if (!sourceAssignment) return;

    const newDsId = mode === "by-person" ? rowId : sourceAssignment.data_scientist_id;
    const newProjectId = mode === "by-project" ? rowId : sourceAssignment.project_id;
    onMoveAssignment(assignmentId, newWeekStart, newDsId, newProjectId);
  };

  const handleEntityChange = (assignmentId: number, newEntityId: number) => {
    const assignment = assignments.find((a) => a.id === assignmentId);
    if (!assignment || !onMoveAssignment) return;
    const newDsId = mode === "by-person" ? assignment.data_scientist_id : newEntityId;
    const newProjectId = mode === "by-project" ? assignment.project_id : newEntityId;
    onMoveAssignment(assignmentId, assignment.week_start, newDsId, newProjectId);
  };

  const handleCommitCreate = (rowId: number, weekIndex: number, entityId: number, allocation: number) => {
    const weekStart = visibleWeeks[weekIndex];
    if (!weekStart || !onCreateAssignment) return;
    const dsId = mode === "by-person" ? rowId : entityId;
    const projectId = mode === "by-project" ? rowId : entityId;
    onCreateAssignment(dsId, projectId, weekStart, allocation);
    setCreatingCell(null);
  };

  if (rows.length === 0) {
    return (
      <div className="gantt-empty">
        No {mode === "by-person" ? "data scientists" : "projects"} to display.
      </div>
    );
  }

  const entityLabel = mode === "by-person" ? "Project" : "Data Scientist";

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="gantt-container">
        <div className="gantt-scroll-area">
        <div className="gantt-chart">
          <div className="gantt-header">
            <div className="gantt-label-cell">
              {mode === "by-person" ? "Data Scientist" : "Project"}
            </div>
            {mode === "by-project" && (
              <>
                <div className="gantt-metric-cell gantt-metric-cell--header" title="Total planned effort minus effort consumed in past weeks (FTE × weeks)">Rem. LoE</div>
                <div className="gantt-metric-cell gantt-metric-cell--header" title="Effective FTE assigned to this project in the current week (allocation × efficiency)">Cur. LoE</div>
                <div className="gantt-metric-cell gantt-metric-cell--header" title="FTE required by the project plan for the current week">Required</div>
                <div className="gantt-metric-cell gantt-metric-cell--header" title="Gap = Required − Current (positive = understaffed, negative = overstaffed)">Gap</div>
              </>
            )}
            {visibleWeeks.map((week, i) => (
              <div key={week} className="gantt-week-header">
                <span className="gantt-week-label">{formatWeek(week)}</span>
                {i === 0 && <span className="gantt-week-year">{week.slice(0, 4)}</span>}
              </div>
            ))}
          </div>

          {rows.map((row) => {
            const metrics = mode === "by-project" ? projectMetrics[row.id] : undefined;
            return (
            <div key={row.id} className="gantt-row">
              <div className="gantt-label-cell" title={row.name}>{row.name}</div>
              {metrics && (
                <>
                  <div className="gantt-metric-cell" title={`Total planned: ${metrics.totalLoe.toFixed(1)} | Consumed: ${metrics.consumedLoe.toFixed(2)}`}>
                    <span className="gantt-metric-value">{metrics.remainingLoe.toFixed(1)}</span>
                  </div>
                  <div className="gantt-metric-cell" title="Effective FTE assigned this week (allocation × efficiency)">
                    <span className="gantt-metric-value">{metrics.currentAssigned.toFixed(2)}</span>
                  </div>
                  <div className="gantt-metric-cell" title="FTE required by plan this week">
                    <span className="gantt-metric-value">{metrics.currentRequired.toFixed(2)}</span>
                  </div>
                  <div
                    className={[
                      "gantt-metric-cell",
                      metrics.gap > 0.05 ? "gantt-metric-cell--understaffed" : metrics.gap < -0.05 ? "gantt-metric-cell--overstaffed" : "gantt-metric-cell--balanced",
                    ].join(" ")}
                    title={metrics.gap > 0.05 ? "Understaffed" : metrics.gap < -0.05 ? "Overstaffed" : "Balanced"}
                  >
                    <span className="gantt-metric-value">
                      {metrics.gap >= 0 ? "+" : ""}{metrics.gap.toFixed(2)}
                    </span>
                  </div>
                </>
              )}
              {visibleWeeks.map((week, weekIndex) => {
                const cellBars = row.bars.get(weekIndex) ?? [];
                const isCreating =
                  creatingCell?.rowId === row.id && creatingCell?.weekIndex === weekIndex;

                return (
                  <DroppableCell
                    key={week}
                    id={`cell-${row.id}-${weekIndex}`}
                    isEmpty={cellBars.length === 0}
                    onEmptyClick={
                      onCreateAssignment
                        ? () => setCreatingCell({ rowId: row.id, weekIndex })
                        : undefined
                    }
                    creationContent={
                      isCreating ? (
                        <CellCreationForm
                          entityOptions={entityOptions}
                          entityLabel={entityLabel}
                          onCommit={(entityId, allocation) =>
                            handleCommitCreate(row.id, weekIndex, entityId, allocation)
                          }
                          onCancel={() => setCreatingCell(null)}
                        />
                      ) : undefined
                    }
                  >
                    {cellBars.length > 0 && (
                      <div className="gantt-bars">
                        {cellBars.map((bar) => (
                          <DraggableBar
                            key={bar.id}
                            bar={bar}
                            mode={mode}
                            entityOptions={entityOptions}
                            onEditAllocation={onEditAllocation}
                            onChangeEntity={onMoveAssignment ? handleEntityChange : undefined}
                            onDelete={onDeleteAssignment}
                          />
                        ))}
                        {onCreateAssignment && (
                          <button
                            className="gantt-cell-add"
                            onClick={(e) => { e.stopPropagation(); setCreatingCell({ rowId: row.id, weekIndex }); }}
                            title="Add assignment"
                          >+</button>
                        )}
                      </div>
                    )}
                  </DroppableCell>
                );
              })}
            </div>
            );
          })}
        </div>
        </div>{/* gantt-scroll-area */}

        <div className="gantt-legend">
          <span className="gantt-legend-title">
            {mode === "by-person" ? "Project Acronyms:" : "Legend:"}
            {onMoveAssignment && <span className="gantt-legend-hint"> · drag ⠿ to move · click name to reassign · click % to edit · × to delete</span>}
            {onCreateAssignment && <span className="gantt-legend-hint"> · click empty cell to add</span>}
          </span>
          {mode === "by-person"
            ? projects.slice(0, 10).map((p) => {
                const pData = projectData[p.id];
                return (
                  <div key={p.id} className="gantt-legend-item">
                    <span className="gantt-legend-color" style={{ backgroundColor: pData?.color }} />
                    <span className="gantt-legend-label"><strong>{pData?.acronym}</strong> = {p.name}</span>
                  </div>
                );
              })
            : dataScientists.slice(0, 8).map((ds) => (
                <div key={ds.id} className="gantt-legend-item">
                  <span className="gantt-legend-color" style={{ backgroundColor: dsColors[ds.id] }} />
                  <span className="gantt-legend-label">{ds.name}</span>
                </div>
              ))}
          {(mode === "by-person" ? projects.length > 10 : dataScientists.length > 8) && (
            <span className="gantt-legend-more">
              +{mode === "by-person" ? projects.length - 10 : dataScientists.length - 8} more
            </span>
          )}
        </div>
      </div>

      <DragOverlay>{/* bar fades in place during drag */}</DragOverlay>
    </DndContext>
  );
}
