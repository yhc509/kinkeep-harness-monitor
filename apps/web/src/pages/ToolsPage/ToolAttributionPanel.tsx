import { useMemo } from "react";
import type { Provider, ToolAttributionEntry } from "@codex-monitor/shared";
import { Boxes } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TokenAttributionProvider, TokenAttributionRange } from "../../api";
import { Panel } from "../../components/Panel";
import { formatNumber } from "../../utils/format";

interface ToolAttributionPanelProps {
  data: ToolAttributionEntry[];
  provider: TokenAttributionProvider;
  range: TokenAttributionRange;
}

type AttributionProviderLabel = Provider | "mixed";

interface ToolAttributionRow {
  key: string;
  label: string;
  toolName: string;
  provider: AttributionProviderLabel;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  hiddenCount?: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ToolAttributionRow;
  }>;
}

const TOP_TOOL_LIMIT = 10;

export function ToolAttributionPanel({ data, provider, range }: ToolAttributionPanelProps) {
  const chartData = useMemo(() => buildChartRows(data), [data]);
  const chartHeight = Math.max(260, chartData.length * 38 + 58);
  const legendSwatchClass = getLegendSwatchClass(provider);

  return (
    <Panel
      title="툴별 토큰 기여도"
      subtitle={`${range}-day breakdown`}
      icon={<Boxes size={16} strokeWidth={2.2} />}
      actions={(
        <>
          <div className="token-attribution-legend" aria-hidden="true">
            <span><i className={`input-swatch ${legendSwatchClass}`} />Input</span>
            <span><i className={`output-swatch ${legendSwatchClass}`} />Output</span>
          </div>
          <span className="panel-badge muted-badge">{formatProviderFilterLabel(provider)}</span>
        </>
      )}
    >
      {chartData.length > 0 ? (
        <div className="tool-attribution-scroll">
          <div className="tool-attribution-canvas">
            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 84, bottom: 8, left: 8 }}
                barCategoryGap="22%"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tickFormatter={formatChartNumber}
                  stroke="rgba(255,255,255,0.42)"
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={230}
                  tick={{ fill: "rgba(255,255,255,0.72)", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={<ToolAttributionTooltip />} />
                <Bar
                  dataKey="inputTokens"
                  name="Input tokens"
                  stackId="tokens"
                  fill="var(--tool-token-input)"
                  radius={[7, 0, 0, 7]}
                  maxBarSize={22}
                >
                  {chartData.map((entry) => (
                    <Cell key={`${entry.key}:input`} fill={getInputColor(entry.provider)} />
                  ))}
                </Bar>
                <Bar
                  dataKey="outputTokens"
                  name="Output tokens"
                  stackId="tokens"
                  fill="var(--tool-token-output)"
                  radius={[0, 7, 7, 0]}
                  maxBarSize={22}
                >
                  {chartData.map((entry) => (
                    <Cell key={`${entry.key}:output`} fill={getOutputColor(entry.provider)} />
                  ))}
                  <LabelList
                    dataKey="totalTokens"
                    position="right"
                    formatter={formatChartNumber}
                    fill="rgba(255,255,255,0.72)"
                    fontSize={12}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="tool-usage-empty">
          <strong>토큰 출처 데이터 없음</strong>
        </div>
      )}
    </Panel>
  );
}

function buildChartRows(data: ToolAttributionEntry[]): ToolAttributionRow[] {
  const rows: ToolAttributionRow[] = data
    .map((entry) => ({
      key: `${entry.provider}:${entry.toolName}`,
      label: formatRowLabel(entry.toolName, entry.provider, entry.estimated),
      toolName: entry.toolName,
      provider: entry.provider,
      callCount: entry.callCount,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.inputTokens + entry.outputTokens,
      estimated: entry.estimated
    }))
    .sort((left, right) => (
      right.totalTokens - left.totalTokens
      || right.callCount - left.callCount
      || left.label.localeCompare(right.label)
    ));

  const visibleRows = rows.slice(0, TOP_TOOL_LIMIT);
  const hiddenRows = rows.slice(TOP_TOOL_LIMIT);

  if (hiddenRows.length > 0) {
    const provider = resolveHiddenProvider(hiddenRows);
    const estimated = provider === "codex" && hiddenRows.some((row) => row.estimated);
    visibleRows.push({
      key: `${provider}:other`,
      label: formatRowLabel("기타", provider, estimated),
      toolName: "기타",
      provider,
      callCount: hiddenRows.reduce((sum, row) => sum + row.callCount, 0),
      inputTokens: hiddenRows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: hiddenRows.reduce((sum, row) => sum + row.outputTokens, 0),
      totalTokens: hiddenRows.reduce((sum, row) => sum + row.totalTokens, 0),
      estimated,
      hiddenCount: hiddenRows.length
    });
  }

  return visibleRows;
}

function ToolAttributionTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Total {formatNumber(point.totalTokens)}</p>
      <p>Input {formatNumber(point.inputTokens)}</p>
      <p>Output {formatNumber(point.outputTokens)}</p>
      <p>Calls {formatNumber(point.callCount)}</p>
      {point.estimated ? <p>추정 (±10%)</p> : null}
      {point.hiddenCount ? <p>{formatNumber(point.hiddenCount)} hidden tools</p> : null}
    </div>
  );
}

function resolveHiddenProvider(rows: ToolAttributionRow[]): AttributionProviderLabel {
  const firstProvider = rows[0]?.provider;
  return firstProvider && rows.every((row) => row.provider === firstProvider) ? firstProvider : "mixed";
}

function formatRowLabel(toolName: string, provider: AttributionProviderLabel, estimated: boolean): string {
  const prefix = provider === "codex" && estimated ? "~ " : "";
  return `${prefix}${toolName} (${formatProviderLabel(provider)})`;
}

function formatProviderLabel(provider: AttributionProviderLabel): string {
  if (provider === "claude_code") {
    return "Claude Code";
  }

  if (provider === "codex") {
    return "Codex";
  }

  return "Mixed";
}

function formatProviderFilterLabel(provider: TokenAttributionProvider): string {
  if (provider === "all") {
    return "전체";
  }

  return formatProviderLabel(provider);
}

function getInputColor(provider: AttributionProviderLabel): string {
  if (provider === "claude_code") {
    return "var(--tool-token-input-claude)";
  }

  if (provider === "codex") {
    return "var(--tool-token-input-codex)";
  }

  return "rgba(124, 95, 203, 0.28)";
}

function getOutputColor(provider: AttributionProviderLabel): string {
  if (provider === "claude_code") {
    return "var(--tool-token-output-claude)";
  }

  if (provider === "codex") {
    return "var(--tool-token-output-codex)";
  }

  return "var(--accent)";
}

function getLegendSwatchClass(provider: TokenAttributionProvider): string {
  if (provider === "claude_code") {
    return "provider-claude-code";
  }

  if (provider === "codex") {
    return "provider-codex";
  }

  return "provider-all";
}

function formatChartNumber(value: unknown): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(value);
}
