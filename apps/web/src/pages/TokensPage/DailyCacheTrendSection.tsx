import { useEffect, useMemo, useState } from "react";
import {
  cacheBreaksResponseSchema,
  cacheTrendResponseSchema,
  type CacheBreaksResponse,
  type CacheTrendResponse,
  type DailyCacheTrendPoint,
  type Provider
} from "@codex-monitor/shared";
import { CalendarDays } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AsyncPane } from "../../components/AsyncPane";
import { Panel } from "../../components/Panel";
import { useApiResource } from "../../hooks/useApiResource";
import { formatDay, formatNumber, formatPercent } from "../../utils/format";
import { CacheBreakSidePanel } from "./CacheBreakSidePanel";

type CacheTrendRange = "7d" | "30d";
type CacheTrendProvider = "all" | Provider;

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: DailyCacheTrendPoint;
  }>;
}

interface CacheBreakDotProps {
  cx?: number;
  cy?: number;
  payload?: DailyCacheTrendPoint;
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}

const ranges: Array<{ value: CacheTrendRange; label: string }> = [
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" }
];

const providers: Array<{ value: CacheTrendProvider; label: string }> = [
  { value: "all", label: "전체" },
  { value: "claude_code", label: "Claude" },
  { value: "codex", label: "Codex" }
];

