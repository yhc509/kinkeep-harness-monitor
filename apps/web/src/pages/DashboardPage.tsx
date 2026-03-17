import { Activity, Clock3, Flame } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiResourceKeys, getOverview } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { StatStrip } from "../components/StatStrip";
import { StatusPill } from "../components/StatusPill";
import { TokenMetricToggle } from "../components/TokenMetricToggle";
import { useApiResource } from "../hooks/useApiResource";
import { readTokenMetric, useTokenMetricMode } from "../hooks/useTokenMetricMode";
import { formatDateTime, formatDay, formatNumber } from "../utils/format";

function formatChartValue(value: number | string | readonly (number | string)[] | undefined | null): string {
  if (value == null) {
    return "-";
  }

  const resolvedValue = Array.isArray(value) ? value[0] : value;
  const numericValue = typeof resolvedValue === "number" ? resolvedValue : Number(resolvedValue);
  return Number.isFinite(numericValue) ? formatNumber(numericValue) : String(resolvedValue);
}

export function DashboardPage() {
  const overview = useApiResource(() => getOverview(), {
    deps: [],
    cacheKey: apiResourceKeys.overview,
    staleTimeMs: 10_000
  });
  const tokenMode = useTokenMetricMode();

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h2>오늘 토큰 우선</h2>
        </div>
        {overview.data ? (
          <div className="page-chip-group">
            <div className="page-chip">
              <Clock3 size={14} strokeWidth={2.2} />
              <span>{formatDateTime(overview.data.lastSyncedAt ?? overview.data.collector?.finishedAt ?? null)}</span>
            </div>
            {overview.refreshing ? (
              <div className="page-chip loading-chip">
                <Activity size={14} strokeWidth={2.2} />
                <span>새로고침</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <AsyncPane loading={overview.initialLoading} error={overview.error} hasData={overview.hasData}>
        {overview.data ? (
          <>
            <StatStrip
              items={[
                {
                  label: "오늘 토큰",
                  value: formatNumber(readTokenMetric(overview.data.stats.todayTokens, tokenMode.mode)),
                  meta: tokenMode.label,
                  accent: "cool",
                  icon: Flame
                },
                {
                  label: "최근 동기화",
                  value: formatDateTime(overview.data.lastSyncedAt ?? overview.data.collector?.finishedAt ?? null),
                  meta: overview.data.collector?.message ?? "동기화 이력 없음",
                  accent: "warm",
                  icon: Clock3,
                  extra: overview.data.collector ? <StatusPill status={overview.data.collector.status} /> : null
                }
              ]}
            />

            <Panel
              title="Daily Usage"
              subtitle="최근 7일"
              icon={<Flame size={16} strokeWidth={2.2} />}
              actions={(
                <div className="panel-badges">
                  <TokenMetricToggle mode={tokenMode.mode} onChange={tokenMode.setMode} />
                  <span className="panel-badge">
                    <Activity size={13} strokeWidth={2.2} />
                    활성 {formatNumber(overview.data.stats.activeToday)}
                  </span>
                  <span className="panel-badge muted-badge">
                    평균 {formatNumber(readTokenMetric(overview.data.averageTokens7d, tokenMode.mode))}
                  </span>
                </div>
              )}
            >
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={overview.data.daily} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={formatDay} stroke="rgba(255,255,255,0.42)" axisLine={false} tickLine={false} />
                    <YAxis
                      width={104}
                      tickMargin={8}
                      allowDecimals={false}
                      tickFormatter={formatChartValue}
                      stroke="rgba(255,255,255,0.42)"
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      formatter={(value) => [formatChartValue(value), tokenMode.label]}
                    />
                    <Line
                      type="monotone"
                      dataKey={tokenMode.dataKey}
                      name={tokenMode.label}
                      stroke="var(--accent)"
                      strokeWidth={2.8}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {overview.data.collector ? (
                <div className="inline-note">
                  <StatusPill status={overview.data.collector.status} />
                  <span>{overview.data.collector.message}</span>
                </div>
              ) : null}
            </Panel>
          </>
        ) : null}
      </AsyncPane>
    </div>
  );
}
