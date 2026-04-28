import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CacheSavings,
  CollectorRun,
  DailyTokenPoint,
  HourlyTokenUsage,
  ModelTokenUsageItem,
  ProjectTokenUsageItem,
  ProjectTokenUsageResponse,
  TokenBreakdown,
  TokenPatterns,
  TokenPeriodUnit,
  TokenSyncResult,
  TokenSyncStats,
  TokensResponse
} from "@codex-monitor/shared";
import {
  calculateCacheHitRate,
  DEFAULT_MODEL_PRICING_KEY,
  estimateUsageCost,
  estimateUsageCostWithoutCache,
  projectTokenUsageResponseSchema,
  tokenSyncResultSchema,
  tokensResponseSchema
} from "@codex-monitor/shared";
import type { AppConfig } from "../config";
import {
  formatDayKey,
  formatHourBucket,
  parseHourBucketDate,
  startOfLocalDay,
  startOfLocalHour,
  toLocalDateTime
} from "./format";
import type { SessionLogProvider } from "./provider-adapter";
import type { ResolvedProjectInfo } from "./project-resolver";
import { resolveProjectInfoFromCwd } from "./project-resolver";

const CACHE_PARSE_VERSION = "9";
const HOURLY_DEBUG_WINDOW_HOURS = 48;
const TOKEN_CACHE_STALE_MS = 5 * 60 * 1000;
const PROJECT_USAGE_LIMIT = 12;
const MODEL_USAGE_LIMIT = 6;
const UNKNOWN_PROJECT_ID = "__unknown__";
const OTHER_PROJECT_ID = "__other__";
const OTHER_MODEL_NAME = "Other";
const UNKNOWN_MODEL_NAME = "Unknown Model";
const CLAUDE_CODE_STATS_ROLLOUT_PATH = "__claude-code-stats__";
const CLAUDE_CODE_STATS_PROJECT_ID = "__claude-code__";
const CLAUDE_CODE_STATS_PROJECT_NAME = "Claude Code";
const CLAUDE_CODE_STATS_PARSE_VERSION = "claude-stats-v4";
const CLAUDE_CODE_STATS_MODEL_PROVIDER = "anthropic";
const SYNTHETIC_ROLLOUT_PATHS = new Set([CLAUDE_CODE_STATS_ROLLOUT_PATH]);
const SESSION_GAP_MS = 30 * 60 * 1000;
const SESSION_DURATION_BUCKETS = [
  { bucketMin: 0, bucketMax: 30 },
  { bucketMin: 30, bucketMax: 60 },
  { bucketMin: 60, bucketMax: 120 },
  { bucketMin: 120, bucketMax: 240 },
  { bucketMin: 240, bucketMax: 480 },
  { bucketMin: 480, bucketMax: 1440 },
  { bucketMin: 1440, bucketMax: 10080 },
  { bucketMin: 10080, bucketMax: 525600 }
];

export interface SnapshotResult extends TokenSyncResult {}

interface CollectorRunRow {
  id: number;
  started_at: string;
  finished_at: string;
  status: "success" | "warning" | "failure";
  message: string;
  snapshot_id: number | null;
}

interface RolloutIndexStateRow {
  rollout_path: string;
  file_size: number;
  mtime_ms: number;
  indexed_at: string;
  parse_version: string;
}

interface RolloutFileState {
  rolloutPath: string;
  fileSize: number;
  mtimeMs: number;
}

interface SyncPreparation {
  totalRollouts: number;
  changedFiles: RolloutFileState[];
  deletedPaths: string[];
  hasCache: boolean;
}

interface ParsedUsageBlock {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

interface ResolvedUsageBlock {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface UsageAccumulator {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  requestCount: number;
}

interface ParsedRolloutUsage {
  project: ResolvedProjectInfo | null;
  hourlyUsage: Map<string, UsageAccumulator>;
  hourlyModelUsage: Map<string, ModelUsageAccumulator>;
  tokenEvents: number;
}

interface HourlyUsageRow {
  hour_bucket: string;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  request_count: number;
}

interface DailyUsageRow {
  day: string;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
}

interface ProviderDailyUsageRow {
  day: string;
  provider: string;
  total_tokens: number;
}

interface ProjectUsageRow {
  project_id: string;
  project_name: string;
  project_path: string;
  total_tokens: number;
  request_count: number;
}

interface ModelUsageAccumulator {
  hourBucket: string;
  modelName: string;
  modelProvider: string | null;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  requestCount: number;
}

interface ModelUsageRow {
  model_name: string;
  model_provider: string | null;
  total_tokens: number;
}

interface HourlyPatternUsageRow {
  hour_bucket: string;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  uncached_input_tokens: number;
  request_count: number;
}

interface RolloutPathRow {
  rollout_path: string;
}

interface RolloutSession {
  startMs: number;
  endMs: number;
}

interface GroupedModelUsageRow {
  bucket_key: string;
  model_name: string;
  model_provider: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
}

interface CostSummary {
  actualCost: number;
  projectedCostWithoutCache: number;
  cachedInputTokens: number;
  totalInputTokens: number;
}

interface StatsCacheDailyUsage {
  hourBucket: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  modelUsage: Array<{
    modelName: string;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  }>;
}

interface StatsCacheModelTotals {
  uncachedInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

export class TokenCollectorService {
  private usageRefreshPromise: Promise<SnapshotResult> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly sessionLogProviders: SessionLogProvider[]
  ) {}

