import type { BreakCause, CacheBreaksResponse } from "@codex-monitor/shared";

export type CacheBreakEventWithDate = CacheBreaksResponse["events"][number];

interface BreakEventCardProps {
  event: CacheBreakEventWithDate;
}

const causeLabels: Record<BreakCause, string> = {
  ttl_expired: "TTL 만료",
  system_prompt_change: "시스템 프롬프트 변경",
  model_switch: "모델 전환",
  context_rebuild: "컨텍스트 재구성",
  compression: "압축 트리거",
  unknown: "원인 미상"
};

export function BreakEventCard({ event }: BreakEventCardProps) {
  return (
    <article className="cache-break-card">
      <header className="cache-break-card-header">
        <div className="cache-break-card-title">
          <strong>{formatEventTime(event.ts)}</strong>
          <span>{event.model}</span>
        </div>
        <div className="cache-break-card-badges" aria-label="진단 상태">
          <span className={`cache-break-confidence ${event.confidence}`}>
            {event.confidence === "high" ? "높음" : "낮음"}
          </span>
          {event.provider === "codex" ? <span className="cache-break-estimated">추정</span> : null}
        </div>
      </header>

      <div className="cache-break-card-main">
        <div>
          <span>하락폭</span>
          <strong>{formatDroppedPp(event.droppedPp)}</strong>
        </div>
        <div>
          <span>원인</span>
          <strong>{causeLabels[event.primaryCause]}</strong>
        </div>
      </div>

      {event.primaryCause === "unknown" && event.provider === "codex" ? (
        <p className="cache-break-note">Codex는 정밀 진단 불가</p>
      ) : null}

      <details className="cache-break-evidence">
        <summary>evidence</summary>
        <pre>{formatEvidence(event.evidence)}</pre>
      </details>
    </article>
  );
}

function formatEventTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return String(ts);
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDroppedPp(value: number): string {
  return `${(value * 100).toFixed(1)}%p`;
}

function formatEvidence(evidence: Record<string, unknown>): string {
  return JSON.stringify(evidence, null, 2);
}
