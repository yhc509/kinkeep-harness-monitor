import type { ModelTokenUsageItem } from "@codex-monitor/shared";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber } from "../utils/format";
import { inferModelTheme, type ProviderId } from "../utils/providerTheme";

const CHART_PALETTES: Record<ProviderId | "neutral", string[]> = {
  codex: [
    "var(--provider-codex)",
    "#7ce3ff",
    "var(--provider-codex-soft)",
    "#7aa2ff"
  ],
  "claude-code": [
    "var(--provider-claude)",
    "#ffd08c",
    "var(--provider-claude-soft)",
    "#ff914d"
  ],
  neutral: [
    "#8b949e",
    "#6e7681",
    "rgba(255, 255, 255, 0.22)"
  ]
};

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

  const paletteIndexes: Record<ProviderId | "neutral", number> = {
    codex: 0,
    "claude-code": 0,
    neutral: 0
  };

  const chartData = data.map((item) => {
    const theme = inferModelTheme(item);
    const palette = CHART_PALETTES[theme];
    const color = palette[paletteIndexes[theme] % palette.length];
    paletteIndexes[theme] += 1;

    return {
      ...item,
      color,
      theme,
      label: formatModelLabel(item),
      share: item.totalTokens / totalTokens
    };
  });

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
          <div
            key={`${item.modelProvider ?? "none"}:${item.modelName}`}
            className={item.theme === "neutral" ? "model-usage-row" : `model-usage-row ${item.theme}`}
          >
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
