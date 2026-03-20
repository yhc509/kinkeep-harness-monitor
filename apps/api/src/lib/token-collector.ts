import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CollectorRun,
  DailyTokenPoint,
  HourlyTokenUsage,
  ModelTokenUsageItem,
  ProjectTokenUsageItem,
  ProjectTokenUsageResponse,
  TokenBreakdown,
  TokenPeriodUnit,
  TokenSyncResult,
  TokenSyncStats,
  TokensResponse
} from "@codex-monitor/shared";
import { projectTokenUsageResponseSchema, tokenSyncResultSchema, tokensResponseSchema } from "@codex-monitor/shared";
import type { AppConfig } from "../config";
import { formatDayKey, formatHourBucket, startOfLocalDay, startOfLocalHour, toLocalDateTime } from "./format";
import type { SessionLogProvider } from "./provider-adapter";
import type { ResolvedProjectInfo } from "./project-resolver";
import { resolveProjectInfoFromCwd } from "./project-resolver";

const CACHE_PARSE_VERSION = "5";
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
const CLAUDE_CODE_STATS_PARSE_VERSION = "claude-stats-v1";
const CLAUDE_CODE_STATS_MODEL_PROVIDER = "anthropic";
const SYNTHETIC_ROLLOUT_PATHS = new Set([CLAUDE_CODE_STATS_ROLLOUT_PATH]);

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
  output_tokens: number;
  reasoning_output_tokens: number;
  request_count: number;
}

interface DailyUsageRow {
  day: string;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
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
  requestCount: number;
}

interface ModelUsageRow {
  model_name: string;
  model_provider: string | null;
  total_tokens: number;
}

