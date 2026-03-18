import type { MemoryResponse } from "@codex-monitor/shared";
import { BookMarked, Brain, Clock3, UserRound } from "lucide-react";
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
  const hasEntries = (memory.data?.entries.length ?? 0) > 0;

  return (
    <div className="page-stack">
      <section className="page-heading memory-heading">
        <div>
          <p className="eyebrow">MEMORY</p>
          <h2>Preferences</h2>
          <p className="heading-subtle">Based on Codex settings</p>
        </div>
        {memory.data?.personality ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <UserRound size={14} strokeWidth={2.2} />
              <span>{memory.data.personality}</span>
            </div>
          </div>
        ) : null}
      </section>

      <Panel
        title="Preferences"
        subtitle="developer_instructions"
        icon={<Brain size={16} strokeWidth={2.2} />}
      >
        <AsyncPane loading={memory.initialLoading} error={memory.error} hasData={memory.hasData}>
          {memory.data ? (
            <div className="memory-layout">
              <section className="preference-card">
                <div className="preference-card-header">
                  <div>
                    <p className="eyebrow">PREFERENCE</p>
                    <h3>Preferences</h3>
                  </div>
                  {memory.data.personality ? (
                    <span className="panel-badge">{memory.data.personality}</span>
                  ) : null}
                </div>
                <pre className="preference-body">{memory.data.developerInstructions || "No settings"}</pre>
              </section>

              <aside className="memory-status-card">
                <div className="memory-status-row">
                  <span>Session memory</span>
                  <strong>{getSessionMemoryLabel(memory.data)}</strong>
                </div>
                <div className="memory-status-row">
                  <span>Extracted entries</span>
                  <strong>{formatNumber(memory.data.stage1OutputCount)}</strong>
                </div>
                <div className="memory-status-row">
                  <span>threads</span>
                  <strong>{formatNumber(memory.data.totalThreads)}</strong>
                </div>
              </aside>

              {hasEntries ? (
                <section className="memory-section">
                  <div className="memory-section-header">
                    <div>
                      <p className="eyebrow">SESSION MEMORY</p>
                      <h3>Extracted entries</h3>
                    </div>
                    <div className="page-chip-group">
                      <div className="page-chip">
                        <BookMarked size={14} strokeWidth={2.2} />
                        <span>{formatNumber(memory.data.entries.length)}</span>
                      </div>
                    </div>
                  </div>

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
                        <p className="memory-summary">{entry.rolloutSummary || "No summary"}</p>
                        <details className="inline-disclosure">
                          <summary>raw memory</summary>
                          <pre>{entry.rawMemory}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                </section>
              ) : (
                <section className="memory-section compact-section">
                  <div className="memory-section-header">
                    <div>
                      <p className="eyebrow">SESSION MEMORY</p>
                      <h3>Extracted entries</h3>
                    </div>
                  </div>
                  <div className="memory-inline-empty">
                    <span>{getSessionMemoryLabel(memory.data)}</span>
                    <small>{getSessionMemoryMeta(memory.data)}</small>
                  </div>
                </section>
              )}
            </div>
          ) : null}
        </AsyncPane>
      </Panel>
    </div>
  );
}

function getSessionMemoryLabel(memory: MemoryResponse) {
  if (memory.sourceStatus === "unsupported") {
    return "Unsupported";
  }

  if (memory.sourceStatus === "empty") {
    return "No extracted entries";
  }

  return "Extracted";
}

function getSessionMemoryMeta(memory: MemoryResponse) {
  if (memory.sourceStatus === "unsupported") {
    return "No stage1_outputs";
  }

  if (memory.sourceStatus === "empty") {
    return "No session memory row for the current session";
  }

  return `stage1_outputs ${formatNumber(memory.stage1OutputCount)}`;
}
