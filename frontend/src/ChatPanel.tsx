import { useEffect, useRef, useState } from "react";
import { AgentStreamEvent, ChatMessage, api } from "./api";
import { ChatMessageOut, ChatSession } from "./types";

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged: () => void;
}

// ── Message item types ───────────────────────────────────────────────────────

type MessageItem =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | {
      kind: "tool_step";
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      result: string | null; // null = still running
      ok: boolean;
      collapsed: boolean;
    };

// ── Tool name display labels ─────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  set_assignment: "Set assignment",
  clear_assignment: "Clear assignment",
  get_availability: "Check availability",
  check_conflicts: "Check conflicts",
  suggest_data_scientists: "Suggest candidates",
  update_data_scientist: "Update person",
  update_project: "Update project",
  create_data_scientist: "Create person",
  create_project: "Create project",
  remember_fact: "Remember fact",
  list_memories: "Recall memories",
};

function formatToolName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

// ── Initial greeting ─────────────────────────────────────────────────────────

const GREETING: MessageItem = {
  kind: "message",
  role: "assistant",
  content:
    `Hi! I'm your staffing assistant. Tell me what to do — for example:\n` +
    `• "Assign Yunxuan 25% on Nucor"\n` +
    `• "Who has Python skills?"\n` +
    `• "Remove Josh from Cargill then check for conflicts"`,
};

// ── Reconstruct MessageItems from stored DB messages ────────────────────────

