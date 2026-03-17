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
  showTechnical: boolean;
}

const conversationKinds = new Set(["user_message", "assistant_message"]);

export function SessionTimeline({ items, showTechnical }: SessionTimelineProps) {
  const conversationItems = items.filter((item) => conversationKinds.has(item.kind));
  const technicalItems = items.filter((item) => !conversationKinds.has(item.kind));

  return (
    <div className="conversation-stack">
      {conversationItems.length > 0 ? (
        <div className="conversation-feed">
          {conversationItems.map((item) => {
            const isUser = item.kind === "user_message";
            return (
              <article key={item.id} className={isUser ? "chat-row user" : "chat-row assistant"}>
                <div className="chat-bubble-wrap">
                  <div className={isUser ? "chat-bubble user" : "chat-bubble assistant"}>
                    <pre>{item.body || "-"}</pre>
                  </div>
                  <div className={isUser ? "chat-meta user" : "chat-meta assistant"}>
                    <span>{isUser ? "사용자" : "에이전트"}</span>
                    <span>{formatDateTime(item.timestamp)}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="state-box">대화 메시지 없음</div>
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
          <div className="state-box">기술 로그 없음</div>
        )
      ) : null}
    </div>
  );
}
