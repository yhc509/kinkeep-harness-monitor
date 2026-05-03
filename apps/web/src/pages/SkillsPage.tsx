import { useState } from "react";
import { Settings2 } from "lucide-react";
import { apiResourceKeys, getIntegrations, getSkillDetail } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { DetailModal } from "../components/DetailModal";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatNumber } from "../utils/format";
import { getSourceThemeLabel } from "../utils/providerTheme";

export function SkillsPage() {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const integrations = useApiResource(() => getIntegrations(), {
    deps: [],
    cacheKey: apiResourceKeys.integrations,
    staleTimeMs: 0
  });
  const skillDetail = useApiResource(
    () => selectedSkillId ? getSkillDetail(selectedSkillId) : Promise.resolve(null),
    {
      deps: [selectedSkillId],
      cacheKey: apiResourceKeys.skillDetail(selectedSkillId ?? ""),
      enabled: Boolean(selectedSkillId),
      keepPreviousData: false,
      staleTimeMs: 300_000
    }
  );

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">SKILLS</p>
          <h2>Skills by Provider</h2>
        </div>
        {integrations.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <Settings2 size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.skills.length)} Skills</span>
            </div>
          </div>
        ) : null}
      </section>

      <AsyncPane loading={integrations.initialLoading} error={integrations.error} hasData={integrations.hasData}>
        {integrations.data ? (
          <Panel title="Skills" subtitle="Name" icon={<Settings2 size={16} strokeWidth={2.2} />}>
            {(() => {
              const codexSkills = integrations.data.skills.filter((skill) => skill.source === "codex" || skill.source === "agents");
              const claudeSkills = integrations.data.skills.filter((skill) => skill.source === "claude-code");

              return (
                <div className="skills-provider-columns">
                  <div className="skills-provider-column">
                    <div className="memory-provider-header provider-codex">
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Settings2 size={16} strokeWidth={2.2} />
                        <strong>Codex</strong>
                      </div>
                      <span className="panel-badge">{codexSkills.length}</span>
                    </div>
                    <div className="compact-skill-grid">
                      {codexSkills.length > 0 ? (
                        codexSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            className="detail-row skill-name-row"
                            onClick={() => setSelectedSkillId(skill.id)}
                          >
                            <div className="skill-name-row-header">
                              <h3>{skill.name}</h3>
                              <span className={`skill-source ${skill.source}`}>{getSourceThemeLabel(skill.source)}</span>
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="memory-inline-empty">
                          <span>No Codex skills</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="skills-provider-column">
                    <div className="memory-provider-header provider-claude-code">
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Settings2 size={16} strokeWidth={2.2} />
                        <strong>Claude Code</strong>
                      </div>
                      <span className="panel-badge">{claudeSkills.length}</span>
                    </div>
                    <div className="compact-skill-grid">
                      {claudeSkills.length > 0 ? (
                        claudeSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            className="detail-row skill-name-row"
                            onClick={() => setSelectedSkillId(skill.id)}
                          >
                            <div className="skill-name-row-header">
                              <h3>{skill.name}</h3>
                              <span className={`skill-source ${skill.source}`}>{getSourceThemeLabel(skill.source)}</span>
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="memory-inline-empty">
                          <span>No Claude Code skills</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </Panel>
        ) : null}
      </AsyncPane>

      <DetailModal
        open={Boolean(selectedSkillId)}
        title={skillDetail.data?.name ?? "Skill"}
        subtitle={skillDetail.data?.path}
        onClose={() => setSelectedSkillId(null)}
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
