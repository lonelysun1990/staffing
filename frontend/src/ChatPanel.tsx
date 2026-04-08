import { useEffect, useRef, useState } from "react";
import { AgentStreamEvent, ChatMessage, api } from "./api";

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

// ── Component ────────────────────────────────────────────────────────────────

export function ChatPanel({ isOpen, onClose, onDataChanged }: ChatPanelProps) {
  const [items, setItems] = useState<MessageItem[]>([GREETING]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState(""); // live token buffer
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, streaming, streamingText]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userItem: MessageItem = { kind: "message", role: "user", content: text };
    const nextItems = [...items, userItem];
    setItems(nextItems);
    setInput("");
    setStreaming(true);
    setStreamingText("");

    // Build history: only role+content messages, skip the initial greeting
    const history: ChatMessage[] = nextItems
      .filter((item): item is MessageItem & { kind: "message" } => item.kind === "message")
      .slice(1) // drop greeting
      .map((m) => ({ role: m.role, content: m.content }));

    // localItems mirrors React state within the async loop to avoid stale closures
    let localItems = [...nextItems];
    let localText = "";

    const updateItem = (predicate: (item: MessageItem) => boolean, updater: (item: MessageItem) => MessageItem) => {
      localItems = localItems.map((item) => (predicate(item) ? updater(item) : item));
      setItems([...localItems]);
    };

    try {
      for await (const event of api.streamAgentMessage(history)) {
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

  return (
    <div className={`chat-panel${isOpen ? " open" : ""}`}>
      <div className="chat-panel__header">
        <span>Staffing Assistant</span>
        <button className="chat-panel__close" onClick={onClose} aria-label="Close">✕</button>
      </div>

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
  );
}
