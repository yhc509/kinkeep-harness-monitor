import { useMemo, useState } from "react";
import type { ToolUsageEntry } from "@codex-monitor/shared";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber } from "../utils/format";

type ToolUsageMode = ToolUsageEntry["provider"] | "total";

interface ToolUsageChartProps {
  data: ToolUsageEntry[];
}

interface ToolUsageChartRow {
  key: string;
  label: string;
  provider: ToolUsageEntry["provider"] | "mixed";
  toolName: string;
  callCount: number;
  color: string;
  hiddenCount?: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ToolUsageChartRow;
  }>;
}

const modeOptions: Array<{ value: ToolUsageMode; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "total", label: "합계" }
];

const TOP_TOOL_LIMIT = 15;

export function ToolUsageChart({ data }: ToolUsageChartProps) {
  const defaultMode = useMemo(() => resolveDefaultMode(data), [data]);
  const [selectedMode, setSelectedMode] = useState<ToolUsageMode | null>(null);
  const mode = selectedMode ?? defaultMode;
  const chartData = useMemo(() => buildChartRows(data, mode), [data, mode]);
  const chartHeight = Math.max(240, chartData.length * 34 + 46);

  return (
    <div className="tool-usage">
      <div className="tool-usage-toolbar">
        <div className="segmented" aria-label="Tool usage provider">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === mode ? "segment active" : "segment"}
              aria-pressed={option.value === mode}
              onClick={() => setSelectedMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="tool-usage-hint">
        Codex는 명령 단위가 아니라 파이프 segment 단위로 카운트합니다 (예: <code>nl | sed</code>는 nl과 sed 각각 +1).
      </p>

      {chartData.length > 0 ? (
        <div className="tool-usage-scroll">
          <div className="tool-usage-canvas">
            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 78, bottom: 8, left: 8 }}
                barCategoryGap="20%"
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
                  width={220}
                  tick={{ fill: "rgba(255,255,255,0.72)", fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={<ToolUsageTooltip />} />
                <Bar dataKey="callCount" name="Calls" radius={[0, 7, 7, 0]} maxBarSize={22}>
                  {chartData.map((entry) => (
                    <Cell key={entry.key} fill={entry.color} />
                  ))}
                  <LabelList
                    dataKey="callCount"
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
          <strong>아직 데이터가 없어요</strong>
        </div>
      )}
    </div>
  );
}

function buildChartRows(data: ToolUsageEntry[], mode: ToolUsageMode): ToolUsageChartRow[] {
  const rows: ToolUsageChartRow[] = data
    .filter((entry) => mode === "total" || entry.provider === mode)
    .map((entry) => ({
      key: `${entry.provider}:${entry.toolName}`,
      label: formatToolLabel(entry, mode),
      provider: entry.provider,
      toolName: entry.toolName,
      callCount: entry.callCount,
      color: getToolColor(entry)
    }))
    .sort((left, right) => right.callCount - left.callCount || left.label.localeCompare(right.label));

  const visibleRows = rows.slice(0, TOP_TOOL_LIMIT);
  const hiddenRows = rows.slice(TOP_TOOL_LIMIT);

  if (hiddenRows.length > 0) {
    const otherProvider = resolveOtherProvider(hiddenRows);
    visibleRows.push({
      key: `${otherProvider}:other`,
      label: `기타 ${hiddenRows.length}개`,
      provider: otherProvider,
      toolName: "Other",
      callCount: hiddenRows.reduce((sum, entry) => sum + entry.callCount, 0),
      color: resolveOtherColor(hiddenRows),
      hiddenCount: hiddenRows.length
    });
  }

  return visibleRows;
}

function resolveDefaultMode(data: ToolUsageEntry[]): ToolUsageMode {
  if (data.some((entry) => entry.provider === "claude-code" && entry.callCount > 0)) {
    return "claude-code";
  }

  if (data.some((entry) => entry.provider === "codex" && entry.callCount > 0)) {
    return "codex";
  }

  return "claude-code";
}

function formatToolLabel(entry: ToolUsageEntry, mode: ToolUsageMode): string {
  if (mode !== "total") {
    return entry.toolName;
  }

  if (entry.toolName.startsWith("mcp:")) {
    return entry.toolName;
  }

  return entry.provider === "claude-code"
    ? `cc:${entry.toolName}`
    : `cdx:${entry.toolName}`;
}

function getToolColor(entry: Pick<ToolUsageEntry, "provider" | "toolName">): string {
  if (entry.toolName.startsWith("mcp:")) {
    return "var(--provider-agents)";
  }

  return entry.provider === "claude-code"
    ? "var(--provider-claude)"
    : "var(--provider-codex)";
}

function resolveOtherProvider(rows: ToolUsageChartRow[]): ToolUsageChartRow["provider"] {
  const firstProvider = rows[0]?.provider;
  return firstProvider && rows.every((row) => row.provider === firstProvider) ? firstProvider : "mixed";
}

function resolveOtherColor(rows: ToolUsageChartRow[]): string {
  const firstColor = rows[0]?.color;
  return firstColor && rows.every((row) => row.color === firstColor) ? firstColor : "var(--accent-soft)";
}

function ToolUsageTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Calls {formatNumber(point.callCount)}</p>
      {point.hiddenCount ? <p>{formatNumber(point.hiddenCount)} hidden tools</p> : null}
    </div>
  );
}

function formatChartNumber(value: unknown): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(value);
}
