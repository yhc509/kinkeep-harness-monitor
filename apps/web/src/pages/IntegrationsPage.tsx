import { useState } from "react";
import { Blocks, Clock3, PlugZap, RefreshCw, Settings2, Wrench } from "lucide-react";
import {
  apiResourceKeys,
  getHookDetail,
  getIntegrations,
  getSkillDetail,
  refreshIntegrations
} from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { DetailModal } from "../components/DetailModal";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatNumber } from "../utils/format";
import { getSourceThemeClassName, getSourceThemeLabel } from "../utils/providerTheme";

type DetailTarget =
  | { type: "hook"; id: string }
  | { type: "skill"; id: string }
  | null;

export function IntegrationsPage() {
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const integrations = useApiResource(() => getIntegrations(), {
    deps: [],
    cacheKey: apiResourceKeys.integrations,
    staleTimeMs: 0
  });
  const hookDetail = useApiResource(
    () => detailTarget?.type === "hook" ? getHookDetail(detailTarget.id) : Promise.resolve(null),
    {
      deps: [detailTarget?.type, detailTarget?.id],
      cacheKey: apiResourceKeys.hookDetail(detailTarget?.type === "hook" ? detailTarget.id : ""),
      enabled: detailTarget?.type === "hook",
      keepPreviousData: false,
      staleTimeMs: 60_000
    }
  );
  const skillDetail = useApiResource(
    () => detailTarget?.type === "skill" ? getSkillDetail(detailTarget.id) : Promise.resolve(null),
    {
      deps: [detailTarget?.type, detailTarget?.id],
      cacheKey: apiResourceKeys.skillDetail(detailTarget?.type === "skill" ? detailTarget.id : ""),
      enabled: detailTarget?.type === "skill",
      keepPreviousData: false,
      staleTimeMs: 60_000
    }
  );

  async function handleRefresh() {
    try {
      setRefreshBusy(true);
      await refreshIntegrations();
      integrations.refresh();
    } finally {
      setRefreshBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">INTEGRATIONS</p>
          <h2>MCP / Hooks / Skills</h2>
        </div>
        {integrations.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <PlugZap size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.mcpServers.length)} MCP</span>
            </div>
            <div className="page-chip">
              <Blocks size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.skills.length)} Skills</span>
            </div>
            <div className="page-chip">
              <Wrench size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.hooks.length)} Hooks</span>
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
          <>
            <div className="two-column">
              <Panel title="MCP" subtitle="Includes recent calls" icon={<PlugZap size={16} strokeWidth={2.2} />}>
                <div className="integration-list dense-list">
                  {integrations.data.mcpServers.map((server) => (
                    <article key={server.name} className="integration-card">
                      <header>
                        <h3>{server.name}</h3>
                        <span>{formatNumber(server.usageCount)} calls</span>
                      </header>
                      <p>{server.url ?? "No URL"}</p>
                      <small>{server.toolNames.join(", ") || "No tool calls"}</small>
                    </article>
                  ))}
                </div>
              </Panel>

              <Panel title="Hooks" subtitle="Summary" icon={<Wrench size={16} strokeWidth={2.2} />}>
                <div className="integration-list dense-list">
                  {integrations.data.hooks.map((hook) => {
                    const sourceTheme = getSourceThemeClassName(hook.source);
                    const providerCardClass = sourceTheme && sourceTheme !== "agents" ? ` provider-card provider-${sourceTheme}` : "";

                    return (
                      <button
                        key={hook.id}
                        type="button"
                        className={`detail-row integration-card${providerCardClass}`}
                        onClick={() => setDetailTarget({ type: "hook", id: hook.id })}
                      >
                        <header>
                          <h3>{hook.name}</h3>
                          <div className="integration-card-tags">
                            <span>{hook.kind}</span>
                            {sourceTheme ? <span className={`source-pill ${sourceTheme}`}>{getSourceThemeLabel(sourceTheme)}</span> : null}
                          </div>
                        </header>
                        <p>{hook.preview}</p>
                        <small>{hook.source}</small>
                      </button>
                    );
                  })}
                </div>
              </Panel>
            </div>

            <Panel title="Skills" subtitle="Name" icon={<Settings2 size={16} strokeWidth={2.2} />}>
              {(() => {
                const codexSkills = integrations.data.skills.filter((skill) => skill.source === "codex" || skill.source === "agents");
                const claudeSkills = integrations.data.skills.filter((skill) => skill.source === "claude-code");

                return (
                  <div className="fold-list">
                    {codexSkills.length > 0 ? (
                      <details className="fold-panel" open>
                        <summary className="fold-summary">
                          <div className="fold-summary-main">
                            <Settings2 size={15} strokeWidth={2.2} />
                            <strong>Codex</strong>
                          </div>
                          <span>{codexSkills.length}</span>
                        </summary>
                        <div className="fold-content">
                          <div className="compact-skill-grid">
                            {codexSkills.map((skill) => (
                              <button
                                key={skill.id}
                                type="button"
                                className="detail-row skill-name-row"
                                onClick={() => setDetailTarget({ type: "skill", id: skill.id })}
                              >
                                <div className="skill-name-row-header">
                                  <h3>{skill.name}</h3>
                                  <span className={`skill-source ${skill.source}`}>{getSourceThemeLabel(skill.source)}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      </details>
                    ) : null}
                    {claudeSkills.length > 0 ? (
                      <details className="fold-panel" open>
                        <summary className="fold-summary">
                          <div className="fold-summary-main">
                            <Settings2 size={15} strokeWidth={2.2} />
                            <strong>Claude Code</strong>
                          </div>
                          <span>{claudeSkills.length}</span>
                        </summary>
                        <div className="fold-content">
                          <div className="compact-skill-grid">
                            {claudeSkills.map((skill) => (
                              <button
                                key={skill.id}
                                type="button"
                                className="detail-row skill-name-row"
                                onClick={() => setDetailTarget({ type: "skill", id: skill.id })}
                              >
                                <div className="skill-name-row-header">
                                  <h3>{skill.name}</h3>
                                  <span className={`skill-source ${skill.source}`}>{getSourceThemeLabel(skill.source)}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      </details>
                    ) : null}
                  </div>
                );
              })()}
            </Panel>
          </>
        ) : null}
      </AsyncPane>

      <DetailModal
        open={detailTarget?.type === "hook"}
        title={hookDetail.data?.name ?? "Hook"}
        subtitle={hookDetail.data?.source}
        onClose={() => setDetailTarget(null)}
      >
        <AsyncPane loading={hookDetail.initialLoading} error={hookDetail.error} hasData={hookDetail.hasData}>
          {hookDetail.data ? (
            <div className="modal-stack">
              {(() => {
                const sourceTheme = getSourceThemeClassName(hookDetail.data.source);

                return (
                  <div className="page-chip-group">
                    <div className="page-chip">
                      <Wrench size={14} strokeWidth={2.2} />
                      <span>{hookDetail.data.kind}</span>
                    </div>
                    {sourceTheme ? <span className={`source-pill ${sourceTheme}`}>{getSourceThemeLabel(sourceTheme)}</span> : null}
                  </div>
                );
              })()}
              <pre className="modal-pre">{hookDetail.data.command}</pre>
            </div>
          ) : null}
        </AsyncPane>
      </DetailModal>

      <DetailModal
        open={detailTarget?.type === "skill"}
        title={skillDetail.data?.name ?? "Skill"}
        subtitle={skillDetail.data?.path}
        onClose={() => setDetailTarget(null)}
      >
        <AsyncPane loading={skillDetail.initialLoading} error={skillDetail.error} hasData={skillDetail.hasData}>
          {skillDetail.data ? (
            <div className="modal-stack">
              <div className="page-chip-group">
                <span className={`source-pill ${skillDetail.data.source}`}>
                  <Settings2 size={14} strokeWidth={2.2} />
                  <span>{getSourceThemeLabel(skillDetail.data.source)}</span>
                </span>
              </div>
              <pre className="modal-pre">{skillDetail.data.content}</pre>
            </div>
          ) : null}
        </AsyncPane>
      </DetailModal>
    </div>
  );
}
