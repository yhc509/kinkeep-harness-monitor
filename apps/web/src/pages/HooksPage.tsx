import { useState } from "react";
import { Wrench } from "lucide-react";
import { apiResourceKeys, getHookDetail, getIntegrations } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { DetailModal } from "../components/DetailModal";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { formatNumber } from "../utils/format";
import { getSourceThemeClassName, getSourceThemeLabel } from "../utils/providerTheme";

export function HooksPage() {
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const integrations = useApiResource(() => getIntegrations(), {
    deps: [],
    cacheKey: apiResourceKeys.integrations,
    staleTimeMs: 0
  });
  const hookDetail = useApiResource(
    () => selectedHookId ? getHookDetail(selectedHookId) : Promise.resolve(null),
    {
      deps: [selectedHookId],
      cacheKey: apiResourceKeys.hookDetail(selectedHookId ?? ""),
      enabled: Boolean(selectedHookId),
      keepPreviousData: false,
      staleTimeMs: 300_000
    }
  );

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">HOOKS</p>
          <h2>Hook Integrations</h2>
        </div>
        {integrations.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <Wrench size={14} strokeWidth={2.2} />
              <span>{formatNumber(integrations.data.hooks.length)} Hooks</span>
            </div>
          </div>
        ) : null}
      </section>

      <AsyncPane loading={integrations.initialLoading} error={integrations.error} hasData={integrations.hasData}>
        {integrations.data ? (
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
                    onClick={() => setSelectedHookId(hook.id)}
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
        ) : null}
      </AsyncPane>

      <DetailModal
        open={Boolean(selectedHookId)}
        title={hookDetail.data?.name ?? "Hook"}
        subtitle={hookDetail.data?.source}
        onClose={() => setSelectedHookId(null)}
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
    </div>
  );
}
