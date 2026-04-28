import type { TokenPatterns } from "@codex-monitor/shared";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber, formatPercent } from "../utils/format";

type HourlyCacheHit = TokenPatterns["hourOfDayCacheHit"][number];

interface HourlyCacheHitChartProps {
  data: HourlyCacheHit[];
}

interface ChartPoint {
  hour: number;
  label: string;
  hitRate: number | null;
  sampleRequests: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ChartPoint;
  }>;
}

const hours = Array.from({ length: 24 }, (_, hour) => hour);

export function HourlyCacheHitChart({ data }: HourlyCacheHitChartProps) {
  if (data.length === 0) {
    return <UsagePatternEmpty />;
  }

  const chartData = fillHours(data);

  return (
    <div className="usage-chart-block">
      <div className="usage-chart-header">
        <h3>캐시 히트율</h3>
        <span>시간대별</span>
      </div>
      <div className="usage-chart-scroll">
        <div className="usage-chart-canvas">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData} margin={{ top: 14, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} minTickGap={18} />
              <YAxis
                width={64}
                domain={[0, 1]}
                tickFormatter={formatPercent}
                stroke="rgba(255,255,255,0.42)"
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CacheHitTooltip />} />
              <Line
                type="monotone"
                dataKey="hitRate"
                name="Hit rate"
                stroke="var(--provider-agents)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function CacheHitTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.sampleRequests === 0 || point.hitRate == null) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Hit rate {formatPercent(point.hitRate)}</p>
      <p>Requests {formatNumber(point.sampleRequests)}</p>
    </div>
  );
}

function fillHours(data: HourlyCacheHit[]): ChartPoint[] {
  const byHour = new Map(data.map((entry) => [entry.hour, entry]));

  return hours.map((hour) => {
    const entry = byHour.get(hour);

    return {
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      hitRate: entry?.hitRate ?? null,
      sampleRequests: entry?.sampleRequests ?? 0
    };
  });
}

function UsagePatternEmpty() {
  return (
    <div className="usage-pattern-empty">
      <strong>데이터 없음</strong>
    </div>
  );
}
