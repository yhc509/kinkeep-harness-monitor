import { Activity, Clock3, Flame } from "lucide-react";
import { apiResourceKeys, getOverview } from "../api";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { StatStrip } from "../components/StatStrip";
import { StatusPill } from "../components/StatusPill";
import { useApiResource } from "../hooks/useApiResource";
import { formatCurrency, formatDateTime, formatNumber, formatPercent } from "../utils/format";

export function DashboardPage() {
  const overview = useApiResource(() => getOverview(), {
    deps: [],
    cacheKey: apiResourceKeys.overview,
    staleTimeMs: 10_000
  });
  const cacheSavingsCopy = overview.data
    ? overview.data.cacheSavings.savedCost >= 0
      ? `Cache savings: ${formatCurrency(overview.data.cacheSavings.savedCost)} saved (${formatPercent(overview.data.cacheSavings.hitRate)} hit rate)`
      : `Cache overhead: ${formatCurrency(Math.abs(overview.data.cacheSavings.savedCost))} extra (${formatPercent(overview.data.cacheSavings.hitRate)} hit rate)`
    : null;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">DASHBOARD</p>
          <h2>Dashboard</h2>
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
                <span>Refreshing</span>
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
                  label: "Tokens today",
                  value: formatNumber(overview.data.stats.todayTokens.totalTokens),
                  meta: `Estimated ${formatCurrency(overview.data.todayCost)}`,
                  accent: "cool",
                  icon: Flame
                },
                {
                  label: "Last sync",
                  value: formatDateTime(overview.data.lastSyncedAt ?? overview.data.collector?.finishedAt ?? null),
                  meta: overview.data.collector?.message ?? "No sync history",
                  accent: "warm",
                  icon: Clock3,
                  extra: overview.data.collector ? <StatusPill status={overview.data.collector.status} /> : null
                }
              ]}
            />
            {cacheSavingsCopy ? <p className="summary-note">{cacheSavingsCopy}</p> : null}

            <Panel
              title="Activity heatmap"
              subtitle="Last 1 year"
              icon={<Activity size={16} strokeWidth={2.2} />}
            >
              <ActivityHeatmap data={overview.data.heatmapDaily} />
            </Panel>
          </>
        ) : null}
      </AsyncPane>
    </div>
  );
}
