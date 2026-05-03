import { useState } from "react";
import { Hammer } from "lucide-react";
import {
  apiResourceKeys,
  getSubagentAttribution,
  getTokens,
  getToolAttribution,
  type TokenAttributionProvider,
  type TokenAttributionRange
} from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { ToolUsageChart } from "../components/ToolUsageChart";
import { useApiResource } from "../hooks/useApiResource";
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

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">TOOLS</p>
          <h2>Tool usage breakdown</h2>
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
  );
}
