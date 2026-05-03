import { useMemo } from "react";
import type { SubagentAttributionEntry, SubagentAttributionResponse } from "@codex-monitor/shared";
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
  const combinedTotal = data.root.totalTokens + subagentSummary.totalTokens;
  const rootPercent = combinedTotal > 0 ? (data.root.totalTokens / combinedTotal) * 100 : 0;
  const subagentPercent = combinedTotal > 0 ? (subagentSummary.totalTokens / combinedTotal) * 100 : 0;

  return (
    <Panel
      title="Sub-agent token split"
      subtitle="Root sessions vs spawned work"
      icon={<GitBranch size={16} strokeWidth={2.2} />}
    >
      <section className="subagent-attribution-summary" aria-label="Root and sub-agent token totals">
        {data.notes.length > 0 ? (
          <p className="subagent-attribution-note">{data.notes[0]}</p>
        ) : null}
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
