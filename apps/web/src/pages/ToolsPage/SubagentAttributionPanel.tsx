import { useMemo } from "react";
import type { Provider, SubagentAttributionEntry, SubagentAttributionResponse } from "@codex-monitor/shared";
import { GitBranch } from "lucide-react";
import { Panel } from "../../components/Panel";
import { formatNumber } from "../../utils/format";

interface SubagentAttributionPanelProps {
  data: SubagentAttributionResponse;
}

interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function SubagentAttributionPanel({ data }: SubagentAttributionPanelProps) {
  const subagentSummary = useMemo(() => summarizeSubagents(data.subagents), [data.subagents]);
  const topSubagents = useMemo(
    () => [...data.subagents]
      .sort((left, right) => right.totalTokens - left.totalTokens || left.sessionId.localeCompare(right.sessionId))
      .slice(0, 5),
    [data.subagents]
  );
  const combinedTotal = data.root.totalTokens + subagentSummary.totalTokens;
  const rootPercent = combinedTotal > 0 ? (data.root.totalTokens / combinedTotal) * 100 : 0;
  const subagentPercent = combinedTotal > 0 ? (subagentSummary.totalTokens / combinedTotal) * 100 : 0;

  return (
    <Panel
      title="Sub-agent token split"
      subtitle="Root sessions vs spawned work"
      icon={<GitBranch size={16} strokeWidth={2.2} />}
    >
      <div className="subagent-attribution-layout">
        <section className="subagent-attribution-summary" aria-label="Root and sub-agent token totals">
          <div className="subagent-stack-bar" aria-hidden="true">
            <span
              className="root-segment"
              style={{ width: `${rootPercent}%` }}
              title={`Root ${formatNumber(data.root.totalTokens)}`}
            />
            <span
              className="subagent-segment"
              style={{ width: `${subagentPercent}%` }}
              title={`Sub-agents ${formatNumber(subagentSummary.totalTokens)}`}
            />
          </div>
          <div className="subagent-summary-grid">
            <Metric label="Root" value={data.root} />
            <Metric label="Sub-agents" value={subagentSummary} />
          </div>
        </section>

        <section className="subagent-top-list" aria-label="Top sub-agents by tokens">
          {topSubagents.length > 0 ? (
            topSubagents.map((entry) => (
              <article key={`${entry.provider}:${entry.sessionId}`} className="subagent-attribution-row">
                <div className="subagent-attribution-main">
                  <div className="subagent-attribution-title">
                    <strong title={entry.sessionId}>{truncateSessionId(entry.sessionId)}</strong>
                    <span className={`provider-badge ${toProviderClassName(entry.provider)}`}>
                      {formatProviderLabel(entry.provider)}
                    </span>
                    {entry.estimated ? <span className="attribution-estimated-badge">추정</span> : null}
                  </div>
                  <p>parent {entry.parentSessionId ? truncateSessionId(entry.parentSessionId) : "-"}</p>
                </div>
                <div className="subagent-attribution-value">
                  <strong>{formatNumber(entry.totalTokens)}</strong>
                  <span>{formatNumber(entry.inputTokens)} in / {formatNumber(entry.outputTokens)} out</span>
                </div>
              </article>
            ))
          ) : (
            <div className="subagent-attribution-empty">sub-agents 활동 없음</div>
          )}
        </section>
      </div>
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: TokenSummary }) {
  return (
    <div className="subagent-summary-card">
      <span>{label}</span>
      <strong>{formatNumber(value.totalTokens)}</strong>
      <p>{formatNumber(value.inputTokens)} input / {formatNumber(value.outputTokens)} output</p>
    </div>
  );
}

function summarizeSubagents(subagents: SubagentAttributionEntry[]): TokenSummary {
  return subagents.reduce<TokenSummary>(
    (summary, entry) => ({
      inputTokens: summary.inputTokens + entry.inputTokens,
      outputTokens: summary.outputTokens + entry.outputTokens,
      totalTokens: summary.totalTokens + entry.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

function truncateSessionId(value: string): string {
  return value.slice(0, 8);
}

function toProviderClassName(provider: Provider): "provider-claude-code" | "provider-codex" {
  return provider === "claude_code" ? "provider-claude-code" : "provider-codex";
}

function formatProviderLabel(provider: Provider): string {
  return provider === "claude_code" ? "Claude Code" : "Codex";
}