interface StatsCacheDailyUsage {
  hourBucket: string;
  totalTokens: number;
  modelUsage: Array<{
    modelName: string;
    totalTokens: number;
  }>;
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
    const dailyUsage = parseStatsCacheDailyUsage(parsed);
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
          output_tokens,
          reasoning_output_tokens,
          request_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertModelUsage = database.prepare(`
        INSERT OR REPLACE INTO rollout_hourly_model_usage (
          rollout_path,
          hour_bucket,
          model_name,
          model_provider,
          total_tokens,
          request_count
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const entry of dailyUsage) {
        insertUsage.run(
          CLAUDE_CODE_STATS_ROLLOUT_PATH,
          entry.hourBucket,
          CLAUDE_CODE_STATS_PROJECT_ID,
          CLAUDE_CODE_STATS_PROJECT_NAME,
          "",
          entry.totalTokens,
          0,
          0,
          0,
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

    const dailyRows = database.prepare(`
      SELECT
        substr(hour_bucket, 1, 10) AS day,
        SUM(total_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM rollout_hourly_usage
      WHERE hour_bucket >= ?
      GROUP BY substr(hour_bucket, 1, 10)
      ORDER BY day ASC
    `).all(formatHourBucket(startDate)) as unknown as DailyUsageRow[];

    const providerDailyRows = database.prepare(`
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

    const hourlyRows = database.prepare(`
      SELECT
        hour_bucket,
        SUM(total_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        SUM(request_count) AS request_count
      FROM rollout_hourly_usage
      WHERE hour_bucket >= ?
      GROUP BY hour_bucket
      ORDER BY hour_bucket ASC
    `).all(formatHourBucket(hourlyStartDate)) as unknown as HourlyUsageRow[];

    const runRows = database.prepare(`
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

    const modelRows = database.prepare(`
      SELECT
        model_name,
        model_provider,
        SUM(total_tokens) AS total_tokens
      FROM rollout_hourly_model_usage
      WHERE hour_bucket >= ?
      GROUP BY model_name, model_provider
      ORDER BY total_tokens DESC, model_name ASC
    `).all(formatHourBucket(startDate)) as unknown as ModelUsageRow[];

    const lastSyncedRow = database.prepare(`
      SELECT finished_at
      FROM collector_runs
      WHERE status IN ('success', 'warning')
      ORDER BY id DESC
      LIMIT 1
    `).get() as { finished_at: string } | undefined;
    database.close();

    const dailyMap = new Map<string, DailyTokenPoint>();
    for (const row of dailyRows) {
      dailyMap.set(row.day, {
        day: row.day,
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        uncachedTokens: Math.max(0, row.total_tokens - row.cached_input_tokens),
        uncachedInputTokens: Math.max(0, row.input_tokens - row.cached_input_tokens),
        outputTokens: row.output_tokens
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

    const hourly = hourlyRows.map(mapHourlyUsageRow);
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
      collectorRuns: runRows.map(mapCollectorRunRow),
      lastSyncedAt: lastSyncedRow?.finished_at ?? null
    });
  }

  getOverviewTokens(rangeDays: number, now = new Date()): {
    todayTokens: TokenBreakdown;
    daily: DailyTokenPoint[];
    heatmapDaily: DailyTokenPoint[];
    averageTokens7d: TokenBreakdown;
    lastSyncedAt: string | null;
  } {
    const tokens = this.getTokens(Math.max(rangeDays, 365), now);
    const daily = tokens.daily.slice(-rangeDays);
    const averageTokens7d = createTokenBreakdown(
      Math.round(daily.reduce((sum, point) => sum + point.totalTokens, 0) / Math.max(daily.length, 1)),
      Math.round(daily.reduce((sum, point) => sum + point.cachedInputTokens, 0) / Math.max(daily.length, 1))
    );

    return {
      todayTokens: daily.at(-1)
        ? createTokenBreakdown(daily.at(-1)!.totalTokens, daily.at(-1)!.cachedInputTokens)
        : emptyTokenBreakdown(),
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

  private isRefreshNeeded(now: Date): boolean {
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

    return {
      totalRollouts: files.length,
      changedFiles,
      deletedPaths,
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
            output_tokens,
            reasoning_output_tokens,
            request_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertModelUsage = database.prepare(`
          INSERT INTO rollout_hourly_model_usage (
            rollout_path,
            hour_bucket,
            model_name,
            model_provider,
            total_tokens,
            request_count
          ) VALUES (?, ?, ?, ?, ?, ?)
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

    tokenEvents += 1;
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

    const delta = resolveUsageDelta(lastUsage, totalUsage, previousTotals);
    previousTotals = mergeUsageState(previousTotals, totalUsage);

    if (delta.totalTokens <= 0) {
      continue;
    }

    const hourBucket = formatHourBucket(timestamp);
    const accumulator = hourlyUsage.get(hourBucket) ?? createEmptyUsageAccumulator();
    accumulator.totalTokens += delta.totalTokens;
    accumulator.inputTokens += delta.inputTokens;
    accumulator.cachedInputTokens += delta.cachedInputTokens;
    accumulator.outputTokens += delta.outputTokens;
    accumulator.reasoningOutputTokens += delta.reasoningOutputTokens;
    accumulator.requestCount += 1;
    hourlyUsage.set(hourBucket, accumulator);

    const modelUsageKey = createModelUsageKey(hourBucket, currentModelName, currentModelProvider);
    const modelUsage = hourlyModelUsage.get(modelUsageKey)
      ?? createEmptyModelUsageAccumulator(hourBucket, currentModelName, currentModelProvider);
    modelUsage.totalTokens += delta.totalTokens;
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

    const inputTokens = readUsageNumber(usage, "input_tokens");
    const outputTokens = readUsageNumber(usage, "output_tokens");
    const cacheCreationTokens = readUsageNumber(usage, "cache_creation_input_tokens");
    const cacheReadTokens = readUsageNumber(usage, "cache_read_input_tokens");
    const cachedInputTokens = cacheCreationTokens + cacheReadTokens;
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

    if (totalTokens <= 0) {
      continue;
    }

    tokenEvents += 1;

    const hourBucket = formatHourBucket(timestamp);
    const accumulator = hourlyUsage.get(hourBucket) ?? createEmptyUsageAccumulator();
    accumulator.totalTokens += totalTokens;
    accumulator.inputTokens += inputTokens;
    accumulator.cachedInputTokens += cachedInputTokens;
    accumulator.outputTokens += outputTokens;
    accumulator.requestCount += 1;
    hourlyUsage.set(hourBucket, accumulator);

    const modelProvider = "anthropic";
    const modelUsageKey = createModelUsageKey(hourBucket, modelName, modelProvider);
    const modelUsage = hourlyModelUsage.get(modelUsageKey)
      ?? createEmptyModelUsageAccumulator(hourBucket, modelName, modelProvider);
    modelUsage.totalTokens += totalTokens;
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

function resolveMetricDelta(lastValue: number | null, currentTotal: number | null, previousTotal: number | null): number {
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

function createEmptyUsageAccumulator(): UsageAccumulator {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
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

function mapHourlyUsageRow(row: HourlyUsageRow): HourlyTokenUsage {
  return {
    hourBucket: row.hour_bucket,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    requestCount: row.request_count
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
    outputTokens: 0
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

function parseStatsCacheDailyUsage(value: unknown): StatsCacheDailyUsage[] {
  const record = isRecord(value) ? value : {};
  const dailyModelTokens = Array.isArray(record.dailyModelTokens) ? record.dailyModelTokens : [];
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
          totalTokens: normalizedTotal
        }];
      })
      .sort((left, right) => left.modelName.localeCompare(right.modelName));

    dailyUsage.push({
      hourBucket,
      totalTokens: modelUsage.reduce((sum, item) => sum + item.totalTokens, 0),
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
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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