  ensureSchema(): void {
    fs.mkdirSync(path.dirname(this.config.monitorDbPath), { recursive: true });
    const database = this.openMonitorDb();
    database.exec(`
      CREATE TABLE IF NOT EXISTS hourly_token_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour_bucket TEXT NOT NULL UNIQUE,
        collected_at TEXT NOT NULL,
        total_tokens_cumulative INTEGER NOT NULL,
        thread_count INTEGER NOT NULL,
        latest_thread_updated_at TEXT,
        collector_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rollout_hourly_usage (
        rollout_path TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        project_path TEXT NOT NULL DEFAULT '',
        total_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (rollout_path, hour_bucket)
      );

      CREATE TABLE IF NOT EXISTS rollout_hourly_model_usage (
        rollout_path TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        total_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (rollout_path, hour_bucket, model_name, model_provider)
      );

      CREATE TABLE IF NOT EXISTS rollout_index_state (
        rollout_path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        parse_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collector_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        snapshot_id INTEGER,
        FOREIGN KEY(snapshot_id) REFERENCES hourly_token_snapshots(id)
      );
    `);
    ensureColumn(database, "rollout_hourly_usage", "project_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, "rollout_hourly_usage", "project_name", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, "rollout_hourly_usage", "project_path", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(database, "rollout_hourly_usage", "cache_creation_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_usage", "uncached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "cache_creation_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "uncached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "rollout_hourly_model_usage", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
    database.close();
  }

  importStatsCacheUsage(statsCachePath: string): void {
    this.ensureSchema();

    let stats: fs.Stats;
    let text: string;

    try {
      stats = fs.statSync(statsCachePath);
      text = fs.readFileSync(statsCachePath, "utf8");
    } catch (error) {
      if (isFileMissingError(error)) {
        return;
      }

      throw error instanceof Error ? error : new Error("Failed to read Claude Code stats cache");
    }

    const parsed = JSON.parse(text) as unknown;
    const record = isRecord(parsed) ? parsed : {};
    const dailyUsage = parseStatsCacheDailyUsage(parsed, record.modelUsage);
    const database = this.openMonitorDb();

    try {
      database.exec("BEGIN");
      database.prepare(`DELETE FROM rollout_hourly_usage WHERE rollout_path = ?`).run(CLAUDE_CODE_STATS_ROLLOUT_PATH);
      database.prepare(`DELETE FROM rollout_hourly_model_usage WHERE rollout_path = ?`).run(CLAUDE_CODE_STATS_ROLLOUT_PATH);

      const insertUsage = database.prepare(`
        INSERT OR REPLACE INTO rollout_hourly_usage (
          rollout_path,
          hour_bucket,
          project_id,
          project_name,
          project_path,
          total_tokens,
          input_tokens,
          cached_input_tokens,
          cache_creation_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          request_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertModelUsage = database.prepare(`
        INSERT OR REPLACE INTO rollout_hourly_model_usage (
          rollout_path,
          hour_bucket,
          model_name,
          model_provider,
          total_tokens,
          input_tokens,
          cached_input_tokens,
          cache_creation_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          request_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const entry of dailyUsage) {
        insertUsage.run(
          CLAUDE_CODE_STATS_ROLLOUT_PATH,
          entry.hourBucket,
          CLAUDE_CODE_STATS_PROJECT_ID,
          CLAUDE_CODE_STATS_PROJECT_NAME,
          "",
          entry.totalTokens,
          entry.inputTokens,
          entry.cachedInputTokens,
          entry.cacheCreationInputTokens,
          entry.uncachedInputTokens,
          entry.outputTokens,
          0,
          0
        );

        for (const modelUsage of entry.modelUsage) {
          insertModelUsage.run(
            CLAUDE_CODE_STATS_ROLLOUT_PATH,
            entry.hourBucket,
            modelUsage.modelName,
            CLAUDE_CODE_STATS_MODEL_PROVIDER,
            modelUsage.totalTokens,
            modelUsage.inputTokens,
            modelUsage.cachedInputTokens,
            modelUsage.cacheCreationInputTokens,
            modelUsage.uncachedInputTokens,
            modelUsage.outputTokens,
            0,
            0
          );
        }
      }

      database.prepare(`
        INSERT OR REPLACE INTO rollout_index_state (
          rollout_path,
          file_size,
          mtime_ms,
          indexed_at,
          parse_version
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        CLAUDE_CODE_STATS_ROLLOUT_PATH,
        stats.size,
        Math.trunc(stats.mtimeMs),
        toLocalDateTime(new Date()) ?? "",
        CLAUDE_CODE_STATS_PARSE_VERSION
      );

      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so we can still surface the original error.
      }

      throw error instanceof Error ? error : new Error("Failed to import Claude Code stats cache");
    } finally {
      database.close();
    }
  }

  captureSnapshot(now = new Date()): SnapshotResult {
    this.ensureSchema();
    return this.syncUsageCache(now, this.prepareSyncState());
  }

  refreshUsageCacheInBackground(force = false, now = new Date()): Promise<SnapshotResult | null> {
    this.ensureSchema();

    if (this.usageRefreshPromise) {
      return this.usageRefreshPromise;
    }

    if (!force && !this.isRefreshNeeded(now)) {
      return Promise.resolve(null);
    }

    this.usageRefreshPromise = Promise.resolve()
      .then(() => this.captureSnapshot(now))
      .finally(() => {
        this.usageRefreshPromise = null;
      });

    return this.usageRefreshPromise;
  }

  getLastRun(): CollectorRun | null {
    this.ensureSchema();
    const database = this.openMonitorDb();
    const row = database.prepare(`
      SELECT
        id,
        started_at,
        finished_at,
        status,
        message,
        snapshot_id
      FROM collector_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as CollectorRunRow | undefined;
    database.close();
    return row ? mapCollectorRunRow(row) : null;
  }

  getTokens(rangeDays: number, now = new Date()): TokensResponse {
    this.ensureSchema();
    if (this.isRefreshNeeded(now)) {
      void this.refreshUsageCacheInBackground(false, now);
    }

    const database = this.openMonitorDb();
    const startDate = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1)));
    const currentHourBucket = formatHourBucket(now);
    const hourlyStartDate = startOfLocalHour(new Date(now.getTime() - ((HOURLY_DEBUG_WINDOW_HOURS - 1) * 60 * 60 * 1000)));
    const costStartHourBucket = formatHourBucket(
      startDate.getTime() <= hourlyStartDate.getTime()
        ? startDate
        : hourlyStartDate
    );

    let dailyRows: DailyUsageRow[] = [];
    let providerDailyRows: ProviderDailyUsageRow[] = [];
    let hourlyRows: HourlyUsageRow[] = [];
    let runRows: CollectorRunRow[] = [];
    let modelRows: ModelUsageRow[] = [];
    let groupedModelUsageRows: GroupedModelUsageRow[] = [];
    let lastSyncedRow: { finished_at: string } | undefined;
    let patterns: TokenPatterns;

    try {
      database.exec("BEGIN");

      dailyRows = database.prepare(`
        SELECT
          substr(hour_bucket, 1, 10) AS day,
          SUM(total_tokens) AS total_tokens,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(uncached_input_tokens) AS uncached_input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM rollout_hourly_usage
        WHERE hour_bucket >= ?
        GROUP BY substr(hour_bucket, 1, 10)
        ORDER BY day ASC
      `).all(formatHourBucket(startDate)) as unknown as DailyUsageRow[];

      providerDailyRows = database.prepare(`
        SELECT
          day,
          provider,
          SUM(total_tokens) AS total_tokens
        FROM (
          SELECT
            substr(hour_bucket, 1, 10) AS day,
            total_tokens,
            CASE
              WHEN rollout_path = ? OR rollout_path LIKE '%/.claude/%' THEN 'claude-code'
              ELSE 'codex'
            END AS provider
          FROM rollout_hourly_usage
          WHERE hour_bucket >= ?
        )
        GROUP BY day, provider
        ORDER BY day ASC, provider ASC
      `).all(
        CLAUDE_CODE_STATS_ROLLOUT_PATH,
        formatHourBucket(startDate)
      ) as unknown as ProviderDailyUsageRow[];

      hourlyRows = database.prepare(`
        SELECT
          hour_bucket,
          SUM(total_tokens) AS total_tokens,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(uncached_input_tokens) AS uncached_input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_output_tokens) AS reasoning_output_tokens,
          SUM(request_count) AS request_count
        FROM rollout_hourly_usage
        WHERE hour_bucket >= ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `).all(formatHourBucket(hourlyStartDate)) as unknown as HourlyUsageRow[];

      runRows = database.prepare(`
        SELECT
          id,
          started_at,
          finished_at,
          status,
          message,
          snapshot_id
        FROM collector_runs
        ORDER BY id DESC
        LIMIT 20
      `).all() as unknown as CollectorRunRow[];

      modelRows = database.prepare(`
        SELECT
          model_name,
          model_provider,
          SUM(total_tokens) AS total_tokens
        FROM rollout_hourly_model_usage
        WHERE hour_bucket >= ?
        GROUP BY model_name, model_provider
        ORDER BY total_tokens DESC, model_name ASC
      `).all(formatHourBucket(startDate)) as unknown as ModelUsageRow[];
      groupedModelUsageRows = database.prepare(`
        SELECT
          hour_bucket AS bucket_key,
          model_name,
          model_provider,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(uncached_input_tokens) AS uncached_input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM rollout_hourly_model_usage
        WHERE hour_bucket >= ?
        GROUP BY hour_bucket, model_name, model_provider
        ORDER BY bucket_key ASC, model_name ASC
      `).all(costStartHourBucket) as unknown as GroupedModelUsageRow[];

      lastSyncedRow = database.prepare(`
        SELECT finished_at
        FROM collector_runs
        WHERE status IN ('success', 'warning')
        ORDER BY id DESC
        LIMIT 1
      `).get() as { finished_at: string } | undefined;
      patterns = this.getPatternsFromDatabase(database, rangeDays, now);

      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so we can still surface the original error.
      }

      throw error;
    } finally {
      database.close();
    }

    const costSummaries = summarizeCostUsage(groupedModelUsageRows);
    for (const row of dailyRows) {
      if (!costSummaries.daily.has(row.day)) {
        costSummaries.daily.set(row.day, summarizeAggregateUsageRow(row));
      }
    }
    for (const row of hourlyRows) {
      if (!costSummaries.hourly.has(row.hour_bucket)) {
        costSummaries.hourly.set(row.hour_bucket, summarizeAggregateUsageRow(row));
      }
    }

    const dailyMap = new Map<string, DailyTokenPoint>();
    for (const row of dailyRows) {
      dailyMap.set(row.day, {
        day: row.day,
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        uncachedTokens: Math.max(0, row.total_tokens - row.cached_input_tokens),
        uncachedInputTokens: row.uncached_input_tokens,
        outputTokens: row.output_tokens,
        estimatedCost: costSummaries.daily.get(row.day)?.actualCost ?? 0
      });
    }

    const daily: DailyTokenPoint[] = [];
    for (let offset = 0; offset < rangeDays; offset += 1) {
      const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + offset);
      const dayKey = formatDayKey(date);
      daily.push(dailyMap.get(dayKey) ?? emptyDailyTokenPoint(dayKey));
    }

