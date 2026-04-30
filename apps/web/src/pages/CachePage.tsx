import { useState } from "react";
import { Clock3, Layers, RefreshCw } from "lucide-react";
import { apiResourceKeys, createSnapshot, getTokens } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { HourlyCacheHitChart } from "../components/HourlyCacheHitChart";
import { Panel } from "../components/Panel";
import { invalidateApiResource, useApiResource } from "../hooks/useApiResource";
import { formatDateTime } from "../utils/format";
import { DailyCacheTrendSection } from "./TokensPage/DailyCacheTrendSection";

const ranges = [7, 30, 90];

export function CachePage() {
  // Keep cache range page-local so cache exploration does not disturb the tokens dashboard.
  const [range, setRange] = useState(7);
  const [syncBusy, setSyncBusy] = useState(false);
  const tokens = useApiResource(() => getTokens(range), {
    deps: [range],
    cacheKey: apiResourceKeys.tokens(range),
    staleTimeMs: 300_000
  });

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
          <p className="eyebrow">CACHE</p>
          <h2>Cache hit rate</h2>
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
              <span>Refreshing</span>
            </div>
          ) : null}
          <button className="primary-button" disabled={syncBusy} onClick={handleSync}>
            <RefreshCw size={14} strokeWidth={2.2} />
            {syncBusy ? "Syncing" : "Sync now"}
          </button>
        </div>
      </section>

      <AsyncPane loading={tokens.initialLoading} error={tokens.error} hasData={tokens.hasData}>
        {tokens.data ? (
          <Panel
            title="Hourly cache hit rate"
            subtitle={`${range}-day local-hour view`}
            icon={<Layers size={16} strokeWidth={2.2} />}
            actions={(
              <div className="segmented">
                {ranges.map((item) => (
                  <button
                    key={item}
                    className={item === range ? "segment active" : "segment"}
                    onClick={() => setRange(item)}
                  >
                    {item}d
                  </button>
                ))}
              </div>
            )}
          >
            <HourlyCacheHitChart data={tokens.data.patterns.hourOfDayCacheHit} />
          </Panel>
        ) : (
          <div className="state-box">No cache data</div>
        )}
      </AsyncPane>

      <DailyCacheTrendSection />
    </div>
  );
}
