import { Activity, Clock3, Flame } from "lucide-react";
import { apiResourceKeys, getOverview } from "../api";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { StatStrip } from "../components/StatStrip";
import { StatusPill } from "../components/StatusPill";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatNumber } from "../utils/format";

export function DashboardPage() {
  const overview = useApiResource(() => getOverview(), {
    deps: [],
    cacheKey: apiResourceKeys.overview,
    staleTimeMs: 10_000
  });

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">대시보드</p>
          <h2>대시보드</h2>
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
                  value: formatNumber(overview.data.stats.todayTokens.totalTokens),
                  meta: "총합",
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
              title="활동 히트맵"
              subtitle="최근 1년"
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