    const providerDailyMap = new Map<string, { codexTokens: number; claudeCodeTokens: number }>();
    for (const row of providerDailyRows) {
      const entry = providerDailyMap.get(row.day) ?? { codexTokens: 0, claudeCodeTokens: 0 };
      if (row.provider === "claude-code") {
        entry.claudeCodeTokens = row.total_tokens;
      } else {
        entry.codexTokens = row.total_tokens;
      }
      providerDailyMap.set(row.day, entry);
    }

    const dailyProviderTokens = daily.map((point) => ({
      day: point.day,
      ...(providerDailyMap.get(point.day) ?? { codexTokens: 0, claudeCodeTokens: 0 })
    }));

    const hourly = hourlyRows.map((row) => mapHourlyUsageRow(
      row,
      costSummaries.hourly.get(row.hour_bucket)?.actualCost ?? 0
    ));
    const currentHour = hourly.find((entry) => entry.hourBucket === currentHourBucket);
    const currentHourTokens = currentHour
      ? createTokenBreakdown(currentHour.totalTokens, currentHour.cachedInputTokens)
      : emptyTokenBreakdown();
    const modelUsage = summarizeModelUsage(modelRows.map(mapModelUsageRow));

    return tokensResponseSchema.parse({
      rangeDays,
      currentHourTokens,
      daily,
      dailyProviderTokens,
      hourly,
      modelUsage,
      patterns,
      collectorRuns: runRows.map(mapCollectorRunRow),
      lastSyncedAt: lastSyncedRow?.finished_at ?? null
    });
  }

  getPatterns(rangeDays: number, now = new Date()): TokenPatterns {
    this.ensureSchema();
    const database = this.openMonitorDb();

    try {
      database.exec("BEGIN");
      const patterns = this.getPatternsFromDatabase(database, rangeDays, now);
      database.exec("COMMIT");
      return patterns;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so we can still surface the original error.
      }

      throw error;
    } finally {
      database.close();
    }
  }

