import { Bot, Clock3, PlugZap, Send, TerminalSquare, Wrench } from "lucide-react";
import { formatDateTime } from "../utils/format";

interface TimelineInput {
  id: string;
  timestamp: string;
  kind: "user_message" | "assistant_message" | "developer_message" | "system_message" | "tool_call" | "tool_result" | "token_count" | "event" | "session_meta";
  role: string | null;
  title: string;
  body: string;
  toolName: string | null;
  metadata?: Record<string, string>;
}

interface SessionTimelineProps {
  items: TimelineInput[];
  showActivity: boolean;
  showTechnical: boolean;
}

const conversationKinds = new Set(["user_message", "assistant_message"]);
const hiddenActivityTools = new Set(["apply_patch", "exec_command", "write_stdin"]);

export function SessionTimeline({ items, showActivity, showTechnical }: SessionTimelineProps) {
  const visibleItems = items.filter((item) => isConversationItem(item) || (showActivity && isActivityItem(item)));
  const technicalItems = items.filter((item) => !isConversationItem(item) && !(showActivity && isActivityItem(item)));

  return (
    <div className="conversation-stack">
      {visibleItems.length > 0 ? (
        <div className="conversation-feed">
          {visibleItems.map((item) => {
            if (isConversationItem(item)) {
              const isUser = item.kind === "user_message";
              return (
                <article key={item.id} className={isUser ? "chat-row user" : "chat-row assistant"}>
                  <div className="chat-bubble-wrap">
                    <div className={isUser ? "chat-bubble user" : "chat-bubble assistant"}>
                      <pre>{item.body || "-"}</pre>
                    </div>
                    <div className={isUser ? "chat-meta user" : "chat-meta assistant"}>
                      <span>{isUser ? "User" : "Agent"}</span>
                      <span>{formatDateTime(item.timestamp)}</span>
                    </div>
                  </div>
                </article>
              );
            }

            const activity = summarizeActivity(item);
            return (
              <article key={item.id} className="activity-row">
                <div className={`activity-card ${activity.tone}`}>
                  <span className={`activity-icon ${activity.tone}`} aria-hidden="true">
                    <activity.icon size={15} strokeWidth={2.2} />
                  </span>
                  <div className="activity-copy">
                    <div className="activity-header">
                      <strong>{activity.label}</strong>
                      <span>{formatDateTime(item.timestamp)}</span>
                    </div>
                    <p>{activity.summary}</p>
                    {activity.meta ? <small>{activity.meta}</small> : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="state-box">No conversation messages</div>
      )}

      {showTechnical ? (
        technicalItems.length > 0 ? (
          <div className="technical-log">
            {technicalItems.map((item) => (
              <article key={item.id} className={`timeline-item ${item.kind}`}>
                <div className="timeline-meta">
                  <span className="timeline-kind">{item.kind}</span>
                  <span>{formatDateTime(item.timestamp)}</span>
                </div>
                <h3>{item.title}</h3>
                <pre>{item.body || "-"}</pre>
              </article>
            ))}
          </div>
        ) : (
          <div className="state-box">No technical logs</div>
        )
      ) : null}
    </div>
  );
}

function isConversationItem(item: TimelineInput) {
  return conversationKinds.has(item.kind);
}

function isActivityItem(item: TimelineInput) {
  if (item.kind !== "tool_call" && item.kind !== "tool_result") {
    return false;
  }

  return item.toolName ? !hiddenActivityTools.has(item.toolName) : false;
}

function summarizeActivity(item: TimelineInput) {
  const payload = parseJsonRecord(item.body);
  const toolName = item.toolName ?? "tool";

  if (item.kind === "tool_call") {
    if (toolName === "spawn_agent") {
      return {
        label: "Spawn subagent",
        summary: [stringValue(payload.agent_type) ?? "agent", booleanValue(payload.fork_context) ? "Forked context" : "New context"].join(" · "),
        meta: firstLine(stringValue(payload.message) ?? item.body),
        icon: Bot,
        tone: "agent" as const
      };
    }

    if (toolName === "send_input") {
      return {
        label: "Send input",
        summary: booleanValue(payload.interrupt) ? "Interrupt" : "Queued",
        meta: firstLine(stringValue(payload.message) ?? stringValue(payload.id) ?? item.body),
        icon: Send,
        tone: "agent" as const
      };
    }

    if (toolName === "wait") {
      return {
        label: "Wait for agent",
        summary: `${arrayLength(payload.ids)} items · ${formatDuration(stringNumber(payload.timeout_ms))}`,
        meta: null,
        icon: Clock3,
        tone: "muted" as const
      };
    }

    if (toolName.startsWith("mcp__")) {
      return {
        label: "MCP call",
        summary: describeMcpTool(toolName),
        meta: firstLine(stringValue(payload.query) ?? stringValue(payload.url) ?? item.body),
        icon: PlugZap,
        tone: "tool" as const
      };
    }

    return {
      label: "Tool call",
      summary: toolName,
      meta: firstLine(compactSnippet(item.body)),
      icon: Wrench,
      tone: "tool" as const
    };
  }

  if (toolName === "spawn_agent") {
    return {
      label: "Subagent created",
      summary: stringValue(payload.nickname) ?? stringValue(payload.agent_id) ?? "Created",
      meta: null,
      icon: Bot,
      tone: "agent" as const
    };
  }

  if (toolName === "send_input") {
    return {
      label: "Input sent",
      summary: stringValue(payload.submission_id) ?? "Sent",
      meta: null,
      icon: Send,
      tone: "agent" as const
    };
  }

  if (toolName === "wait") {
    return {
      label: "Wait result",
      summary: booleanValue(payload.timed_out) ? "Timed out" : "Response received",
      meta: null,
      icon: Clock3,
      tone: booleanValue(payload.timed_out) ? "warm" as const : "muted" as const
    };
  }

  if (toolName.startsWith("mcp__")) {
    return {
      label: "MCP result",
      summary: describeMcpTool(toolName),
      meta: firstLine(compactSnippet(item.body)),
      icon: PlugZap,
      tone: "tool" as const
    };
  }

  return {
    label: "Tool result",
    summary: toolName,
    meta: firstLine(summarizeToolResult(item.body)),
    icon: TerminalSquare,
    tone: "muted" as const
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function describeMcpTool(toolName: string) {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) {
    return toolName;
  }

  return `${match[1]} · ${match[2]}`;
}

function summarizeToolResult(body: string) {
  const compact = compactSnippet(body);
  if (!compact) {
    return "No result";
  }

  const exitCode = body.match(/Process exited with code (\d+)/);
  if (exitCode) {
    return `Exit code ${exitCode[1]}`;
  }

  return compact;
}

function compactSnippet(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^Output:\s*/i, "")
    .trim()
    .slice(0, 120);
}

function firstLine(value: string | null) {
  if (!value) {
    return null;
  }

  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean) ?? "";
  if (!line) {
    return null;
  }

  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function stringNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function booleanValue(value: unknown) {
  return value === true;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function formatDuration(value: number | null) {
  if (!value || value < 1000) {
    return "-";
  }

  if (value % 60_000 === 0) {
    return `${value / 60_000} min`;
  }

  return `${Math.round(value / 1000)} sec`;
}
