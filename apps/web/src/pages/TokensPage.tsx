import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarDays, Clock3, Flame, RefreshCw } from "lucide-react";
import { apiResourceKeys, createSnapshot, getTokens } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { StatStrip } from "../components/StatStrip";
import { StatusPill } from "../components/StatusPill";
import { TokenMetricToggle } from "../components/TokenMetricToggle";
import { invalidateApiResource, useApiResource } from "../hooks/useApiResource";
import { extendHourlyTokenMetric, readDailyInputMetric, readDailyTokenMetric, useTokenMetricMode } from "../hooks/useTokenMetricMode";
import { formatDateTime, formatDay, formatHour, formatNumber } from "../utils/format";

const ranges = [7, 30, 90];

function formatChartValue(value: number | string | readonly (number | string)[] | undefined | null): string {
  if (value == null) {
    return "-";
  }

  const resolvedValue = Array.isArray(value) ? value[0] : value;
  const numericValue = typeof resolvedValue === "number" ? resolvedValue : Number(resolvedValue);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(resolvedValue);
}

export function TokensPage() {
  const [range, setRange] = useState(7);
  const [syncBusy, setSyncBusy] = useState(false);
  const tokenMode = useTokenMetricMode();
  const tokens = useApiResource(() => getTokens(range), {
    deps: [range],
    cacheKey: apiResourceKeys.tokens(range),
    staleTimeMs: 5_000
  });
  const hourlySeries = tokens.data?.hourly.map(extendHourlyTokenMetric) ?? [];
  const dailySeries = tokens.data?.daily.map((entry) => ({
    ...entry,
    inputMetric: readDailyInputMetric(entry, tokenMode.mode),
    outputMetric: entry.outputTokens
  })) ?? [];

  async function handleSync() {
    try {
      setSyncBusy(true);
      await createSnapshot();
      invalidateApiResource(apiResourceKeys.overview);
      tokens.refresh();
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">TOKENS</p>
          <h2>일별 사용량</h2>
        </div>
        <div className="inline-actions">
          {tokens.data ? (
            <div className="page-chip">
              <Clock3 size={14} strokeWidth={2.2} />
              <span>{formatDateTime(tokens.data.lastSyncedAt)}</span>
            </div>
          ) : null}
          {tokens.refreshing ? (
            <div className="page-chip loading-chip">
              <RefreshCw size={14} strokeWidth={2.2} />
              <span>새로고침</span>
            </div>
          ) : null}
          <div className="segmented">
            {ranges.map((item) => (
              <button
                key={item}
                className={item === range ? "segment active" : "segment"}
                onClick={() => setRange(item)}
              >
                {item}일
              </button>
            ))}
          </div>
          <TokenMetricToggle mode={tokenMode.mode} onChange={tokenMode.setMode} />
          <button className="primary-button" disabled={syncBusy} onClick={handleSync}>
            <RefreshCw size={14} strokeWidth={2.2} />
            {syncBusy ? "동기화 중" : "지금 동기화"}
          </button>
        </div>
      </section>

      <AsyncPane loading={tokens.initialLoading} error={tokens.error} hasData={tokens.hasData}>
        {tokens.data ? (
          <>
            <StatStrip
              items={[
                {
                  label: "오늘 토큰",
                  value: formatNumber(tokens.data.daily.at(-1) ? readDailyTokenMetric(tokens.data.daily.at(-1)!, tokenMode.mode) : 0),
                  meta: tokenMode.label,
                  accent: "cool",
                  icon: Flame
                },
                {
                  label: "7일 평균",
                  value: formatNumber(
                    Math.round(
                      tokens.data.daily.reduce((sum, point) => sum + readDailyTokenMetric(point, tokenMode.mode), 0)
                      / Math.max(tokens.data.daily.length, 1)
                    )
                  ),
                  meta: tokenMode.label,
                  icon: CalendarDays
                }
              ]}
            />

            <Panel
              title="입력 / 출력"
              subtitle={tokenMode.mode === "total" ? "좌측 입력 · 우측 출력 · 입력은 캐시 포함" : "좌측 입력 · 우측 출력 · 입력은 캐시 제외"}
              icon={<Flame size={16} strokeWidth={2.2} />}
              actions={(
                <div className="panel-badges">
                  <span className="panel-badge">
                    <Clock3 size={13} strokeWidth={2.2} />
                    입력 {formatNumber(dailySeries.at(-1)?.inputMetric ?? 0)}
                  </span>
                  <span className="panel-badge muted-badge">
                    출력 {formatNumber(dailySeries.at(-1)?.outputMetric ?? 0)}
                  </span>
                </div>
              )}
            >
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={340}>
                  <LineChart data={dailySeries} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={formatDay} stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} />
                    <YAxis
                      yAxisId="input"
                      width={104}
                      tickMargin={8}
                      allowDecimals={false}
                      tickFormatter={formatChartValue}
                      stroke="var(--accent)"
                      tick={{ fill: "var(--accent)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="output"
                      orientation="right"
                      width={92}
                      tickMargin={8}
                      allowDecimals={false}
                      tickFormatter={formatChartValue}
                      stroke="var(--accent-warm)"
                      tick={{ fill: "var(--accent-warm)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      formatter={(value, name) => [formatChartValue(value), String(name)]}
                    />
                    <Line
                      type="monotone"
                      dataKey="inputMetric"
                      yAxisId="input"
                      name={tokenMode.mode === "total" ? "입력" : "입력 · 캐시 제외"}
                      stroke="var(--accent)"
                      strokeWidth={2.8}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="outputMetric"
                      yAxisId="output"
                      name="출력"
                      stroke="var(--accent-warm)"
                      strokeWidth={2.4}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <div className="fold-list">
              <details className="fold-panel">
                <summary className="fold-summary">
                  <div className="fold-summary-main">
                    <Clock3 size={15} strokeWidth={2.2} />
                    <strong>최근 48시간</strong>
                  </div>
                  <span>시간별 합계</span>
                </summary>
                <div className="fold-content">
                <div className="chart-wrap compact">
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={hourlySeries} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                      <XAxis dataKey="hourBucket" tickFormatter={formatHour} stroke="rgba(255,255,255,0.4)" axisLine={false} tickLine={false} minTickGap={24} />
                      <YAxis
                        width={104}
                        tickMargin={8}
                        allowDecimals={false}
                        tickFormatter={formatChartValue}
                        stroke="rgba(255,255,255,0.4)"
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        cursor={{ fill: "rgba(255,255,255,0.04)" }}
                        formatter={(value, name) => [formatChartValue(value), String(name)]}
                      />
                      <Line
                        type="monotone"
                        dataKey={tokenMode.dataKey}
                        name={tokenMode.label}
                        stroke="var(--accent-soft)"
                        strokeWidth={2.4}
                        dot={false}
                        activeDot={{ r: 3 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="snapshot-list compact">
                  {hourlySeries.slice(-8).reverse().map((entry) => (
                    <article key={entry.hourBucket} className="snapshot-row">
                      <div>
                        <strong>{formatDateTime(entry.hourBucket)}</strong>
                        <p>{entry.requestCount} requests</p>
                      </div>
                      <span>{formatNumber(tokenMode.mode === "total" ? entry.totalTokens : entry.uncachedTokens)}</span>
                    </article>
                    ))}
                  </div>
                </div>
              </details>

              <details className="fold-panel">
                <summary className="fold-summary">
                  <div className="fold-summary-main">
                    <RefreshCw size={15} strokeWidth={2.2} />
                    <strong>동기화 로그</strong>
                  </div>
                  <span>최근 20건</span>
                </summary>
                <div className="fold-content">
                <div className="run-list">
                  {tokens.data.collectorRuns.map((run) => (
                    <article key={run.id} className="run-row">
                      <div>
                        <div className="run-meta">
                          <StatusPill status={run.status} />
                          <span>{formatDateTime(run.finishedAt)}</span>
                        </div>
                        <p>{run.message}</p>
                      </div>
                    </article>
                  ))}
                </div>
                </div>
              </details>
            </div>
          </>
        ) : null}
      </AsyncPane>
    </div>
  );
}