  private getPatternsFromDatabase(database: DatabaseSync, rangeDays: number, now: Date): TokenPatterns {
    const startDate = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1)));
    const startHourBucket = formatHourBucket(startDate);
    const patternRows = database.prepare(`
      SELECT
        hour_bucket,
        SUM(total_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(uncached_input_tokens) AS uncached_input_tokens,
        SUM(request_count) AS request_count
      FROM rollout_hourly_usage
      WHERE hour_bucket >= ?
      GROUP BY hour_bucket
      ORDER BY hour_bucket ASC
    `).all(startHourBucket) as unknown as HourlyPatternUsageRow[];
    const rolloutPathRows = database.prepare(`
      SELECT DISTINCT rollout_path
      FROM rollout_hourly_usage
      WHERE rollout_path != ?
      ORDER BY rollout_path ASC
    `).all(CLAUDE_CODE_STATS_ROLLOUT_PATH) as unknown as RolloutPathRow[];

    return {
      ...buildHourlyPatternViews(patternRows),
      sessionDuration: buildSessionDurationPatterns(
        buildRolloutSessions(rolloutPathRows.map((row) => row.rollout_path), startDate, now)
      )
    };
  }

  getOverviewTokens(rangeDays: number, now = new Date()): {
    todayTokens: TokenBreakdown;
    todayCost: number;
    cacheSavings: CacheSavings;
    daily: DailyTokenPoint[];
    heatmapDaily: DailyTokenPoint[];
    averageTokens7d: TokenBreakdown;
    lastSyncedAt: string | null;
  } {
    const tokens = this.getTokens(Math.max(rangeDays, 365), now);
    const daily = tokens.daily.slice(-rangeDays);
    const today = daily.at(-1) ?? emptyDailyTokenPoint(formatDayKey(startOfLocalDay(now)));
    const averageTokens7d = createTokenBreakdown(
      Math.round(daily.reduce((sum, point) => sum + point.totalTokens, 0) / Math.max(daily.length, 1)),
      Math.round(daily.reduce((sum, point) => sum + point.cachedInputTokens, 0) / Math.max(daily.length, 1))
    );
    const todayCost = today.estimatedCost;
    const cacheSavings = this.getCacheSavingsForDay(today.day);

    return {
      todayTokens: createTokenBreakdown(today.totalTokens, today.cachedInputTokens),
      todayCost,
      cacheSavings,
      daily,
      heatmapDaily: tokens.daily,
      averageTokens7d,
      lastSyncedAt: tokens.lastSyncedAt
    };
  }

  getProjectTokenUsage(
    unit: TokenPeriodUnit,
    anchorDay: string | undefined,
    now = new Date()
  ): ProjectTokenUsageResponse {
    this.ensureSchema();
    if (this.isRefreshNeeded(now)) {
      void this.refreshUsageCacheInBackground(false, now);
    }

    const normalizedNow = normalizePeriodStart(now, unit);
    const anchorDate = normalizePeriodStart(parseDayKey(anchorDay, now), unit);
    const nextStart = addPeriod(anchorDate, unit, 1);
    const periodEndDate = new Date(nextStart.getFullYear(), nextStart.getMonth(), nextStart.getDate() - 1);
    const database = this.openMonitorDb();
    const rows = database.prepare(`
      SELECT
        project_id,
        project_name,
        project_path,
        SUM(total_tokens) AS total_tokens,
        SUM(request_count) AS request_count
      FROM rollout_hourly_usage
      WHERE hour_bucket >= ?
        AND hour_bucket < ?
      GROUP BY project_id, project_name, project_path
      ORDER BY total_tokens DESC, project_name ASC
    `).all(
      formatHourBucket(anchorDate),
      formatHourBucket(nextStart)
    ) as unknown as ProjectUsageRow[];
    database.close();

    const projects = rows.map(mapProjectUsageRow);
    const visibleProjects = projects.slice(0, PROJECT_USAGE_LIMIT);
    const hiddenProjects = projects.slice(PROJECT_USAGE_LIMIT);

    if (hiddenProjects.length > 0) {
      visibleProjects.push({
        projectId: OTHER_PROJECT_ID,
        projectName: "Other",
        projectPath: "",
        totalTokens: hiddenProjects.reduce((sum, item) => sum + item.totalTokens, 0),
        requestCount: hiddenProjects.reduce((sum, item) => sum + item.requestCount, 0)
      });
    }

    return projectTokenUsageResponseSchema.parse({
      unit,
      anchorDay: formatDayKey(anchorDate),
      periodStart: formatDayKey(anchorDate),
      periodEnd: formatDayKey(periodEndDate),
      label: formatPeriodLabel(anchorDate, unit, periodEndDate),
      isCurrentPeriod: anchorDate.getTime() === normalizedNow.getTime(),
      totalTokens: visibleProjects.reduce((sum, item) => sum + item.totalTokens, 0),
      projects: visibleProjects
    });
  }

  private getCacheSavingsForDay(day: string): CacheSavings {
    const startDate = parseDayKey(day, new Date());
    const nextDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1);
    const database = this.openMonitorDb();
    const rows = database.prepare(`
      SELECT
        hour_bucket AS bucket_key,
        model_name,
        model_provider,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(uncached_input_tokens) AS uncached_input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM rollout_hourly_model_usage
      WHERE hour_bucket >= ?
        AND hour_bucket < ?
      GROUP BY hour_bucket, model_name, model_provider
      ORDER BY bucket_key ASC, model_name ASC
    `).all(
      formatHourBucket(startDate),
      formatHourBucket(nextDate)
    ) as unknown as GroupedModelUsageRow[];
    const aggregateRow = database.prepare(`
      SELECT
        ? AS day,
        SUM(total_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(uncached_input_tokens) AS uncached_input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM rollout_hourly_usage
      WHERE hour_bucket >= ?
        AND hour_bucket < ?
    `).get(
      day,
      formatHourBucket(startDate),
      formatHourBucket(nextDate)
    ) as DailyUsageRow | undefined;
    database.close();

    if (rows.length > 0) {
      return toCacheSavings(summarizeCostUsage(rows).daily.get(day));
    }

    return aggregateRow
      ? toCacheSavings(summarizeAggregateUsageRow(aggregateRow))
      : toCacheSavings(undefined);
  }

  private isRefreshNeeded(now: Date): boolean {
    if (this.hasStaleCacheVersion()) {
      return true;
    }

    const lastRun = this.getLastRun();
    if (!lastRun) {
      return true;
    }

    const finishedAt = Date.parse(lastRun.finishedAt);
    if (Number.isNaN(finishedAt)) {
      return true;
    }

    return (now.getTime() - finishedAt) > TOKEN_CACHE_STALE_MS;
  }

  private hasStaleCacheVersion(): boolean {
    const database = this.openMonitorDb();
    const staleRow = database.prepare(`
      SELECT 1 AS has_stale_cache
      FROM rollout_index_state
      WHERE (
        rollout_path = ?
        AND parse_version != ?
      ) OR (
        rollout_path != ?
        AND parse_version != ?
      )
      LIMIT 1
    `).get(
      CLAUDE_CODE_STATS_ROLLOUT_PATH,
      CLAUDE_CODE_STATS_PARSE_VERSION,
      CLAUDE_CODE_STATS_ROLLOUT_PATH,
      CACHE_PARSE_VERSION
    ) as { has_stale_cache: number } | undefined;
    database.close();
    return Boolean(staleRow?.has_stale_cache);
  }

  private prepareSyncState(): SyncPreparation {
    const files: RolloutFileState[] = [];
    for (const provider of this.sessionLogProviders) {
      files.push(...scanRolloutFiles(provider.getSessionRoot()));
    }
    const database = this.openMonitorDb();
    const indexedRows = database.prepare(`
      SELECT
        rollout_path,
        file_size,
        mtime_ms,
        indexed_at,
        parse_version
      FROM rollout_index_state
    `).all() as unknown as RolloutIndexStateRow[];
    const usageCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_usage
    `).get() as { count: number };
    const modelUsageCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_model_usage
    `).get() as { count: number };
    database.close();

    const indexedMap = new Map(indexedRows.map((row) => [row.rollout_path, row]));
    const currentPaths = new Set<string>();
    const changedFiles: RolloutFileState[] = [];

    for (const file of files) {
      currentPaths.add(file.rolloutPath);
      const previous = indexedMap.get(file.rolloutPath);
      if (
        !previous ||
        previous.file_size !== file.fileSize ||
        previous.mtime_ms !== file.mtimeMs ||
        previous.parse_version !== CACHE_PARSE_VERSION
      ) {
        changedFiles.push(file);
      }
    }

    const deletedPaths = indexedRows
      .map((row) => row.rollout_path)
      .filter((rolloutPath) => !currentPaths.has(rolloutPath) && !isSyntheticRolloutPath(rolloutPath));
    const staleSyntheticPaths = indexedRows
      .filter((row) => isSyntheticRolloutPath(row.rollout_path) && row.parse_version !== CLAUDE_CODE_STATS_PARSE_VERSION)
      .map((row) => row.rollout_path);

    return {
      totalRollouts: files.length,
      changedFiles,
      deletedPaths: [...new Set([...deletedPaths, ...staleSyntheticPaths])],
      hasCache: usageCount.count > 0 || modelUsageCount.count > 0 || indexedRows.length > 0
    };
  }

  private syncUsageCache(now: Date, preparation: SyncPreparation): SnapshotResult {
    const startedAt = toLocalDateTime(now) ?? "";
    const database = this.openMonitorDb();

    try {
      const stats: TokenSyncStats = {
        totalRollouts: preparation.totalRollouts,
        updatedRollouts: 0,
        deletedRollouts: preparation.deletedPaths.length,
        hourBuckets: 0,
        tokenEvents: 0
      };

      database.exec("BEGIN");

      for (const rolloutPath of preparation.deletedPaths) {
        database.prepare(`DELETE FROM rollout_hourly_usage WHERE rollout_path = ?`).run(rolloutPath);
        database.prepare(`DELETE FROM rollout_hourly_model_usage WHERE rollout_path = ?`).run(rolloutPath);
        database.prepare(`DELETE FROM rollout_index_state WHERE rollout_path = ?`).run(rolloutPath);
      }

      for (const file of preparation.changedFiles) {
        const provider = this.findProviderForPath(file.rolloutPath);
        const parsed = isClaudeCodeRolloutPath(file.rolloutPath)
          ? parseClaudeCodeTranscriptUsage(file.rolloutPath, provider)
          : parseRolloutUsage(file.rolloutPath, provider);
        database.prepare(`DELETE FROM rollout_hourly_usage WHERE rollout_path = ?`).run(file.rolloutPath);
        database.prepare(`DELETE FROM rollout_hourly_model_usage WHERE rollout_path = ?`).run(file.rolloutPath);

        const insertUsage = database.prepare(`
          INSERT INTO rollout_hourly_usage (
            rollout_path,
            hour_bucket,
            project_id,
            project_name,
            project_path,
            total_tokens,
            input_tokens,
            cached_input_tokens,
            cache_creation_input_tokens,
            uncached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            request_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertModelUsage = database.prepare(`
          INSERT INTO rollout_hourly_model_usage (
            rollout_path,
            hour_bucket,
            model_name,
            model_provider,
            total_tokens,
            input_tokens,
            cached_input_tokens,
            cache_creation_input_tokens,
            uncached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            request_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const project = parsed.project ?? createUnknownProjectInfo();

        for (const [hourBucket, usage] of parsed.hourlyUsage.entries()) {
          insertUsage.run(
            file.rolloutPath,
            hourBucket,
            project.projectId,
            project.projectName,
            project.projectPath,
            usage.totalTokens,
            usage.inputTokens,
            usage.cachedInputTokens,
            usage.cacheCreationInputTokens,
            usage.uncachedInputTokens,
            usage.outputTokens,
            usage.reasoningOutputTokens,
            usage.requestCount
          );
        }

        for (const modelUsage of parsed.hourlyModelUsage.values()) {
          insertModelUsage.run(
            file.rolloutPath,
            modelUsage.hourBucket,
            modelUsage.modelName,
            modelUsage.modelProvider ?? "",
            modelUsage.totalTokens,
            modelUsage.inputTokens,
            modelUsage.cachedInputTokens,
            modelUsage.cacheCreationInputTokens,
            modelUsage.uncachedInputTokens,
            modelUsage.outputTokens,
            modelUsage.reasoningOutputTokens,
            modelUsage.requestCount
          );
        }

        database.prepare(`
          INSERT INTO rollout_index_state (
            rollout_path,
            file_size,
            mtime_ms,
            indexed_at,
            parse_version
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(rollout_path) DO UPDATE SET
            file_size = excluded.file_size,
            mtime_ms = excluded.mtime_ms,
            indexed_at = excluded.indexed_at,
            parse_version = excluded.parse_version
        `).run(
          file.rolloutPath,
          file.fileSize,
          file.mtimeMs,
          toLocalDateTime(new Date()) ?? "",
          CACHE_PARSE_VERSION
        );

        stats.updatedRollouts += 1;
        stats.hourBuckets += parsed.hourlyUsage.size;
        stats.tokenEvents += parsed.tokenEvents;
      }

      database.exec("COMMIT");

      const finishedAt = toLocalDateTime(new Date()) ?? "";
      const message = buildRunMessage(preparation, stats);
      const run = insertCollectorRun(database, {
        startedAt,
        finishedAt,
        status: "success",
        message
      });

      database.close();

      return tokenSyncResultSchema.parse({
        run,
        stats
      });
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so we can still surface the original error.
      }

      const finishedAt = toLocalDateTime(new Date()) ?? "";
      const message = error instanceof Error ? error.message : "Unknown error";
      insertCollectorRun(database, {
        startedAt,
        finishedAt,
        status: "failure",
        message
      });
      database.close();

      throw error instanceof Error ? error : new Error(message);
    }
  }

  private openMonitorDb(): DatabaseSync {
    return new DatabaseSync(this.config.monitorDbPath);
  }

  private findProviderForPath(rolloutPath: string): SessionLogProvider {
    for (const provider of this.sessionLogProviders) {
      if (rolloutPath.startsWith(provider.getSessionRoot())) {
        return provider;
      }
    }

    return this.sessionLogProviders[0]!;
  }
}

