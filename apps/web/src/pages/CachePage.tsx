import { useState } from "react";
import { Layers } from "lucide-react";
import { apiResourceKeys, getTokens } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { HourlyCacheHitChart } from "../components/HourlyCacheHitChart";
import { Panel } from "../components/Panel";
import { useApiResource } from "../hooks/useApiResource";
import { DailyCacheTrendSection } from "./TokensPage/DailyCacheTrendSection";

const ranges = [7, 30, 90];

export function CachePage() {
  // Keep cache range page-local so cache exploration does not disturb the tokens dashboard.
  const [range, setRange] = useState(7);
  const tokens = useApiResource(() => getTokens(range), {
    deps: [range],
    cacheKey: apiResourceKeys.tokens(range),
    staleTimeMs: 300_000
  });

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">CACHE</p>
          <h2>Cache hit rate</h2>
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
