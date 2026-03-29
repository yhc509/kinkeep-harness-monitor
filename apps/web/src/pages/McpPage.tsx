import { useState } from "react";
import { Clock3, PlugZap, RefreshCw } from "lucide-react";
import { apiResourceKeys, getIntegrations, refreshIntegrations } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatNumber } from "../utils/format";

export function McpPage() {
  const [refreshBusy, setRefreshBusy] = useState(false);
  const integrations = useApiResource(() => getIntegrations(), {
    deps: [],
    cacheKey: apiResourceKeys.integrations,
    staleTimeMs: 0
  });

  async function handleRefresh() {
    try {
      setRefreshBusy(true);
      await refreshIntegrations();
      integrations.refresh();
    } finally {
      setRefreshBusy(false);
    }
  }

  const codexServers = integrations.data?.mcpServers.filter((server) => server.source === "codex" || server.source === "agents") ?? [];
  const claudeServers = integrations.data?.mcpServers.filter((server) => server.source === "claude-code") ?? [];

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">MCP SERVERS</p>
          <h2>Model Context Protocol Servers</h2>
        </div>
        {integrations.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <PlugZap size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.mcpServers.length)} MCP</span>
            </div>
            <div className="page-chip">
              <Clock3 size={14} strokeWidth={2.2} />
              <span>{formatDateTime(integrations.data.lastSyncedAt)}</span>
            </div>
            {integrations.refreshing || refreshBusy ? (
              <div className="page-chip loading-chip">
                <RefreshCw size={14} strokeWidth={2.2} />
                <span>Refreshing</span>
              </div>
            ) : null}
            {integrations.data.isStale ? (
              <div className="page-chip stale-chip">
                <RefreshCw size={14} strokeWidth={2.2} />
                <span>Cache refresh pending</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <button className="ghost-button" disabled={refreshBusy} onClick={handleRefresh}>
          <RefreshCw size={14} strokeWidth={2.2} />
          {refreshBusy ? "Refreshing" : "Refresh now"}
        </button>
      </section>

      <AsyncPane loading={integrations.initialLoading} error={integrations.error} hasData={integrations.hasData}>
        {integrations.data ? (
          <Panel title="MCP" subtitle="Includes recent calls" icon={<PlugZap size={16} strokeWidth={2.2} />}>
            <div className="skills-provider-columns">
              <div className="skills-provider-column">
                <div className="memory-provider-header provider-codex">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <PlugZap size={16} strokeWidth={2.2} />
                    <strong>Codex MCP Servers</strong>
                  </div>
                  <span className="panel-badge">{codexServers.length}</span>
                </div>
                <div className="integration-list dense-list">
                  {codexServers.length > 0 ? (
                    codexServers.map((server) => (
                      <article key={`${server.source}:${server.name}`} className="integration-card">
                        <header>
                          <h3>{server.name}</h3>
                          <span>{formatNumber(server.usageCount)} calls</span>
                        </header>
                        <p>{server.url ?? "No URL"}</p>
                        <small>{server.toolNames.join(", ") || "No tool calls"}</small>
                      </article>
                    ))
                  ) : (
                    <div className="memory-inline-empty">
                      <span>No Codex MCP servers</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="skills-provider-column">
                <div className="memory-provider-header provider-claude-code">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <PlugZap size={16} strokeWidth={2.2} />
                    <strong>Claude Code MCP Servers</strong>
                  </div>
                  <span className="panel-badge">{claudeServers.length}</span>
                </div>
                <div className="integration-list dense-list">
                  {claudeServers.length > 0 ? (
                    claudeServers.map((server) => (
                      <article key={`${server.source}:${server.name}`} className="integration-card">
                        <header>
                          <h3>{server.name}</h3>
                          <span>{formatNumber(server.usageCount)} calls</span>
                        </header>
                        <p>{server.url ?? "No URL"}</p>
                        <small>{server.toolNames.join(", ") || "No tool calls"}</small>
                      </article>
                    ))
                  ) : (
                    <div className="memory-inline-empty">
                      <span>No Claude Code MCP servers</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Panel>
        ) : null}
      </AsyncPane>
    </div>
  );
}