function buildHourlyPatternViews(rows: HourlyPatternUsageRow[]): Omit<TokenPatterns, "sessionDuration"> {
  const dowHourByKey = new Map<string, TokenPatterns["dowHourHeatmap"][number]>();
  const activeDayAveragesByHour = new Map<number, { totalTokens: number; totalRequests: number; sampleDays: number }>();
  const cacheHitByHour = new Map<number, { cachedInputTokens: number; inputTokens: number; sampleRequests: number }>();

  for (const row of rows) {
    const bucketDate = parseHourBucketDate(row.hour_bucket);
    if (!bucketDate) {
      continue;
    }

    const dow = bucketDate.getDay();
    const hour = bucketDate.getHours();
    const dowHourKey = `${dow}:${hour}`;
    const dowHourEntry = dowHourByKey.get(dowHourKey) ?? {
      dow,
      hour,
      totalTokens: 0,
      requestCount: 0
    };
    dowHourEntry.totalTokens += row.total_tokens;
    dowHourEntry.requestCount += row.request_count;
    dowHourByKey.set(dowHourKey, dowHourEntry);

    // Active-day average: only day/hour rows with activity count toward the denominator.
    const hourAverageEntry = activeDayAveragesByHour.get(hour) ?? {
      totalTokens: 0,
      totalRequests: 0,
      sampleDays: 0
    };
    hourAverageEntry.totalTokens += row.total_tokens;
    hourAverageEntry.totalRequests += row.request_count;
    hourAverageEntry.sampleDays += 1;
    activeDayAveragesByHour.set(hour, hourAverageEntry);

    const cacheEntry = cacheHitByHour.get(hour) ?? {
      cachedInputTokens: 0,
      inputTokens: 0,
      sampleRequests: 0
    };
    cacheEntry.cachedInputTokens += row.cached_input_tokens;
    cacheEntry.inputTokens += row.input_tokens;
    cacheEntry.sampleRequests += row.request_count;
    cacheHitByHour.set(hour, cacheEntry);
  }

  return {
    dowHourHeatmap: Array.from(dowHourByKey.values())
      .sort((left, right) => left.dow - right.dow || left.hour - right.hour),
    hourOfDayAverages: Array.from(activeDayAveragesByHour.entries())
      .sort(([leftHour], [rightHour]) => leftHour - rightHour)
      .map(([hour, entry]) => ({
        hour,
        avgTokens: entry.sampleDays > 0 ? entry.totalTokens / entry.sampleDays : 0,
        avgRequests: entry.sampleDays > 0 ? entry.totalRequests / entry.sampleDays : 0,
        sampleDays: entry.sampleDays
      })),
    hourOfDayCacheHit: Array.from(cacheHitByHour.entries())
      .sort(([leftHour], [rightHour]) => leftHour - rightHour)
      .map(([hour, entry]) => ({
        hour,
        hitRate: entry.inputTokens > 0 ? entry.cachedInputTokens / entry.inputTokens : 0,
        sampleRequests: entry.sampleRequests
      }))
  };
}

function buildRolloutSessions(rolloutPaths: string[], startDate: Date, now: Date): RolloutSession[] {
  const rangeStartMs = startDate.getTime();
  const nowMs = now.getTime();

  return rolloutPaths
    .filter((rolloutPath) => !isSyntheticRolloutPath(rolloutPath))
    .flatMap(parseRolloutLineSessions)
    .filter((session) => session.endMs >= rangeStartMs && session.startMs <= nowMs)
    .sort((left, right) => left.startMs - right.startMs);
}

function parseRolloutLineSessions(rolloutPath: string): RolloutSession[] {
  let text: string;
  try {
    text = fs.readFileSync(rolloutPath, "utf8");
  } catch (error) {
    const errorCode = getFileErrorCode(error);
    if (errorCode) {
      console.warn(`[token-collector] Skipping rollout file ${rolloutPath}: ${errorCode}`);
      return [];
    }

    throw error instanceof Error ? error : new Error(`Failed to read rollout sessions: ${rolloutPath}`);
  }

  const timestamps = text.split("\n")
    .flatMap((rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        return [];
      }

      let parsed: { timestamp?: unknown };
      try {
        parsed = JSON.parse(line) as { timestamp?: unknown };
      } catch {
        return [];
      }

      if (typeof parsed.timestamp !== "string") {
        return [];
      }

      const time = Date.parse(parsed.timestamp);
      return Number.isNaN(time) ? [] : [time];
    })
    .sort((left, right) => left - right);

  if (timestamps.length === 0) {
    return [];
  }

  const sessions: RolloutSession[] = [];
  let startMs = timestamps[0]!;
  let endMs = timestamps[0]!;

  for (const nextMs of timestamps.slice(1)) {
    if ((nextMs - endMs) >= SESSION_GAP_MS) {
      sessions.push({ startMs, endMs });
      startMs = nextMs;
    }

    endMs = nextMs;
  }

  sessions.push({ startMs, endMs });
  return sessions;
}

function buildSessionDurationPatterns(sessions: RolloutSession[]): TokenPatterns["sessionDuration"] {
  if (sessions.length === 0) {
    return {
      startHistogram: [],
      durationBuckets: []
    };
  }

  const startCountsByHour = new Map<number, number>();
  const durationBuckets = SESSION_DURATION_BUCKETS.map((bucket) => ({
    ...bucket,
    count: 0
  }));

  for (const session of sessions) {
    const startHour = new Date(session.startMs).getHours();
    startCountsByHour.set(startHour, (startCountsByHour.get(startHour) ?? 0) + 1);

    const durationMinutes = Math.max(
      0,
      Math.floor((session.endMs - session.startMs) / 60_000)
    );
    const bucket = durationBuckets.find((candidate, index) => (
      durationMinutes >= candidate.bucketMin
      && (durationMinutes < candidate.bucketMax || index === durationBuckets.length - 1)
    ));

    if (bucket) {
      bucket.count += 1;
    }
  }

  return {
    startHistogram: Array.from(startCountsByHour.entries())
      .sort(([leftHour], [rightHour]) => leftHour - rightHour)
      .map(([hour, count]) => ({ hour, count })),
    durationBuckets
  };
}

function insertCollectorRun(
  database: DatabaseSync,
  input: {
    startedAt: string;
    finishedAt: string;
    status: CollectorRun["status"];
    message: string;
  }
): CollectorRun {
  const result = database.prepare(`
    INSERT INTO collector_runs (
      started_at,
      finished_at,
      status,
      message,
      snapshot_id
    ) VALUES (?, ?, ?, ?, NULL)
  `).run(input.startedAt, input.finishedAt, input.status, input.message);

  return {
    id: Number(result.lastInsertRowid),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    message: input.message,
    snapshotId: null
  };
}

function buildRunMessage(preparation: SyncPreparation, stats: TokenSyncStats): string {
  if (stats.updatedRollouts === 0 && stats.deletedRollouts === 0) {
    return "No changes · kept existing token cache";
  }

  return [
    "Token cache sync complete",
    `total ${stats.totalRollouts}`,
    `updated ${stats.updatedRollouts}`,
    `deleted ${stats.deletedRollouts}`,
    `events ${stats.tokenEvents.toLocaleString("en-US")}`
  ].join(" · ");
}

