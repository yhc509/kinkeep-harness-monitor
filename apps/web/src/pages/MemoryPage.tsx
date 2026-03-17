import type { MemoryResponse } from "@codex-monitor/shared";
import { BookMarked, Brain, Clock3 } from "lucide-react";
import { apiResourceKeys, getMemory } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatNumber } from "../utils/format";

export function MemoryPage() {
  const memory = useApiResource(() => getMemory(), {
    deps: [],
    cacheKey: apiResourceKeys.memory,
    staleTimeMs: 15_000
  });

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">MEMORY</p>
          <h2>추출 메모리</h2>
        </div>
        {memory.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <Brain size={14} strokeWidth={2.2} />
              <span>{formatNumber(memory.data.entries.length)} entries</span>
            </div>
            <div className="page-chip">
              <BookMarked size={14} strokeWidth={2.2} />
              <span>{formatNumber(memory.data.modeCounts.length)} modes</span>
            </div>
            <div className="page-chip">
              <Clock3 size={14} strokeWidth={2.2} />
              <span>{getMemoryStateTitle(memory.data.sourceStatus)}</span>
            </div>
          </div>
        ) : null}
      </section>

      <Panel
        title="Memory State"
        subtitle="stage1 summary"
        icon={<Brain size={16} strokeWidth={2.2} />}
        actions={memory.data ? (
          <div className="panel-badges">
            {memory.data.modeCounts.map((item) => (
              <span key={item.mode} className="panel-badge muted-badge">
                {item.mode} {formatNumber(item.count)}
              </span>
            ))}
          </div>
        ) : null}
      >
        <AsyncPane loading={memory.initialLoading} error={memory.error} hasData={memory.hasData}>
          {memory.data ? (
            <>
              {memory.data.entries.length === 0 ? (
                <div className="state-box">
                  <strong>{getMemoryStateTitle(memory.data.sourceStatus)}</strong>
                  <p className="state-copy">{getMemoryStateMeta(memory.data)}</p>
                </div>
              ) : (
                <div className="memory-list">
                  {memory.data.entries.map((entry) => (
                    <article key={entry.threadId} className="memory-card">
                      <header>
                        <div>
                          <h3>{entry.title}</h3>
                          <p>{entry.threadId}</p>
                        </div>
                        <div className="memory-meta">
                          <span><Clock3 size={13} />{formatDateTime(entry.generatedAt)}</span>
                          <span><BookMarked size={13} />{entry.usageCount ?? 0}</span>
                        </div>
                      </header>
                      <p className="memory-summary">{entry.rolloutSummary || "요약 없음"}</p>
                      <details className="inline-disclosure">
                        <summary>raw memory</summary>
                        <pre>{entry.rawMemory}</pre>
                      </details>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </AsyncPane>
      </Panel>
    </div>
  );
}

function getMemoryStateTitle(status: "ready" | "empty" | "unsupported") {
  if (status === "unsupported") {
    return "source table 없음";
  }

  if (status === "empty") {
    return "추출 기록 없음";
  }

  return "메모리 준비";
}

function getMemoryStateMeta(memory: MemoryResponse) {
  if (memory.sourceStatus === "unsupported") {
    return "stage1_outputs 없음";
  }

  if (memory.sourceStatus === "empty") {
    return `stage1_outputs 0 · threads ${formatNumber(memory.totalThreads)}`;
  }

  return `stage1_outputs ${formatNumber(memory.stage1OutputCount)}`;
}
