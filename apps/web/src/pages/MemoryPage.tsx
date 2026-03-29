import { BookMarked, Brain, Clock3 } from "lucide-react";
import { apiResourceKeys, getMemory } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatNumber } from "../utils/format";
import { getProviderLabel, getProviderThemeClassName, type ProviderId } from "../utils/providerTheme";

export function MemoryPage() {
  const memory = useApiResource(() => getMemory(), {
    deps: [],
    cacheKey: apiResourceKeys.memory,
    staleTimeMs: 15_000
  });
  const providerGroups = (memory.data?.providerConfigs ?? []).map((config) => ({
    provider: config.provider,
    config,
    entries: (memory.data?.entries ?? []).filter((entry) => entry.provider === config.provider)
  }));
  const providerCount = providerGroups.length;
  const headingSubtle = memory.data
    ? `Based on ${formatNumber(providerCount)} provider${providerCount === 1 ? "" : "s"}`
    : "Based on provider settings";

  return (
    <div className="page-stack">
      <section className="page-heading memory-heading">
        <div>
          <p className="eyebrow">MEMORY</p>
          <h2>Preferences &amp; Memory</h2>
          <p className="heading-subtle">{headingSubtle}</p>
        </div>
      </section>

      <Panel
        title="Preferences & Memory"
        subtitle="provider split view"
        icon={<Brain size={16} strokeWidth={2.2} />}
      >
        <AsyncPane loading={memory.initialLoading} error={memory.error} hasData={memory.hasData}>
          {memory.data ? (
            <>
              <div className={`memory-provider-columns${providerCount === 1 ? " single-provider" : ""}`}>
                {providerGroups.map((group) => {
                  const provider = group.provider as ProviderId;
                  const providerClassName = getProviderThemeClassName(provider);
                  const providerLabel = getProviderLabel(provider);

                  return (
                    <details key={group.provider} open className="memory-provider-column">
                      <summary className={`memory-provider-fold-trigger ${providerClassName}`}>
                        {providerLabel}
                        <span className="panel-badge">{group.entries.length}</span>
                      </summary>

                      <div className={`memory-provider-header ${providerClassName}`}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Brain size={16} strokeWidth={2.2} />
                          <strong>{providerLabel}</strong>
                        </div>
                        <span className="panel-badge">{group.entries.length} entries</span>
                      </div>

                      {group.config.developerInstructions ? (
                        <section className="preference-card">
                          <div className="preference-card-header">
                            <div>
                              <p className="eyebrow">PREFERENCE</p>
                              <h3>Developer Instructions</h3>
                            </div>
                            {group.config.personality ? (
                              <span className="panel-badge">{group.config.personality}</span>
                            ) : null}
                          </div>
                          <pre className="preference-body">{group.config.developerInstructions}</pre>
                        </section>
                      ) : null}

                      {group.entries.length > 0 ? (
                        <div className="memory-list">
                          {group.entries.map((entry) => (
                            <article
                              key={entry.threadId}
                              className={`memory-card provider-card ${getProviderThemeClassName(entry.provider as ProviderId)}`}
                            >
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
                      ) : (
                        <div className="memory-inline-empty">
                          <span>
                            {group.config.sourceStatus === "empty"
                              ? "No extracted entries"
                              : group.config.sourceStatus === "unsupported"
                                ? "Unsupported"
                                : "Extracted"}
                          </span>
                        </div>
                      )}
                    </details>
                  );
                })}
              </div>

              {providerCount === 0 ? (
                <div className="memory-inline-empty">
                  <span>No provider data</span>
                </div>
              ) : null}

              <div className="memory-aggregate-bar">
                <span>Total threads: <strong>{formatNumber(memory.data.totalThreads)}</strong></span>
                <span>Total entries: <strong>{formatNumber(memory.data.entries.length)}</strong></span>
              </div>
            </>
          ) : null}
        </AsyncPane>
      </Panel>
    </div>
  );
}