export function DailyCacheTrendSection() {
  const [range, setRange] = useState<CacheTrendRange>("7d");
  const [provider, setProvider] = useState<CacheTrendProvider>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const trend = useApiResource(() => getCacheTrend(range, provider), {
    deps: [range, provider],
    cacheKey: `tokens:cache-trend:${range}:${provider}`,
    staleTimeMs: 300_000
  });
  const breaks = useApiResource(() => getCacheBreaks(range, provider), {
    deps: [range, provider],
    cacheKey: `tokens:cache-breaks:${range}:${provider}`,
    staleTimeMs: 300_000
  });
  const points = trend.data?.points ?? [];
  const events = breaks.data?.events ?? [];
  const hasPartialAnalysis = points.some((point) => point.breakAvailability === "partial");
  const hasUnavailableAnalysis = points.some((point) => point.breakAvailability === "none");
  const selectedPoint = useMemo(
    () => points.find((point) => point.date === selectedDate) ?? null,
    [points, selectedDate]
  );

  useEffect(() => {
    setSelectedDate(null);
  }, [range, provider]);

  return (
    <Panel
      title="캐시 히트율 추이 (일별)"
      subtitle={`${range === "7d" ? "7일" : "30일"} cache view`}
      icon={<CalendarDays size={16} strokeWidth={2.2} />}
      actions={(
        <>
          <div className="segmented" aria-label="기간">
            {ranges.map((item) => (
              <button
                key={item.value}
                className={item.value === range ? "segment active" : "segment"}
                onClick={() => setRange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="segmented" aria-label="provider">
            {providers.map((item) => (
              <button
                key={item.value}
                className={item.value === provider ? "segment active" : "segment"}
                onClick={() => setProvider(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    >
      <AsyncPane
        loading={trend.initialLoading || breaks.initialLoading}
        error={trend.error ?? breaks.error}
        hasData={trend.hasData && breaks.hasData}
      >
        <div className="cache-trend-layout">
          <div className="cache-trend-chart-block">
            {selectedPoint ? (
              <div className="cache-trend-selection">
                <strong>{selectedPoint.date}</strong>
                <span>{formatPercent(selectedPoint.hitRate)} · {formatNumber(selectedPoint.breakCount)} break</span>
              </div>
            ) : null}
            <div className="usage-chart-scroll">
              <div className="cache-trend-canvas">
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={points} margin={{ top: 18, right: 14, bottom: 0, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDay}
                      stroke="rgba(255,255,255,0.42)"
                      axisLine={false}
                      tickLine={false}
                      minTickGap={18}
                    />
                    <YAxis
                      width={64}
                      domain={[0, 1]}
                      tickFormatter={formatPercent}
                      stroke="rgba(255,255,255,0.42)"
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<CacheTrendTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="hitRate"
                      name="Hit rate"
                      stroke="var(--provider-agents)"
                      strokeWidth={2.5}
                      dot={<CacheBreakDot selectedDate={selectedDate} onSelectDate={setSelectedDate} />}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            {hasUnavailableAnalysis ? (
              <p className="cache-trend-note">stats-cache 출처 데이터는 turn-level 진단 불가</p>
            ) : null}
            {hasPartialAnalysis ? (
              <p className="cache-trend-note">일부 일자는 stats-cache 출처 데이터로 부분 진단</p>
            ) : null}
          </div>

          <CacheBreakSidePanel
            events={events}
            selectedDate={selectedDate}
            onClearFilter={() => setSelectedDate(null)}
          />
        </div>
      </AsyncPane>
    </Panel>
  );
}

function CacheTrendTooltip({ active, payload }: ChartTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{point.date}</strong>
      <p>Hit rate {formatPercent(point.hitRate)}</p>
      <p>Breaks {formatNumber(point.breakCount)}</p>
      <p>Input {formatNumber(point.totalInputTokens)}</p>
      {point.breakAvailability === "partial" ? <p>부분 진단 (stats-cache 일부 포함)</p> : null}
      {point.breakAvailability === "none" ? <p>Turn-level 진단 불가</p> : null}
    </div>
  );
}

function CacheBreakDot({ cx, cy, payload, selectedDate, onSelectDate }: CacheBreakDotProps) {
  if (cx == null || cy == null || !payload) {
    return null;
  }

  if (payload.breakAvailability === "none") {
    return (
      <g className="cache-break-marker unavailable" aria-label={`${payload.date} turn-level 진단 불가`}>
        <title>turn-level 진단 불가</title>
        <circle cx={cx} cy={cy} r={5} />
        <circle cx={cx} cy={cy} r={2} />
      </g>
    );
  }

  if (payload.breakAvailability === "partial") {
    const selected = selectedDate === payload.date;

    if (payload.breakCount === 0) {
      return (
        <g
          className={selected ? "cache-break-marker partial selected" : "cache-break-marker partial"}
          aria-label={`${payload.date} 부분 진단`}
        >
          <title>부분 진단 (stats-cache 일부 포함)</title>
          <circle cx={cx} cy={cy} r={selected ? 7 : 6} />
          <text x={cx} y={cy + 3} textAnchor="middle">!</text>
        </g>
      );
    }

    return (
      <g
        className={selected ? "cache-break-marker partial selected" : "cache-break-marker partial"}
        role="button"
        tabIndex={0}
        aria-label={`${payload.date} 부분 진단 캐시 깨짐 ${payload.breakCount}건`}
        onClick={() => onSelectDate(payload.date)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectDate(payload.date);
          }
        }}
      >
        <title>부분 진단 (stats-cache 일부 포함)</title>
        <circle cx={cx} cy={cy} r={selected ? 7 : 6} />
        <text x={cx} y={cy + 3} textAnchor="middle">!</text>
      </g>
    );
  }

  if (payload.breakCount === 0) {
    return null;
  }

  const selected = selectedDate === payload.date;

  return (
    <g
      className={selected ? "cache-break-marker selected" : "cache-break-marker"}
      role="button"
      tabIndex={0}
      aria-label={`${payload.date} 캐시 깨짐 ${payload.breakCount}건`}
      onClick={() => onSelectDate(payload.date)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectDate(payload.date);
        }
      }}
    >
      <circle cx={cx} cy={cy} r={selected ? 7 : 6} />
      <circle cx={cx} cy={cy} r={selected ? 3 : 2.5} />
    </g>
  );
}

async function getCacheTrend(range: CacheTrendRange, provider: CacheTrendProvider): Promise<CacheTrendResponse> {
  const search = new URLSearchParams({ range, provider });
  const response = await fetch(`/api/tokens/cache-trend?${search.toString()}`);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return cacheTrendResponseSchema.parse(await response.json());
}

async function getCacheBreaks(range: CacheTrendRange, provider: CacheTrendProvider): Promise<CacheBreaksResponse> {
  const search = new URLSearchParams({ range, provider });
  const response = await fetch(`/api/tokens/cache-breaks?${search.toString()}`);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return cacheBreaksResponseSchema.parse(await response.json());
}
