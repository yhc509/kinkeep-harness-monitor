import { useState } from "react";
import type { TokenPeriodUnit } from "@codex-monitor/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Flame, RefreshCw } from "lucide-react";
import { apiResourceKeys, createSnapshot, getProjectTokenUsage, getTokens } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { ModelUsageDonutChart } from "../components/ModelUsageDonutChart";
import { Panel } from "../components/Panel";
import { ProjectBubbleChart } from "../components/ProjectBubbleChart";
import { StatStrip } from "../components/StatStrip";
import { StatusPill } from "../components/StatusPill";
import { invalidateApiResource, useApiResource } from "../hooks/useApiResource";
import { formatDateTime, formatDay, formatHour, formatNumber } from "../utils/format";

const ranges = [7, 30, 90];
const projectUnits: Array<{ value: TokenPeriodUnit; label: string }> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" }
];

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
  const [projectUnit, setProjectUnit] = useState<TokenPeriodUnit>("day");
  const [projectAnchorDay, setProjectAnchorDay] = useState(() => formatLocalDayKey(new Date()));
  const [syncBusy, setSyncBusy] = useState(false);
  const tokens = useApiResource(() => getTokens(range), {
    deps: [range],
    cacheKey: apiResourceKeys.tokens(range),
    staleTimeMs: 5_000
  });
  const projectUsage = useApiResource(() => getProjectTokenUsage(projectUnit, projectAnchorDay), {
    deps: [projectUnit, projectAnchorDay],
    cacheKey: apiResourceKeys.projectTokenUsage(projectUnit, projectAnchorDay),
    staleTimeMs: 5_000
  });
  const hourlySeries = tokens.data?.hourly ?? [];
  const trailingSevenDays = tokens.data?.daily.slice(-7) ?? [];
  const activeProjectAnchorDay = projectUsage.data?.anchorDay ?? projectAnchorDay;

  async function handleSync() {
    try {
      setSyncBusy(true);
      await createSnapshot();
      invalidateApiResource(apiResourceKeys.overview);
      tokens.refresh();
      projectUsage.refresh();
    } finally {
      setSyncBusy(false);
    }
  }

  function handleProjectUnitChange(nextUnit: TokenPeriodUnit) {
    setProjectUnit(nextUnit);
    setProjectAnchorDay(formatLocalDayKey(new Date()));
  }

  function handleProjectNavigate(direction: -1 | 1) {
    if (direction > 0 && projectUsage.data?.isCurrentPeriod) {
      return;
    }

    setProjectAnchorDay(shiftAnchorDay(activeProjectAnchorDay, projectUnit, direction));
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">TOKENS</p>
          <h2>Daily usage</h2>
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
          <>
            <StatStrip
              items={[
                {
                  label: "Tokens today",
                  value: formatNumber(tokens.data.daily.at(-1)?.totalTokens ?? 0),
                  meta: "Total",
                  accent: "cool",
                  icon: Flame
                },
                {
                  label: "7-day average",
                  value: formatNumber(
                    Math.round(
                      trailingSevenDays.reduce((sum, point) => sum + point.totalTokens, 0)
                      / Math.max(trailingSevenDays.length, 1)
                    )
                  ),
                  meta: "Total",
                  icon: CalendarDays
                }
              ]}
            />

            <Panel
              title="Daily total tokens"
              subtitle={`${range} days`}
              icon={<Flame size={16} strokeWidth={2.2} />}
              actions={(
                <>
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
                  <span className="panel-badge">
                    <Clock3 size={13} strokeWidth={2.2} />
                    Today {formatNumber(tokens.data.daily.at(-1)?.totalTokens ?? 0)}
                  </span>
                </>
              )}
            >
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart data={tokens.data.daily} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="24%">
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
                      formatter={(value) => [formatChartValue(value), "Total tokens"]}
                    />
                    <Bar
                      dataKey="totalTokens"
                      name="Total tokens"
                      fill="var(--accent)"
                      radius={[8, 8, 0, 0]}
                      maxBarSize={44}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel
              title="Model usage share"
              subtitle={`${range}-day token-based view`}
              icon={<CalendarDays size={16} strokeWidth={2.2} />}
              actions={(
                <div className="panel-badges">
                  <span className="panel-badge">
                    <Flame size={13} strokeWidth={2.2} />
                    Total {formatNumber(tokens.data.modelUsage.reduce((sum, item) => sum + item.totalTokens, 0))}
                  </span>
                  <span className="panel-badge muted-badge">
                    Models {formatNumber(tokens.data.modelUsage.length)}
                  </span>
                </div>
              )}
            >
              <ModelUsageDonutChart data={tokens.data.modelUsage} />
            </Panel>

            <AsyncPane loading={projectUsage.initialLoading} error={projectUsage.error} hasData={projectUsage.hasData}>
              {projectUsage.data ? (
                <Panel
                  title="Project token distribution"
                  subtitle={projectUsage.data.label}
                  icon={<CalendarDays size={16} strokeWidth={2.2} />}
                  actions={(
                    <>
                      <div className="segmented">
                        {projectUnits.map((item) => (
                          <button
                            key={item.value}
                            className={item.value === projectUnit ? "segment active" : "segment"}
                            onClick={() => handleProjectUnitChange(item.value)}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                      <div className="project-nav">
                        <button className="ghost-button icon-button" onClick={() => handleProjectNavigate(-1)} aria-label="Previous period">
                          <ChevronLeft size={15} strokeWidth={2.2} />
                        </button>
                        <span className="panel-badge">{projectUsage.data.label}</span>
                        <button
                          className="ghost-button icon-button"
                          onClick={() => handleProjectNavigate(1)}
                          disabled={projectUsage.data.isCurrentPeriod}
                          aria-label="Next period"
                        >
                          <ChevronRight size={15} strokeWidth={2.2} />
                        </button>
                        <span className="panel-badge muted-badge">
                          Total {formatNumber(projectUsage.data.totalTokens)}
                        </span>
                      </div>
                    </>
                  )}
                >
                  <ProjectBubbleChart data={projectUsage.data.projects} />
                </Panel>
              ) : null}
            </AsyncPane>

            <div className="fold-list">
              <details className="fold-panel">
                <summary className="fold-summary">
                  <div className="fold-summary-main">
                    <Clock3 size={15} strokeWidth={2.2} />
                    <strong>Last 48 hours</strong>
                  </div>
                  <span>Hourly totals</span>
                </summary>
                <div className="fold-content">
                <div className="chart-wrap compact">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={hourlySeries} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="26%">
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
                        formatter={(value) => [formatChartValue(value), "Total tokens"]}
                      />
                      <Bar
                        dataKey="totalTokens"
                        name="Total tokens"
                        fill="var(--accent-soft)"
                        radius={[6, 6, 0, 0]}
                        maxBarSize={18}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="snapshot-list compact">
                  {hourlySeries.slice(-8).reverse().map((entry) => (
                    <article key={entry.hourBucket} className="snapshot-row">
                      <div>
                        <strong>{formatDateTime(entry.hourBucket)}</strong>
                        <p>{formatNumber(entry.requestCount)} requests</p>
                      </div>
                      <span>{formatNumber(entry.totalTokens)}</span>
                    </article>
                    ))}
                  </div>
                </div>
              </details>

              <details className="fold-panel">
                <summary className="fold-summary">
                  <div className="fold-summary-main">
                    <RefreshCw size={15} strokeWidth={2.2} />
                    <strong>Sync log</strong>
                  </div>
                  <span>Last 20 runs</span>
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

function formatLocalDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function parseLocalDayKey(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return new Date();
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function shiftAnchorDay(anchorDay: string, unit: TokenPeriodUnit, delta: -1 | 1): string {
  const date = parseLocalDayKey(anchorDay);

  if (unit === "week") {
    return formatLocalDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + (7 * delta)));
  }

  if (unit === "month") {
    return formatLocalDayKey(new Date(date.getFullYear(), date.getMonth() + delta, 1));
  }

  return formatLocalDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta));
}
