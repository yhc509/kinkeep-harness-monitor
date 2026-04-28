import type { TokenPatterns } from "@codex-monitor/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber } from "../utils/format";

type SessionDuration = TokenPatterns["sessionDuration"];

interface SessionDurationChartProps {
  data: SessionDuration;
}

interface StartPoint {
  hour: number;
  label: string;
  count: number;
}

interface DurationPoint {
  bucketMin: number;
  bucketMax: number;
  label: string;
  count: number;
}

interface TooltipProps<T> {
  active?: boolean;
  payload?: Array<{
    payload: T;
  }>;
}

const hours = Array.from({ length: 24 }, (_, hour) => hour);

export function SessionDurationChart({ data }: SessionDurationChartProps) {
  if (data.startHistogram.length === 0 && data.durationBuckets.length === 0) {
    return <UsagePatternEmpty />;
  }

  const startData = fillStartHours(data.startHistogram);
  const durationData = data.durationBuckets.map((bucket) => ({
    ...bucket,
    label: formatDurationBucket(bucket.bucketMin, bucket.bucketMax)
  }));

  return (
    <div className="usage-chart-block">
      <div className="usage-chart-header">
        <h3>세션 분포</h3>
        <span>시작 · 지속시간</span>
      </div>
      <div className="session-duration-grid">
        <div className="usage-chart-scroll">
          <div className="usage-chart-canvas">
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={startData} margin={{ top: 10, right: 8, bottom: 0, left: 4 }} barCategoryGap="24%">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} minTickGap={18} />
                <YAxis
                  width={52}
                  allowDecimals={false}
                  tickFormatter={formatChartNumber}
                  stroke="rgba(255,255,255,0.42)"
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<StartTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="count" name="Starts" fill="var(--provider-codex)" radius={[6, 6, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="usage-chart-scroll">
          <div className="usage-chart-canvas compact-canvas">
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={durationData} margin={{ top: 10, right: 8, bottom: 0, left: 4 }} barCategoryGap="24%">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} minTickGap={10} />
                <YAxis
                  width={52}
                  allowDecimals={false}
                  tickFormatter={formatChartNumber}
                  stroke="rgba(255,255,255,0.42)"
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<DurationTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="count" name="Sessions" fill="var(--provider-claude)" radius={[6, 6, 0, 0]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function StartTooltip({ active, payload }: TooltipProps<StartPoint>) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.count === 0) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Starts {formatNumber(point.count)}</p>
    </div>
  );
}

function DurationTooltip({ active, payload }: TooltipProps<DurationPoint>) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.label}</strong>
      <p>Sessions {formatNumber(point.count)}</p>
    </div>
  );
}

function fillStartHours(data: SessionDuration["startHistogram"]): StartPoint[] {
  const byHour = new Map(data.map((entry) => [entry.hour, entry]));

  return hours.map((hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    count: byHour.get(hour)?.count ?? 0
  }));
}

function formatDurationBucket(bucketMin: number, bucketMax: number): string {
  if (bucketMax >= 525600) {
    return "7d+";
  }

  if (bucketMin === 0) {
    return `<${formatDurationValue(bucketMax)}`;
  }

  return `${formatDurationValue(bucketMin)}-${formatDurationValue(bucketMax)}`;
}

function formatDurationValue(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 1440) {
    return `${Math.round(minutes / 60)}h`;
  }

  return `${Math.round(minutes / 1440)}d`;
}

function UsagePatternEmpty() {
  return (
    <div className="usage-pattern-empty">
      <strong>데이터 없음</strong>
    </div>
  );
}

function formatChartNumber(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(value);
}