function dbMessagesToItems(rows: ChatMessageOut[]): MessageItem[] {
  const items: MessageItem[] = [GREETING];
  for (const row of rows) {
    if (row.role === "user" && row.content) {
      items.push({ kind: "message", role: "user", content: row.content });
    } else if (row.role === "assistant" && row.content) {
      // If this assistant row has tool_calls in metadata, skip it from display
      // (tool steps are reconstructed separately, we only want text turns)
      const meta = row.metadata;
      if (!meta || !Array.isArray(meta)) {
        items.push({ kind: "message", role: "assistant", content: row.content });
      }
    }
    // tool-role rows are not shown directly; they surface as tool_step items
    // which we don't reconstruct here (would need to pair with tool_call_start)
  }
  return items;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ChatPanel({ isOpen, onClose, onDataChanged }: ChatPanelProps) {
  const [items, setItems] = useState<MessageItem[]>([GREETING]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState(""); // live token buffer

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, streaming, streamingText]);

  // Load session list when panel opens
  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen]);

  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const list = await api.listSessions();
      setSessions(list);
    } catch {
      // ignore — sessions just won't show
    } finally {
      setLoadingSessions(false);
    }
  };

  const handleNewSession = () => {
    setActiveSessionId(null);
    setItems([GREETING]);
    setInput("");
  };

  const handleSwitchSession = async (id: number) => {
    if (id === activeSessionId) return;
    try {
      const msgs = await api.getSessionMessages(id);
      setItems(dbMessagesToItems(msgs));
      setActiveSessionId(id);
    } catch {
      // ignore
    }
  };

  const handleDeleteSession = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteSession(id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (activeSessionId === id) {
        if (remaining.length > 0) {
          handleSwitchSession(remaining[0].id);
        } else {
          handleNewSession();
        }
      }
    } catch {
      // ignore
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userItem: MessageItem = { kind: "message", role: "user", content: text };
    const nextItems = [...items, userItem];
    setItems(nextItems);
    setInput("");
    setStreaming(true);
    setStreamingText("");

    // When a session is active, send only the new message; backend loads history from DB.
    // Stateless fallback: build full history from local state (no session_id).
    let messagesToSend: ChatMessage[];
    if (activeSessionId !== null) {
      messagesToSend = [{ role: "user", content: text }];
    } else {
      // Build history from local items, drop the greeting
      messagesToSend = nextItems
        .filter((item): item is MessageItem & { kind: "message" } => item.kind === "message")
        .slice(1)
        .map((m) => ({ role: m.role, content: m.content }));
    }

    // localItems mirrors React state within the async loop to avoid stale closures
    let localItems = [...nextItems];
    let localText = "";

    const updateItem = (predicate: (item: MessageItem) => boolean, updater: (item: MessageItem) => MessageItem) => {
      localItems = localItems.map((item) => (predicate(item) ? updater(item) : item));
      setItems([...localItems]);
    };

    try {
      for await (const event of api.streamAgentMessage(messagesToSend, activeSessionId ?? undefined)) {
        if (event.type === "text_delta") {
          localText += event.delta;
          setStreamingText(localText);
        } else if (event.type === "tool_call_start") {
          const step: MessageItem = {
            kind: "tool_step",
            toolCallId: event.tool_call_id,
            name: event.name,
            args: event.args,
            result: null,
            ok: true,
            collapsed: true,
          };
          localItems = [...localItems, step];
          setItems([...localItems]);
        } else if (event.type === "tool_result") {
          updateItem(
            (item) => item.kind === "tool_step" && item.toolCallId === event.tool_call_id,
            (item) => ({ ...item, result: event.result, ok: event.ok } as MessageItem),
          );
        } else if (event.type === "done") {
          if (localText) {
            localItems = [...localItems, { kind: "message", role: "assistant", content: localText }];
            setItems([...localItems]);
          }
          setStreamingText("");
          if (event.data_changed) onDataChanged();

          // Register new session on first message
          if (event.session_id && activeSessionId === null) {
            setActiveSessionId(event.session_id);
            loadSessions(); // refresh sidebar to show the new session with its auto-title
          } else if (event.session_id) {
            // Update sidebar ordering (bump updated_at)
            loadSessions();
          }
          break;
        } else if (event.type === "error") {
          localItems = [...localItems, {
            kind: "message",
            role: "assistant",
            content: `Error: ${(event as AgentStreamEvent & { type: "error" }).message}`,
          }];
          setItems([...localItems]);
          setStreamingText("");
          break;
        }
      }
    } catch (err) {
      localItems = [...localItems, {
        kind: "message",
        role: "assistant",
        content: "Sorry, something went wrong: " + (err instanceof Error ? err.message : "Unknown error"),
      }];
      setItems([...localItems]);
      setStreamingText("");
    } finally {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleStep = (idx: number) => {
    setItems((prev) =>
      prev.map((item, i) =>
        i === idx && item.kind === "tool_step"
          ? { ...item, collapsed: !item.collapsed }
          : item,
      ),
    );
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className={`chat-panel${isOpen ? " open" : ""}`}>
      <div className="chat-panel__header">
        <span>{activeSession?.title ?? "Staffing Assistant"}</span>
        <button className="chat-panel__close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="chat-panel__body">
        {/* Session sidebar */}
        <div className="chat-panel__sidebar">
          <button className="chat-panel__new-session" onClick={handleNewSession}>
            + New chat
          </button>
          <div className="chat-panel__session-list">
            {loadingSessions && <div className="session-loading">Loading…</div>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item${s.id === activeSessionId ? " session-item--active" : ""}`}
                onClick={() => handleSwitchSession(s.id)}
                title={s.title ?? "New conversation"}
              >
                <span className="session-item__title">
                  {s.title ?? "New conversation"}
                </span>
                <button
                  className="session-item__delete"
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  aria-label="Delete session"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Main chat area */}
        <div className="chat-panel__main">
          <div className="chat-panel__messages">
            {items.map((item, idx) => {
              if (item.kind === "message") {
                return (
                  <div key={idx} className={`chat-message ${item.role}`}>
                    {item.content}
                  </div>
                );
              }
              // Tool step
              const isRunning = item.result === null;
              return (
                <div key={idx} className={`tool-step${item.ok ? "" : " tool-step--error"}`}>
                  <button className="tool-step__header" onClick={() => toggleStep(idx)}>
                    <span className={`tool-step__icon${isRunning ? " tool-step__icon--spinning" : ""}`}>
                      {isRunning ? "○" : item.ok ? "✓" : "✗"}
                    </span>
                    <span className="tool-step__name">{formatToolName(item.name)}</span>
                    <span className="tool-step__chevron">{item.collapsed ? "▸" : "▾"}</span>
                  </button>
                  {!item.collapsed && (
                    <div className="tool-step__body">
                      <pre className="tool-step__result">{item.result ?? "Running…"}</pre>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Live streaming text shown while tokens arrive */}
            {streamingText && (
              <div className="chat-message assistant">
                {streamingText}
                <span className="streaming-cursor" />
              </div>
            )}

            {/* Thinking indicator: only when streaming but no text or tool steps yet */}
            {streaming && !streamingText && items[items.length - 1]?.kind !== "tool_step" && (
              <div className="chat-message assistant thinking">Thinking…</div>
            )}

            <div ref={bottomRef} />
          </div>

          <div className="chat-panel__input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Assign Yunxuan 25% on Nucor"
              rows={2}
              disabled={streaming}
            />
            <button className="chat-panel__send" onClick={handleSend} disabled={streaming || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
