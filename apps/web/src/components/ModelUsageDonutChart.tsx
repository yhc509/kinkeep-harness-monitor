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
        <strong>모델 사용 기록 없음</strong>
        <p>선택한 기간에 토큰이 기록되면 여기서 모델 비율을 볼 수 있습니다.</p>
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
          <span>총 토큰</span>
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
                {item.modelProvider && item.modelName !== "기타" ? <span>{item.modelProvider}</span> : null}
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
      {item.modelProvider && item.modelName !== "기타" ? <span>{item.modelProvider}</span> : null}
      <p>토큰 {formatNumber(item.totalTokens)}</p>
      <p>점유율 {formatPercent(item.share)}</p>
    </div>
  );
}

function formatModelLabel(item: ModelTokenUsageItem): string {
  if (item.modelName === "기타") {
    return item.modelName;
  }

  if (item.modelName === "모델 미상" && item.modelProvider) {
    return `${item.modelProvider} · ${item.modelName}`;
  }

  return item.modelName;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}