function parseRolloutUsage(rolloutPath: string, sessionLogProvider: SessionLogProvider): ParsedRolloutUsage {
  const text = fs.readFileSync(rolloutPath, "utf8");
  const lines = text.split("\n");
  const hourlyUsage = new Map<string, UsageAccumulator>();
  const hourlyModelUsage = new Map<string, ModelUsageAccumulator>();
  let project: ResolvedProjectInfo | null = sessionLogProvider.resolveProjectInfoForRolloutPath(rolloutPath);
  let currentModelProvider: string | null = null;
  let currentModelName: string | null = null;
  let tokenEvents = 0;
  let previousTotals: ParsedUsageBlock = emptyParsedUsage();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: {
      timestamp?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };

    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch (error) {
      throw new Error(`Failed to parse rollout: ${rolloutPath}\n${error instanceof Error ? error.message : "Unknown error"}`);
    }

    const payload = parsed.payload ?? {};
    if (parsed.type === "session_meta") {
      if (typeof payload.cwd === "string" && payload.cwd.trim()) {
        project = resolveProjectInfoFromCwd(payload.cwd.trim());
      }

      if (typeof payload.model_provider === "string" && payload.model_provider.trim()) {
        currentModelProvider = payload.model_provider.trim();
      }
      continue;
    }

    if (parsed.type === "turn_context") {
      if (typeof payload.cwd === "string" && payload.cwd.trim()) {
        project = resolveProjectInfoFromCwd(payload.cwd.trim());
      }

      const nextModelName = readTurnContextModelName(payload);
      if (nextModelName) {
        currentModelName = nextModelName;
      }
      continue;
    }

    if (parsed.type !== "event_msg") {
      continue;
    }

    if (payload.type !== "token_count") {
      continue;
    }

    const info = isRecord(payload.info) ? payload.info : {};
    const totalUsage = parseUsageBlock(info.total_token_usage);
    const lastUsage = parseUsageBlock(info.last_token_usage);
    const rawTimestamp = typeof parsed.timestamp === "string"
      ? parsed.timestamp
      : typeof payload.timestamp === "string"
        ? payload.timestamp
        : null;

    if (!rawTimestamp) {
      previousTotals = mergeUsageState(previousTotals, totalUsage);
      continue;
    }

    const timestamp = new Date(rawTimestamp);
    if (Number.isNaN(timestamp.getTime())) {
      previousTotals = mergeUsageState(previousTotals, totalUsage);
      continue;
    }

    const nextTotals = mergeUsageState(previousTotals, totalUsage);
    if (!hasCumulativeUsageProgress(totalUsage, previousTotals)) {
      previousTotals = nextTotals;
      continue;
    }

    const delta = resolveUsageDelta(lastUsage, totalUsage, previousTotals);
    previousTotals = nextTotals;

    if (delta.totalTokens <= 0) {
      continue;
    }

    tokenEvents += 1;

    const hourBucket = formatHourBucket(timestamp);
    const accumulator = hourlyUsage.get(hourBucket) ?? createEmptyUsageAccumulator();
    accumulator.totalTokens += delta.totalTokens;
    accumulator.inputTokens += delta.inputTokens;
    accumulator.cachedInputTokens += delta.cachedInputTokens;
    accumulator.uncachedInputTokens += Math.max(0, delta.inputTokens - delta.cachedInputTokens);
    accumulator.outputTokens += delta.outputTokens;
    accumulator.reasoningOutputTokens += delta.reasoningOutputTokens;
    accumulator.requestCount += 1;
    hourlyUsage.set(hourBucket, accumulator);

    const modelUsageKey = createModelUsageKey(hourBucket, currentModelName, currentModelProvider);
    const modelUsage = hourlyModelUsage.get(modelUsageKey)
      ?? createEmptyModelUsageAccumulator(hourBucket, currentModelName, currentModelProvider);
    modelUsage.totalTokens += delta.totalTokens;
    modelUsage.inputTokens += delta.inputTokens;
    modelUsage.cachedInputTokens += delta.cachedInputTokens;
    modelUsage.uncachedInputTokens += Math.max(0, delta.inputTokens - delta.cachedInputTokens);
    modelUsage.outputTokens += delta.outputTokens;
    modelUsage.reasoningOutputTokens += delta.reasoningOutputTokens;
    modelUsage.requestCount += 1;
    hourlyModelUsage.set(modelUsageKey, modelUsage);
  }

  return {
    project,
    hourlyUsage,
    hourlyModelUsage,
    tokenEvents
  };
}

function parseClaudeCodeTranscriptUsage(
  rolloutPath: string,
  sessionLogProvider: SessionLogProvider
): ParsedRolloutUsage {
  const text = fs.readFileSync(rolloutPath, "utf8");
  const lines = text.split("\n");
  const hourlyUsage = new Map<string, UsageAccumulator>();
  const hourlyModelUsage = new Map<string, ModelUsageAccumulator>();
  let project: ResolvedProjectInfo | null = sessionLogProvider.resolveProjectInfoForRolloutPath(rolloutPath);
  let tokenEvents = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = readOptionalString(parsed, "type") ?? "";
    if (type === "user") {
      const cwd = readOptionalString(parsed, "cwd");
      if (cwd) {
        project = resolveProjectInfoFromCwd(cwd);
      }
      continue;
    }

    if (type !== "assistant") {
      continue;
    }

    const message = isRecord(parsed.message) ? parsed.message : null;
    if (!message) {
      continue;
    }

    const usage = isRecord(message.usage) ? message.usage : null;
    if (!usage) {
      continue;
    }

    const modelName = readOptionalString(message, "model");
    if (modelName === "<synthetic>") {
      continue;
    }

    const rawTimestamp = readOptionalString(parsed, "timestamp");
    if (!rawTimestamp) {
      continue;
    }

    const timestamp = new Date(rawTimestamp);
    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }

    const uncachedInputTokens = readUsageNumber(usage, "input_tokens");
    const outputTokens = readUsageNumber(usage, "output_tokens");
    const cacheCreationTokens = readUsageNumber(usage, "cache_creation_input_tokens");
    const cacheReadTokens = readUsageNumber(usage, "cache_read_input_tokens");
    // Claude reports uncached input, cache writes, and cache reads separately.
    // Normalize to the shared schema so inputTokens is total input and
    // cachedInputTokens only represents cache-hit tokens.
    const cachedInputTokens = cacheReadTokens;
    const inputTokens = uncachedInputTokens + cacheCreationTokens + cacheReadTokens;
    const totalTokens = inputTokens + outputTokens;

    if (totalTokens <= 0) {
      continue;
    }

    tokenEvents += 1;

    const hourBucket = formatHourBucket(timestamp);
    const accumulator = hourlyUsage.get(hourBucket) ?? createEmptyUsageAccumulator();
    accumulator.totalTokens += totalTokens;
    accumulator.inputTokens += inputTokens;
    accumulator.cachedInputTokens += cachedInputTokens;
    accumulator.cacheCreationInputTokens += cacheCreationTokens;
    accumulator.uncachedInputTokens += uncachedInputTokens + cacheCreationTokens;
    accumulator.outputTokens += outputTokens;
    accumulator.requestCount += 1;
    hourlyUsage.set(hourBucket, accumulator);

    const modelProvider = "anthropic";
    const modelUsageKey = createModelUsageKey(hourBucket, modelName, modelProvider);
    const modelUsage = hourlyModelUsage.get(modelUsageKey)
      ?? createEmptyModelUsageAccumulator(hourBucket, modelName, modelProvider);
    modelUsage.totalTokens += totalTokens;
    modelUsage.inputTokens += inputTokens;
    modelUsage.cachedInputTokens += cachedInputTokens;
    modelUsage.cacheCreationInputTokens += cacheCreationTokens;
    modelUsage.uncachedInputTokens += uncachedInputTokens;
    modelUsage.outputTokens += outputTokens;
    modelUsage.requestCount += 1;
    hourlyModelUsage.set(modelUsageKey, modelUsage);
  }

  return {
    project,
    hourlyUsage,
    hourlyModelUsage,
    tokenEvents
  };
}

function parseUsageBlock(value: unknown): ParsedUsageBlock {
  const record = isRecord(value) ? value : {};
  return {
    totalTokens: readOptionalNumber(record, "total_tokens"),
    inputTokens: readOptionalNumber(record, "input_tokens"),
    cachedInputTokens: readOptionalNumber(record, "cached_input_tokens"),
    outputTokens: readOptionalNumber(record, "output_tokens"),
    reasoningOutputTokens: readOptionalNumber(record, "reasoning_output_tokens")
  };
}

function readUsageNumber(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function resolveUsageDelta(
  lastUsage: ParsedUsageBlock,
  totalUsage: ParsedUsageBlock,
  previousTotals: ParsedUsageBlock
): ResolvedUsageBlock {
  return {
    totalTokens: resolveMetricDelta(lastUsage.totalTokens, totalUsage.totalTokens, previousTotals.totalTokens),
    inputTokens: resolveMetricDelta(lastUsage.inputTokens, totalUsage.inputTokens, previousTotals.inputTokens),
    cachedInputTokens: resolveMetricDelta(lastUsage.cachedInputTokens, totalUsage.cachedInputTokens, previousTotals.cachedInputTokens),
    outputTokens: resolveMetricDelta(lastUsage.outputTokens, totalUsage.outputTokens, previousTotals.outputTokens),
    reasoningOutputTokens: resolveMetricDelta(lastUsage.reasoningOutputTokens, totalUsage.reasoningOutputTokens, previousTotals.reasoningOutputTokens)
  };
}

/**
 * Assumes Codex CLI total_token_usage cumulative counters are monotonically increasing within a session.
 * If an individual metric stays flat or decreases, defensively clamp that metric's delta to 0.
 */
function resolveMetricDelta(lastValue: number | null, currentTotal: number | null, previousTotal: number | null): number {
  if (currentTotal !== null && previousTotal !== null && currentTotal <= previousTotal) {
    return 0;
  }

  if (lastValue !== null) {
    return Math.max(0, lastValue);
  }

  if (currentTotal === null) {
    return 0;
  }

  return Math.max(0, currentTotal - (previousTotal ?? 0));
}

function mergeUsageState(previous: ParsedUsageBlock, next: ParsedUsageBlock): ParsedUsageBlock {
  return {
    totalTokens: next.totalTokens ?? previous.totalTokens,
    inputTokens: next.inputTokens ?? previous.inputTokens,
    cachedInputTokens: next.cachedInputTokens ?? previous.cachedInputTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
    reasoningOutputTokens: next.reasoningOutputTokens ?? previous.reasoningOutputTokens
  };
}

/**
 * Assumes Codex CLI total_token_usage cumulative counters are monotonically increasing within a session.
 * Treat a snapshot as progress only when at least one reported cumulative metric increases.
 */
function hasCumulativeUsageProgress(totalUsage: ParsedUsageBlock, previousTotals: ParsedUsageBlock): boolean {
  let hasTotals = false;

  for (const metric of ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
    const nextValue = totalUsage[metric];
    if (nextValue === null) {
      continue;
    }

    hasTotals = true;
    const previousValue = previousTotals[metric];
    if (previousValue === null || nextValue > previousValue) {
      return true;
    }
  }

  return !hasTotals;
}

function createEmptyUsageAccumulator(): UsageAccumulator {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    requestCount: 0
  };
}

