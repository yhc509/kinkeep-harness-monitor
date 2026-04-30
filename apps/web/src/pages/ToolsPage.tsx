import { useState } from "react";
import { Clock3, Hammer, RefreshCw } from "lucide-react";
import {
  apiResourceKeys,
  createSnapshot,
  getSubagentAttribution,
  getTokens,
  getToolAttribution,
  type TokenAttributionProvider,
  type TokenAttributionRange
} from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { ToolUsageChart } from "../components/ToolUsageChart";
import { invalidateApiResource, useApiResource } from "../hooks/useApiResource";
import { formatDateTime } from "../utils/format";
import { SubagentAttributionPanel } from "./ToolsPage/SubagentAttributionPanel";
import { ToolAttributionPanel } from "./ToolsPage/ToolAttributionPanel";

const ranges: TokenAttributionRange[] = [7, 30, 90];
const providers: Array<{ value: TokenAttributionProvider; label: string }> = [
  { value: "all", label: "전체" },
  { value: "claude_code", label: "Claude" },
  { value: "codex", label: "Codex" }
];

export function ToolsPage() {
  const [range, setRange] = useState<TokenAttributionRange>(7);
  const [provider, setProvider] = useState<TokenAttributionProvider>("all");
  const [syncBusy, setSyncBusy] = useState(false);
  const tokens = useApiResource(() => getTokens(range), {
    deps: [range],
    cacheKey: apiResourceKeys.tokens(range),
    staleTimeMs: 300_000
  });
  const toolAttribution = useApiResource(() => getToolAttribution(range, provider), {
    deps: [range, provider],
    cacheKey: apiResourceKeys.toolAttribution(range, provider),
    staleTimeMs: 300_000
  });
  const subagentAttribution = useApiResource(() => getSubagentAttribution(range, provider), {
    deps: [range, provider],
    cacheKey: apiResourceKeys.subagentAttribution(range, provider),
    staleTimeMs: 300_000
  });

  async function handleSync() {
    try {
      setSyncBusy(true);
      await createSnapshot();
      invalidateApiResource(apiResourceKeys.overview);
      tokens.refresh();
      toolAttribution.refresh();
      subagentAttribution.refresh();
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">TOOLS</p>
          <h2>Tool usage breakdown</h2>
        </div>
        <div className="inline-actions">
          {tokens.data ? (
            <div className="page-chip">
              <Clock3 size={14} strokeWidth={2.2} />
              <span>{formatDateTime(tokens.data.lastSyncedAt)}</span>
            </div>
          ) : null}
          {tokens.refreshing || toolAttribution.refreshing || subagentAttribution.refreshing ? (
            <div className="page-chip loading-chip">
              <RefreshCw size={14} strokeWidth={2.2} />
              <span>Refreshing</span>
            </div>
          ) : null}
          <button className="primary-button" disabled={syncBusy} onClick={handleSync}>
            <RefreshCw size={14} strokeWidth={2.2} />
            {syncBusy ? "Syncing" : "Sync now"}
          </button>
        </div>
      </section>

      <div className="tools-filter-bar">
        <div className="tools-filter-group">
          <span className="tools-filter-label">Range</span>
          <div className="segmented" aria-label="Tool attribution range">
            {ranges.map((item) => (
              <button
                key={item}
                className={item === range ? "segment active" : "segment"}
                onClick={() => setRange(item)}
              >
                {item}d
              </button>
            ))}
          </div>
        </div>
        <div className="tools-filter-group">
          <span className="tools-filter-label">Provider</span>
          <div className="segmented" aria-label="Tool attribution provider">
            {providers.map((item) => (
              <button
                key={item.value}
                className={item.value === provider ? "segment active" : "segment"}
                onClick={() => setProvider(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <AsyncPane loading={tokens.initialLoading} error={tokens.error} hasData={tokens.hasData}>
        {tokens.data ? (
          <Panel
            title="툴 사용 빈도"
            subtitle={`${range}-day calls`}
            icon={<Hammer size={16} strokeWidth={2.2} />}
          >
            <ToolUsageChart data={tokens.data.toolUsage} />
          </Panel>
        ) : null}
      </AsyncPane>

      <div className="tools-attribution-grid">
        <AsyncPane
          loading={toolAttribution.initialLoading}
          error={toolAttribution.error}
          hasData={toolAttribution.hasData}
        >
          {toolAttribution.data ? (
            <ToolAttributionPanel
              data={toolAttribution.data.tools}
              provider={provider}
              range={range}
            />
          ) : null}
        </AsyncPane>

        <AsyncPane
          loading={subagentAttribution.initialLoading}
          error={subagentAttribution.error}
          hasData={subagentAttribution.hasData}
        >
          {subagentAttribution.data ? <SubagentAttributionPanel data={subagentAttribution.data} /> : null}
        </AsyncPane>
      </div>
    </div>
  );
}
