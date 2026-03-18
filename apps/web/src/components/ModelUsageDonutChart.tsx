import type { ModelTokenUsageItem } from "@codex-monitor/shared";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber } from "../utils/format";

const CHART_COLORS = [
  "#54d2ff",
  "#ffb454",
  "#43d392",
  "#7ae582",
  "#7aa2ff",
  "#ff7b72",
  "#8b949e"
];

interface ModelUsageDonutChartProps {
  data: ModelTokenUsageItem[];
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ModelTokenUsageItem & {
      share: number;
      label: string;
    };
  }>;
}

export function ModelUsageDonutChart({ data }: ModelUsageDonutChartProps) {
  const totalTokens = data.reduce((sum, item) => sum + item.totalTokens, 0);

  if (totalTokens <= 0) {
    return (
      <div className="model-usage-empty">
        <strong>No model usage recorded</strong>
        <p>Model share will appear here once tokens are recorded for the selected range.</p>
      </div>
    );
  }

  const chartData = data.map((item, index) => ({
    ...item,
    color: CHART_COLORS[index % CHART_COLORS.length],
    label: formatModelLabel(item),
    share: item.totalTokens / totalTokens
  }));

  return (
    <div className="model-usage-layout">
      <div className="model-usage-chart">
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="totalTokens"
              nameKey="label"
              innerRadius={74}
              outerRadius={112}
              paddingAngle={2}
              stroke="rgba(6, 9, 13, 0.6)"
              strokeWidth={3}
            >
              {chartData.map((item) => (
                <Cell key={`${item.modelProvider ?? "none"}:${item.modelName}`} fill={item.color} />
              ))}
            </Pie>
            <Tooltip content={<ModelUsageTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="model-usage-center">
          <span>Total tokens</span>
          <strong>{formatNumber(totalTokens)}</strong>
        </div>
      </div>

      <div className="model-usage-legend">
        {chartData.map((item) => (
          <div key={`${item.modelProvider ?? "none"}:${item.modelName}`} className="model-usage-row">
            <div className="model-usage-main">
              <span className="model-usage-swatch" style={{ backgroundColor: item.color }} />
              <div className="model-usage-copy">
                <strong>{item.label}</strong>
                {item.modelProvider && item.modelName !== "Other" ? <span>{item.modelProvider}</span> : null}
              </div>
            </div>
            <div className="model-usage-value">
              <strong>{formatNumber(item.totalTokens)}</strong>
              <span>{formatPercent(item.share)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelUsageTooltip({ active, payload }: TooltipProps) {
  const item = payload?.[0]?.payload;
  if (!active || !item) {
    return null;
  }

  return (
    <div className="model-usage-tooltip">
      <strong>{item.label}</strong>
      {item.modelProvider && item.modelName !== "Other" ? <span>{item.modelProvider}</span> : null}
      <p>Tokens {formatNumber(item.totalTokens)}</p>
      <p>Share {formatPercent(item.share)}</p>
    </div>
  );
}

function formatModelLabel(item: ModelTokenUsageItem): string {
  if (item.modelName === "Other") {
    return item.modelName;
  }

  if (item.modelName === "Unknown Model" && item.modelProvider) {
    return `${item.modelProvider} · ${item.modelName}`;
  }

  return item.modelName;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}
