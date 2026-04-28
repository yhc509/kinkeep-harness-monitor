import type { DailyTokenPoint, TokenPatterns } from "@codex-monitor/shared";
import { useMemo } from "react";
import { formatNumber } from "../utils/format";

type ActivityHeatmapProps =
  | {
    mode?: "calendar";
    data: DailyTokenPoint[];
  }
  | {
    mode: "dowHour";
    data: TokenPatterns["dowHourHeatmap"];
  };

interface HeatmapCell {
  day: string;
  value: number;
  level: number;
  isPadding: boolean;
}

const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });
const dayFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric"
});
const weekdayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
const dowLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hours = Array.from({ length: 24 }, (_, index) => index);

export function ActivityHeatmap(props: ActivityHeatmapProps) {
  if (props.mode === "dowHour") {
    return <DowHourHeatmap data={props.data} />;
  }

  return <CalendarHeatmap data={props.data} />;
}

function CalendarHeatmap({ data }: { data: DailyTokenPoint[] }) {
  const { weeks, monthLabels, activeDays } = useMemo(() => buildHeatmap(data), [data]);

  if (!weeks.length) {
    return null;
  }

  return (
    <div className="activity-heatmap">
      <div className="heatmap-scroll">
        <div className="heatmap-inner">
          <div className="heatmap-month-row">
            <span className="heatmap-axis-spacer" aria-hidden="true" />
            <div className="heatmap-month-track">
              {monthLabels.map((label, index) => (
                <span key={`${index}-${label || "empty"}`} className="heatmap-month-label">
                  {label}
                </span>
              ))}
            </div>
          </div>

          <div className="heatmap-grid-shell">
            <div className="heatmap-weekday-track" aria-hidden="true">
              {weekdayLabels.map((label, index) => (
                <span key={`${index}-${label || "empty"}`}>{label}</span>
              ))}
            </div>

            <div className="heatmap-column-track">
              {weeks.map((week, weekIndex) => (
                <div key={`week-${weekIndex + 1}`} className="heatmap-week-column">
                  {week.map((cell) => (
                    <div
                      key={cell.day}
                      className={`heatmap-cell level-${cell.level}${cell.isPadding ? " is-padding" : ""}`}
                      title={`${dayFormatter.format(parseDayKey(cell.day))} · ${formatNumber(cell.value)} tokens`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="heatmap-legend">
        <span>{formatNumber(activeDays)} active days</span>
        <div className="heatmap-legend-scale" aria-hidden="true">
          <span>Low</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={`legend-${level}`} className={`heatmap-cell level-${level}`} />
          ))}
          <span>High</span>
        </div>
      </div>
    </div>
  );
}

function DowHourHeatmap({ data }: { data: TokenPatterns["dowHourHeatmap"] }) {
  const { cells, activeHours } = useMemo(() => buildDowHourHeatmap(data), [data]);

  if (data.length === 0) {
    return (
      <div className="usage-pattern-empty">
        <strong>데이터 없음</strong>
      </div>
    );
  }

  return (
    <div className="activity-heatmap dow-hour-heatmap">
      <div className="dow-hour-scroll">
        <div className="dow-hour-grid" role="img" aria-label="Day of week by hour token heatmap">
          <span className="dow-hour-corner" aria-hidden="true" />
          {hours.map((hour) => (
            <span key={`hour-label-${hour}`} className="dow-hour-hour-label">
              {hour % 6 === 0 ? String(hour).padStart(2, "0") : ""}
            </span>
          ))}

          {dowLabels.map((label, dow) => (
            <div key={`dow-row-${label}`} className="dow-hour-row">
              <span className="dow-hour-dow-label">{label}</span>
              {hours.map((hour) => {
                const cell = cells.get(createDowHourKey(dow, hour)) ?? {
                  dow,
                  hour,
                  totalTokens: 0,
                  requestCount: 0,
                  level: 0
                };

                return (
                  <div
                    key={`${label}-${hour}`}
                    className={`heatmap-cell level-${cell.level}`}
                    title={`${label} ${String(hour).padStart(2, "0")}:00 · ${formatNumber(cell.totalTokens)} tokens · ${formatNumber(cell.requestCount)} requests`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="heatmap-legend">
        <span>{formatNumber(activeHours)} active hours</span>
        <div className="heatmap-legend-scale" aria-hidden="true">
          <span>Low</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={`dow-hour-legend-${level}`} className={`heatmap-cell level-${level}`} />
          ))}
          <span>High</span>
        </div>
      </div>
    </div>
  );
}

function buildHeatmap(data: DailyTokenPoint[]) {
  if (data.length === 0) {
    return {
      weeks: [] as HeatmapCell[][],
      monthLabels: [] as string[],
      activeDays: 0
    };
  }

  const valueByDay = new Map(
    data.map((entry) => [entry.day, entry.totalTokens])
  );
  const firstDay = parseDayKey(data[0]!.day);
  const lastDay = parseDayKey(data[data.length - 1]!.day);
  const gridStart = startOfWeekSunday(firstDay);
  const gridEnd = endOfWeekSaturday(lastDay);
  const positiveValues = Array.from(valueByDay.values())
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const thresholds = buildQuantileThresholds(positiveValues);
  const weeks: HeatmapCell[][] = [];
  let cursor = new Date(gridStart);

  while (cursor <= gridEnd) {
    const week: HeatmapCell[] = [];

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayKey = formatDayKey(cursor);
      const value = valueByDay.get(dayKey) ?? 0;
      week.push({
        day: dayKey,
        value,
        level: resolveHeatLevel(value, thresholds),
        isPadding: !valueByDay.has(dayKey)
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    weeks.push(week);
  }

  const monthLabels: string[] = [];
  let previousMonth = -1;

  for (const week of weeks) {
    const firstActiveCell = week.find((cell) => !cell.isPadding);
    if (!firstActiveCell) {
      monthLabels.push("");
      continue;
    }

    const date = parseDayKey(firstActiveCell.day);
    const month = date.getMonth();
    if (month === previousMonth) {
      monthLabels.push("");
      continue;
    }

    previousMonth = month;
    monthLabels.push(monthFormatter.format(date));
  }

  return {
    weeks,
    monthLabels,
    activeDays: positiveValues.length
  };
}

export function buildDowHourHeatmap(data: TokenPatterns["dowHourHeatmap"]) {
  const positiveValues = data
    .map((entry) => entry.totalTokens)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const hasEnoughCellsForQuantiles = positiveValues.length >= 5;
  const thresholds = hasEnoughCellsForQuantiles ? buildQuantileThresholds(positiveValues) : [0, 0, 0] as [number, number, number];
  const cells = new Map<string, TokenPatterns["dowHourHeatmap"][number] & { level: number }>();

  for (const entry of data) {
    cells.set(createDowHourKey(entry.dow, entry.hour), {
      ...entry,
      level: hasEnoughCellsForQuantiles
        ? resolveHeatLevel(entry.totalTokens, thresholds)
        : (entry.totalTokens > 0 ? 1 : 0)
    });
  }

  return {
    cells,
    activeHours: positiveValues.length
  };
}

function createDowHourKey(dow: number, hour: number): string {
  return `${dow}:${hour}`;
}

function parseDayKey(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, date ?? 1);
}

function formatDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeekSunday(date: Date): Date {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

function endOfWeekSaturday(date: Date): Date {
  const end = new Date(date);
  end.setDate(end.getDate() + (6 - end.getDay()));
  end.setHours(0, 0, 0, 0);
  return end;
}

function buildQuantileThresholds(values: number[]): [number, number, number] {
  if (values.length === 0) {
    return [0, 0, 0];
  }

  return [0.25, 0.5, 0.75].map((ratio) => {
    const index = Math.min(values.length - 1, Math.floor((values.length - 1) * ratio));
    return values[index] ?? 0;
  }) as [number, number, number];
}

function resolveHeatLevel(value: number, thresholds: [number, number, number]): number {
  if (value <= 0) {
    return 0;
  }

  if (value <= thresholds[0]) {
    return 1;
  }

  if (value <= thresholds[1]) {
    return 2;
  }

  if (value <= thresholds[2]) {
    return 3;
  }

  return 4;
}
