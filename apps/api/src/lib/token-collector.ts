import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CollectorRun,
  DailyTokenPoint,
  HourlyTokenUsage,
  TokenBreakdown,
  TokenSyncResult,
  TokenSyncStats,
  TokensResponse
} from "@codex-monitor/shared";
import { tokenSyncResultSchema, tokensResponseSchema } from "@codex-monitor/shared";
import type { AppConfig } from "../config";
import { formatDayKey, formatHourBucket, startOfLocalDay, startOfLocalHour, toLocalDateTime } from "./format";
import type { CodexDataService } from "./codex-service";

const CACHE_PARSE_VERSION = "2";
const HOURLY_DEBUG_WINDOW_HOURS = 48;
const TOKEN_CACHE_STALE_MS = 5 * 60 * 1000;

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
  hourlyUsage: Map<string, UsageAccumulator>;
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

export class TokenCollectorService {
  private usageRefreshPromise: Promise<SnapshotResult> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly codexService: CodexDataService
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
        total_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (rollout_path, hour_bucket)
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
    database.close();
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

    const hourly = hourlyRows.map(mapHourlyUsageRow);
    const currentHour = hourly.find((entry) => entry.hourBucket === currentHourBucket);
    const currentHourTokens = currentHour
      ? createTokenBreakdown(currentHour.totalTokens, currentHour.cachedInputTokens)
      : emptyTokenBreakdown();

    return tokensResponseSchema.parse({
      rangeDays,
      currentHourTokens,
      daily,
      hourly,
      collectorRuns: runRows.map(mapCollectorRunRow),
      lastSyncedAt: lastSyncedRow?.finished_at ?? null
    });
  }

  getOverviewTokens(rangeDays: number, now = new Date()): {
    todayTokens: TokenBreakdown;
    daily: DailyTokenPoint[];
    averageTokens7d: TokenBreakdown;
    lastSyncedAt: string | null;
  } {
    const tokens = this.getTokens(rangeDays, now);
    const averageTokens7d = createTokenBreakdown(
      Math.round(tokens.daily.reduce((sum, point) => sum + point.totalTokens, 0) / Math.max(tokens.daily.length, 1)),
      Math.round(tokens.daily.reduce((sum, point) => sum + point.cachedInputTokens, 0) / Math.max(tokens.daily.length, 1))
    );

    return {
      todayTokens: tokens.daily.at(-1)
        ? createTokenBreakdown(tokens.daily.at(-1)!.totalTokens, tokens.daily.at(-1)!.cachedInputTokens)
        : emptyTokenBreakdown(),
      daily: tokens.daily,
      averageTokens7d,
      lastSyncedAt: tokens.lastSyncedAt
    };
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
    const files = scanRolloutFiles(this.codexService.getSessionRoot());
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
      .filter((rolloutPath) => !currentPaths.has(rolloutPath));

    return {
      totalRollouts: files.length,
      changedFiles,
      deletedPaths,
      hasCache: usageCount.count > 0 || indexedRows.length > 0
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
        database.prepare(`DELETE FROM rollout_index_state WHERE rollout_path = ?`).run(rolloutPath);
      }

      for (const file of preparation.changedFiles) {
        const parsed = parseRolloutUsage(file.rolloutPath);
        database.prepare(`DELETE FROM rollout_hourly_usage WHERE rollout_path = ?`).run(file.rolloutPath);

        const insertUsage = database.prepare(`
          INSERT INTO rollout_hourly_usage (
            rollout_path,
            hour_bucket,
            total_tokens,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            request_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const [hourBucket, usage] of parsed.hourlyUsage.entries()) {
          insertUsage.run(
            file.rolloutPath,
            hourBucket,
            usage.totalTokens,
            usage.inputTokens,
            usage.cachedInputTokens,
            usage.outputTokens,
            usage.reasoningOutputTokens,
            usage.requestCount
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
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
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
    return "변경 없음 · 기존 토큰 캐시 유지";
  }

  return [
    "토큰 캐시 동기화 완료",
    `전체 ${stats.totalRollouts}개`,
    `갱신 ${stats.updatedRollouts}개`,
    `삭제 ${stats.deletedRollouts}개`,
    `이벤트 ${stats.tokenEvents.toLocaleString()}건`
  ].join(" · ");
}

function parseRolloutUsage(rolloutPath: string): ParsedRolloutUsage {
  const text = fs.readFileSync(rolloutPath, "utf8");
  const lines = text.split("\n");
  const hourlyUsage = new Map<string, UsageAccumulator>();
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
      throw new Error(`rollout 파싱 실패: ${rolloutPath}\n${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }

    if (parsed.type !== "event_msg") {
      continue;
    }

    const payload = parsed.payload ?? {};
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
  }

  return {
    hourlyUsage,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