function createEmptyModelUsageAccumulator(
  hourBucket: string,
  modelName: string | null,
  modelProvider: string | null
): ModelUsageAccumulator {
  return {
    hourBucket,
    modelName: modelName?.trim() || UNKNOWN_MODEL_NAME,
    modelProvider: normalizeProvider(modelProvider),
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    requestCount: 0
  };
}

function emptyParsedUsage(): ParsedUsageBlock {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null
  };
}

function mapHourlyUsageRow(row: HourlyUsageRow, estimatedCost: number): HourlyTokenUsage {
  return {
    hourBucket: row.hour_bucket,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    uncachedInputTokens: row.uncached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    requestCount: row.request_count,
    estimatedCost
  };
}

function mapProjectUsageRow(row: ProjectUsageRow): ProjectTokenUsageItem {
  return {
    projectId: row.project_id || UNKNOWN_PROJECT_ID,
    projectName: row.project_name || "Unknown",
    projectPath: row.project_path,
    totalTokens: row.total_tokens,
    requestCount: row.request_count
  };
}

function mapModelUsageRow(row: ModelUsageRow): ModelTokenUsageItem {
  return {
    modelName: row.model_name || UNKNOWN_MODEL_NAME,
    modelProvider: normalizeProvider(row.model_provider),
    totalTokens: row.total_tokens
  };
}

function summarizeModelUsage(items: ModelTokenUsageItem[]): ModelTokenUsageItem[] {
  const visibleItems = items.slice(0, MODEL_USAGE_LIMIT);
  const hiddenItems = items.slice(MODEL_USAGE_LIMIT);

  if (hiddenItems.length > 0) {
    visibleItems.push({
      modelName: OTHER_MODEL_NAME,
      modelProvider: null,
      totalTokens: hiddenItems.reduce((sum, item) => sum + item.totalTokens, 0)
    });
  }

  return visibleItems;
}

function summarizeCostUsage(rows: GroupedModelUsageRow[]): {
  daily: Map<string, CostSummary>;
  hourly: Map<string, CostSummary>;
} {
  const daily = new Map<string, CostSummary>();
  const hourly = new Map<string, CostSummary>();

  for (const row of rows) {
    const bucketKey = row.bucket_key;
    const usage = {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      uncachedInputTokens: row.uncached_input_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      outputTokens: row.output_tokens
    };
    const actualCost = estimateUsageCost(usage, row.model_name);
    const projectedCostWithoutCache = estimateUsageCostWithoutCache(usage, row.model_name);
    const dayKey = bucketKey.slice(0, 10);
    const totalInputTokens = row.cached_input_tokens + row.uncached_input_tokens + row.cache_creation_input_tokens;

    mergeCostSummary(
      hourly,
      bucketKey,
      actualCost,
      projectedCostWithoutCache,
      row.cached_input_tokens,
      totalInputTokens
    );
    mergeCostSummary(
      daily,
      dayKey,
      actualCost,
      projectedCostWithoutCache,
      row.cached_input_tokens,
      totalInputTokens
    );
  }

  return { daily, hourly };
}

function mergeCostSummary(
  summaries: Map<string, CostSummary>,
  key: string,
  actualCost: number,
  projectedCostWithoutCache: number,
  cachedInputTokens: number,
  totalInputTokens: number
): void {
  const summary = summaries.get(key) ?? createEmptyCostSummary();
  summary.actualCost += actualCost;
  summary.projectedCostWithoutCache += projectedCostWithoutCache;
  summary.cachedInputTokens += cachedInputTokens;
  summary.totalInputTokens += totalInputTokens;
  summaries.set(key, summary);
}

function createEmptyCostSummary(): CostSummary {
  return {
    actualCost: 0,
    projectedCostWithoutCache: 0,
    cachedInputTokens: 0,
    totalInputTokens: 0
  };
}

function toCacheSavings(summary: CostSummary | undefined): CacheSavings {
  const resolved = summary ?? createEmptyCostSummary();
  return {
    actualCost: roundUsd(resolved.actualCost),
    projectedCostWithoutCache: roundUsd(resolved.projectedCostWithoutCache),
    savedCost: roundUsd(resolved.projectedCostWithoutCache - resolved.actualCost),
    hitRate: calculateCacheHitRate({
      inputTokens: resolved.totalInputTokens,
      cachedInputTokens: resolved.cachedInputTokens
    })
  };
}

function summarizeAggregateUsageRow(row: DailyUsageRow | HourlyUsageRow): CostSummary {
  const usage = {
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    uncachedInputTokens: row.uncached_input_tokens,
    outputTokens: row.output_tokens
  };

  return {
    actualCost: estimateUsageCost(usage, DEFAULT_MODEL_PRICING_KEY),
    projectedCostWithoutCache: estimateUsageCostWithoutCache(usage, DEFAULT_MODEL_PRICING_KEY),
    cachedInputTokens: row.cached_input_tokens,
    totalInputTokens: row.input_tokens
  };
}

function createTokenBreakdown(totalTokens: number, cachedInputTokens: number): TokenBreakdown {
  return {
    totalTokens,
    cachedInputTokens,
    uncachedTokens: Math.max(0, totalTokens - cachedInputTokens)
  };
}

function emptyTokenBreakdown(): TokenBreakdown {
  return createTokenBreakdown(0, 0);
}

function emptyDailyTokenPoint(day: string): DailyTokenPoint {
  return {
    day,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0
  };
}

function mapCollectorRunRow(row: CollectorRunRow): CollectorRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    message: row.message,
    snapshotId: row.snapshot_id
  };
}

function createUnknownProjectInfo(): ResolvedProjectInfo {
  return {
    projectId: UNKNOWN_PROJECT_ID,
    projectName: "Unknown",
    projectPath: ""
  };
}

function readTurnContextModelName(payload: Record<string, unknown>): string | null {
  const directModel = readOptionalString(payload, "model");
  if (directModel) {
    return directModel;
  }

  const collaborationMode = isRecord(payload.collaboration_mode) ? payload.collaboration_mode : null;
  const settings = collaborationMode && isRecord(collaborationMode.settings) ? collaborationMode.settings : null;
  return readOptionalString(settings ?? {}, "model");
}

