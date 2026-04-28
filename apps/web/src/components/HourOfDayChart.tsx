import type { TokenPatterns } from "@codex-monitor/shared";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber } from "../utils/format";

type HourOfDayAverage = TokenPatterns["hourOfDayAverages"][number];

interface HourOfDayChartProps {
  data: HourOfDayAverage[];
}

interface ChartPoint {
  hour: number;
  label: string;
  avgTokens: number | null;
  avgRequests: number | null;
  sampleDays: number;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ChartPoint;
  }>;
}

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1
});

export function HourOfDayChart({ data }: HourOfDayChartProps) {
  if (data.length === 0) {
    return <UsagePatternEmpty />;
  }

  const chartData = fillHours(data);

  return (
    <div className="usage-chart-block">
      <div className="usage-chart-header">
        <h3>시간대 평균</h3>
        <span>토큰 · 요청</span>
      </div>
      <div className="usage-chart-scroll">
        <div className="usage-chart-canvas">
          <ResponsiveContainer width="100%" height={270}>
            <LineChart data={chartData} margin={{ top: 14, right: 8, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} minTickGap={18} />
              <YAxis
                yAxisId="tokens"
                width={112}
                tickMargin={8}
                allowDecimals={false}
                tickFormatter={formatChartNumber}
                stroke="rgba(255,255,255,0.42)"
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="requests"
                orientation="right"
                width={56}
                tickMargin={8}
                tickFormatter={formatAverage}
                stroke="rgba(255,255,255,0.36)"
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<HourOfDayTooltip />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12 }}
                formatter={(value) => <span style={{ color: "rgba(255,255,255,0.72)" }}>{value}</span>}
              />
              <Line
                yAxisId="tokens"
                type="monotone"
                dataKey="avgTokens"
                name="Avg tokens"
                stroke="var(--accent)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                yAxisId="requests"
                type="monotone"
                dataKey="avgRequests"
                name="Avg requests"
                stroke="var(--provider-codex)"
                strokeWidth={2}
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

function HourOfDayTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.sampleDays === 0) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Avg tokens {formatAverage(point.avgTokens)}</p>
      <p>Avg requests {formatAverage(point.avgRequests)}</p>
      <p>Sample days {formatNumber(point.sampleDays)}</p>
    </div>
  );
}

function fillHours(data: HourOfDayAverage[]): ChartPoint[] {
  const byHour = new Map(data.map((entry) => [entry.hour, entry]));

  return hours.map((hour) => {
    const entry = byHour.get(hour);

    return {
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      avgTokens: entry?.avgTokens ?? null,
      avgRequests: entry?.avgRequests ?? null,
      sampleDays: entry?.sampleDays ?? 0
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

function formatAverage(value: number | null): string {
  return value == null ? "-" : compactNumberFormatter.format(value);
}

function formatChartNumber(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(value);
}