function normalizeProvider(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createModelUsageKey(hourBucket: string, modelName: string | null, modelProvider: string | null): string {
  return `${hourBucket}\u0000${modelName?.trim() || UNKNOWN_MODEL_NAME}\u0000${normalizeProvider(modelProvider) ?? ""}`;
}

/**
 * Parses stats-cache daily totals and distributes each day's per-model total across input/output/cache buckets
 * using that model's cumulative `modelUsage` ratio.
 *
 * Limitation: the cumulative ratio is only an estimation of a single day's actual mix. The gap can be larger
 * around cache cold starts or when usage patterns change over time.
 *
 * Models without `modelUsage` preserve the existing fallback behavior and treat the full total as
 * `uncachedInputTokens`.
 */
function parseStatsCacheDailyUsage(value: unknown, modelUsageValue: unknown): StatsCacheDailyUsage[] {
  const record = isRecord(value) ? value : {};
  const dailyModelTokens = Array.isArray(record.dailyModelTokens) ? record.dailyModelTokens : [];
  const modelUsageTotals = parseStatsCacheModelTotals(modelUsageValue);
  const dailyUsage: StatsCacheDailyUsage[] = [];

  for (const entry of dailyModelTokens) {
    if (!isRecord(entry)) {
      continue;
    }

    const hourBucket = parseStatsCacheHourBucket(entry.date);
    if (!hourBucket) {
      continue;
    }

    const tokensByModel = isRecord(entry.tokensByModel) ? entry.tokensByModel : {};
    const modelUsage = Object.entries(tokensByModel)
      .flatMap(([modelName, totalTokens]) => {
        const normalizedName = modelName.trim();
        const normalizedTotal = normalizeStatsTokenCount(totalTokens);
        if (!normalizedName || normalizedTotal === null) {
          return [];
        }

        return [{
          modelName: normalizedName,
          totalTokens: normalizedTotal,
          ...resolveStatsCacheTokenBreakdown(normalizedTotal, modelUsageTotals.get(normalizedName))
        }];
      })
      .sort((left, right) => left.modelName.localeCompare(right.modelName));

    dailyUsage.push({
      hourBucket,
      totalTokens: modelUsage.reduce((sum, item) => sum + item.totalTokens, 0),
      inputTokens: modelUsage.reduce((sum, item) => sum + item.inputTokens, 0),
      cachedInputTokens: modelUsage.reduce((sum, item) => sum + item.cachedInputTokens, 0),
      cacheCreationInputTokens: modelUsage.reduce((sum, item) => sum + item.cacheCreationInputTokens, 0),
      uncachedInputTokens: modelUsage.reduce((sum, item) => sum + item.uncachedInputTokens + item.cacheCreationInputTokens, 0),
      outputTokens: modelUsage.reduce((sum, item) => sum + item.outputTokens, 0),
      modelUsage
    });
  }

  dailyUsage.sort((left, right) => left.hourBucket.localeCompare(right.hourBucket));
  return dailyUsage;
}

function parseStatsCacheHourBucket(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatHourBucket(date);
}

function parseStatsCacheModelTotals(value: unknown): Map<string, StatsCacheModelTotals> {
  const record = isRecord(value) ? value : {};
  const totals = new Map<string, StatsCacheModelTotals>();

  for (const [modelName, rawTotals] of Object.entries(record)) {
    const normalizedName = modelName.trim();
    if (!normalizedName || !isRecord(rawTotals)) {
      continue;
    }

    const uncachedInputTokens = normalizeStatsTokenCount(rawTotals.inputTokens) ?? 0;
    const outputTokens = normalizeStatsTokenCount(rawTotals.outputTokens) ?? 0;
    const cachedInputTokens = normalizeStatsTokenCount(rawTotals.cacheReadInputTokens) ?? 0;
    const cacheCreationInputTokens = normalizeStatsTokenCount(rawTotals.cacheCreationInputTokens) ?? 0;
    const totalTokens = uncachedInputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens;

    if (totalTokens <= 0) {
      continue;
    }

    totals.set(normalizedName, {
      uncachedInputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      totalTokens
    });
  }

  return totals;
}

/**
 * Allocates a daily model total by cumulative `modelUsage` ratio, then rebalances rounded values so the
 * bucket sum still matches `totalTokens`.
 */
function resolveStatsCacheTokenBreakdown(
  totalTokens: number,
  modelTotals: StatsCacheModelTotals | undefined
): Omit<StatsCacheDailyUsage["modelUsage"][number], "modelName" | "totalTokens"> {
  if (!modelTotals || modelTotals.totalTokens <= 0) {
    return {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      uncachedInputTokens: totalTokens,
      outputTokens: 0
    };
  }

  const allocations = [
    {
      key: "uncachedInputTokens" as const,
      sourceTokens: modelTotals.uncachedInputTokens,
      allocatedTokens: Math.round((totalTokens * modelTotals.uncachedInputTokens) / modelTotals.totalTokens)
    },
    {
      key: "outputTokens" as const,
      sourceTokens: modelTotals.outputTokens,
      allocatedTokens: Math.round((totalTokens * modelTotals.outputTokens) / modelTotals.totalTokens)
    },
    {
      key: "cachedInputTokens" as const,
      sourceTokens: modelTotals.cachedInputTokens,
      allocatedTokens: Math.round((totalTokens * modelTotals.cachedInputTokens) / modelTotals.totalTokens)
    },
    {
      key: "cacheCreationInputTokens" as const,
      sourceTokens: modelTotals.cacheCreationInputTokens,
      allocatedTokens: Math.round((totalTokens * modelTotals.cacheCreationInputTokens) / modelTotals.totalTokens)
    }
  ];
  rebalanceStatsCacheAllocations(allocations, totalTokens);

  const uncachedInputTokens = allocations.find((entry) => entry.key === "uncachedInputTokens")?.allocatedTokens ?? 0;
  const outputTokens = allocations.find((entry) => entry.key === "outputTokens")?.allocatedTokens ?? 0;
  const cachedInputTokens = allocations.find((entry) => entry.key === "cachedInputTokens")?.allocatedTokens ?? 0;
  const cacheCreationInputTokens = allocations.find((entry) => entry.key === "cacheCreationInputTokens")?.allocatedTokens ?? 0;

  return {
    inputTokens: uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    outputTokens
  };
}

function rebalanceStatsCacheAllocations(
  allocations: Array<{
    key: "uncachedInputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationInputTokens";
    sourceTokens: number;
    allocatedTokens: number;
  }>,
  totalTokens: number
): void {
  let delta = totalTokens - allocations.reduce((sum, entry) => sum + entry.allocatedTokens, 0);
  if (delta === 0) {
    return;
  }

  const rankedAllocations = [...allocations]
    .sort((left, right) => (
      right.allocatedTokens - left.allocatedTokens
      || right.sourceTokens - left.sourceTokens
      || left.key.localeCompare(right.key)
    ));

  if (delta > 0) {
    rankedAllocations[0]!.allocatedTokens += delta;
    return;
  }

  delta = Math.abs(delta);
  for (const entry of rankedAllocations) {
    if (delta === 0) {
      break;
    }

    const reduction = Math.min(entry.allocatedTokens, delta);
    entry.allocatedTokens -= reduction;
    delta -= reduction;
  }
}

function normalizeStatsTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
  }

  return null;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function isSyntheticRolloutPath(rolloutPath: string): boolean {
  return SYNTHETIC_ROLLOUT_PATHS.has(rolloutPath);
}

function isClaudeCodeRolloutPath(rolloutPath: string): boolean {
  return isSyntheticRolloutPath(rolloutPath) || rolloutPath.includes("/.claude/");
}

function parseDayKey(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return startOfLocalDay(fallback);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return startOfLocalDay(fallback);
  }

  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? startOfLocalDay(fallback) : startOfLocalDay(parsed);
}

function normalizePeriodStart(date: Date, unit: TokenPeriodUnit): Date {
  const day = startOfLocalDay(date);
  if (unit === "week") {
    return startOfLocalWeek(day);
  }

  if (unit === "month") {
    return new Date(day.getFullYear(), day.getMonth(), 1);
  }

  return day;
}

function startOfLocalWeek(date: Date): Date {
  const day = startOfLocalDay(date);
  const diff = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - diff);
}

function addPeriod(date: Date, unit: TokenPeriodUnit, delta: number): Date {
  if (unit === "week") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (7 * delta));
  }

  if (unit === "month") {
    return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  }

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

function formatPeriodLabel(startDate: Date, unit: TokenPeriodUnit, endDate: Date): string {
  if (unit === "month") {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long"
    }).format(startDate);
  }

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric"
  });

  if (unit === "day") {
    return dayFormatter.format(startDate);
  }

  return `${dayFormatter.format(startDate)} - ${dayFormatter.format(endDate)}`;
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }

  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }

  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
  return getFileErrorCode(error) === "ENOENT";
}

function getFileErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : null;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function scanRolloutFiles(baseDir: string): RolloutFileState[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  return walkFiles(baseDir)
    .filter((filePath) => filePath.endsWith(".jsonl"))
    .map((rolloutPath) => {
      const stats = fs.statSync(rolloutPath);
      return {
        rolloutPath,
        fileSize: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs)
      };
    })
    .sort((left, right) => left.rolloutPath.localeCompare(right.rolloutPath));
}

function walkFiles(baseDir: string): string[] {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }

    results.push(fullPath);
  }

  return results;
}
