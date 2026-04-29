import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  cacheBreaksResponseSchema,
  cacheTrendResponseSchema,
  type CacheBreakEvent,
  type CacheBreaksResponse,
  type CacheTrendResponse,
  type Provider
} from "@codex-monitor/shared";
import type { AppConfig } from "../../config";
import { formatDayKey, formatHourBucket, startOfLocalDay } from "../../lib/format";

const CLAUDE_CODE_STATS_ROLLOUT_PATH = "__claude-code-stats__";

type TokenRange = "7d" | "30d";
type TokenProviderFilter = "all" | Provider;

interface CacheTrendQuery {
  range: TokenRange;
  provider: TokenProviderFilter;
}

interface CacheBreaksQuery extends CacheTrendQuery {
  date?: string;
}

interface CacheTrendUsageRow {
  date: string;
  cache_tokens: number | null;
  total_input_tokens: number | null;
  jsonl_row_count: number | null;
  stats_cache_row_count: number | null;
}

interface CacheBreakCountRow {
  date: string;
  break_count: number;
}

interface CacheBreakEventRow {
  rollout_path: string;
  turn_index: number;
  ts: number;
  local_date: string;
  provider: Provider;
  model: string;
  prev_hit_rate: number;
  curr_hit_rate: number;
  dropped_pp: number;
  primary_cause: CacheBreakEvent["primaryCause"];
  confidence: CacheBreakEvent["confidence"];
  evidence_json: string;
  parse_version: string;
}

export function registerTokenCacheRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/tokens/cache-trend", async (request, reply) => {
    const query = parseCacheTrendQuery(request.query);
    if (!query) {
      return sendInvalidQuery(reply);
    }

    return getCacheTrend(config, query.range, query.provider, new Date());
  });

  app.get("/api/tokens/cache-breaks", async (request, reply) => {
    const query = parseCacheBreaksQuery(request.query);
    if (!query) {
      return sendInvalidQuery(reply);
    }

    return getCacheBreaks(config, query.range, query.provider, query.date, new Date());
  });
}

function getCacheTrend(
  config: AppConfig,
  range: TokenRange,
  provider: TokenProviderFilter,
  now: Date
): CacheTrendResponse {
  const rangeDays = range === "30d" ? 30 : 7;
  const today = startOfLocalDay(now);
  const startDate = startOfLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (rangeDays - 1)));
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const database = new DatabaseSync(config.monitorDbPath);
  const providerCase = providerCaseSql(config);

  try {
    const usageRows = database.prepare(`
      SELECT
        date,
        SUM(cache_tokens) AS cache_tokens,
        SUM(total_input_tokens) AS total_input_tokens,
        SUM(jsonl_row_count) AS jsonl_row_count,
        SUM(stats_cache_row_count) AS stats_cache_row_count
      FROM (
        SELECT
          substr(hour_bucket, 1, 10) AS date,
          cached_input_tokens AS cache_tokens,
          input_tokens AS total_input_tokens,
          CASE WHEN data_source = 'stats_cache' THEN 0 ELSE 1 END AS jsonl_row_count,
          CASE WHEN data_source = 'stats_cache' THEN 1 ELSE 0 END AS stats_cache_row_count,
          ${providerCase.sql} AS provider
        FROM rollout_hourly_usage
        WHERE hour_bucket >= ?
          AND hour_bucket < ?
      )
      WHERE (? = 'all' OR provider = ?)
      GROUP BY date
      ORDER BY date ASC
    `).all(
      ...providerCase.params,
      formatHourBucket(startDate),
      formatHourBucket(endDate),
      provider,
      provider
    ) as unknown as CacheTrendUsageRow[];

    const breakRows = database.prepare(`
      SELECT
        local_date AS date,
        COUNT(*) AS break_count
      FROM cache_break_event
      WHERE local_date >= ?
        AND local_date < ?
        AND (? = 'all' OR provider = ?)
      GROUP BY date
      ORDER BY date ASC
    `).all(formatDayKey(startDate), formatDayKey(endDate), provider, provider) as unknown as CacheBreakCountRow[];

    const usageByDate = new Map(usageRows.map((row) => [row.date, row]));
    const breakCountByDate = new Map(breakRows.map((row) => [row.date, row.break_count]));
    const points: CacheTrendResponse["points"] = [];

    for (let offset = 0; offset < rangeDays; offset += 1) {
      const date = formatDayKey(new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + offset));
      const usage = usageByDate.get(date);
      const totalInputTokens = Math.max(0, Math.trunc(usage?.total_input_tokens ?? 0));
      const cacheTokens = Math.max(0, usage?.cache_tokens ?? 0);
      const jsonlRowCount = Math.max(0, Math.trunc(usage?.jsonl_row_count ?? 0));
      const statsCacheRowCount = Math.max(0, Math.trunc(usage?.stats_cache_row_count ?? 0));
      points.push({
        date,
        hitRate: totalInputTokens > 0 ? Math.min(1, cacheTokens / totalInputTokens) : 0,
        totalInputTokens,
        breakCount: Math.max(0, Math.trunc(breakCountByDate.get(date) ?? 0)),
        breakAvailability: getBreakAvailability(jsonlRowCount, statsCacheRowCount)
      });
    }

    return cacheTrendResponseSchema.parse({ points });
  } finally {
    database.close();
  }
}

function getBreakAvailability(
  jsonlRowCount: number,
  statsCacheRowCount: number
): CacheTrendResponse["points"][number]["breakAvailability"] {
  if (jsonlRowCount > 0 && statsCacheRowCount > 0) {
    return "partial";
  }

  if (jsonlRowCount === 0 && statsCacheRowCount > 0) {
    return "none";
  }

  return "full";
}

function getCacheBreaks(
  config: AppConfig,
  range: TokenRange,
  provider: TokenProviderFilter,
  date: string | undefined,
  now: Date
): CacheBreaksResponse {
  const rangeDays = range === "30d" ? 30 : 7;
  const today = startOfLocalDay(now);
  const startDate = date
    ? parseDateKey(date, today)
    : startOfLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (rangeDays - 1)));
  const endDate = date
    ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const database = new DatabaseSync(config.monitorDbPath);

  try {
    const rows = database.prepare(`
      SELECT
        rollout_path,
        turn_index,
        ts,
        local_date,
        provider,
        model,
        prev_hit_rate,
        curr_hit_rate,
        dropped_pp,
        primary_cause,
        confidence,
        evidence_json,
        parse_version
      FROM cache_break_event
      WHERE local_date >= ?
        AND local_date < ?
        AND (? = 'all' OR provider = ?)
      ORDER BY ts DESC
    `).all(formatDayKey(startDate), formatDayKey(endDate), provider, provider) as unknown as CacheBreakEventRow[];

    return cacheBreaksResponseSchema.parse({
      events: rows.map(mapCacheBreakEventRow)
    });
  } finally {
    database.close();
  }
}

function mapCacheBreakEventRow(row: CacheBreakEventRow): CacheBreaksResponse["events"][number] {
  return {
    rolloutPath: row.rollout_path,
    turnIndex: row.turn_index,
    ts: row.ts,
    provider: row.provider,
    model: row.model,
    prevHitRate: row.prev_hit_rate,
    currHitRate: row.curr_hit_rate,
    droppedPp: row.dropped_pp,
    primaryCause: row.primary_cause,
    confidence: row.confidence,
    evidence: parseEvidence(row.evidence_json),
    parseVersion: row.parse_version,
    date: row.local_date
  };
}

function parseEvidence(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDateKey(value: string, fallback: Date): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return fallback;
  }

  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? fallback : startOfLocalDay(parsed);
}

function parseCacheTrendQuery(query: unknown): CacheTrendQuery | null {
  const record = isRecord(query) ? query : {};
  const range = parseTokenRange(record.range);
  const provider = parseProviderFilter(record.provider);

  if (!range || !provider) {
    return null;
  }

  return { range, provider };
}

function parseCacheBreaksQuery(query: unknown): CacheBreaksQuery | null {
  const parsed = parseCacheTrendQuery(query);
  if (!parsed) {
    return null;
  }

  const date = isRecord(query) && typeof query.date === "string" ? query.date : undefined;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  return {
    ...parsed,
    date
  };
}

function parseTokenRange(value: unknown): TokenRange | null {
  if (value === undefined) {
    return "7d";
  }

  return value === "7d" || value === "30d" ? value : null;
}

function parseProviderFilter(value: unknown): TokenProviderFilter | null {
  if (value === undefined) {
    return "all";
  }

  return value === "all" || value === "claude_code" || value === "codex" ? value : null;
}

function providerCaseSql(config: AppConfig): { sql: string; params: string[] } {
  const claudeHome = normalizePathBoundary(config.providers.claudeCode.home);
  const codexHome = normalizePathBoundary(config.providers.codex.codexHome);

  return {
    sql: `
    CASE
      WHEN provider = 'claude_code' THEN 'claude_code'
      WHEN provider = 'codex' THEN 'codex'
      WHEN rollout_path = ? OR rollout_path = ? OR substr(rollout_path, 1, length(?)) = ? THEN 'claude_code'
      WHEN rollout_path = ? OR substr(rollout_path, 1, length(?)) = ? THEN 'codex'
      ELSE 'codex'
    END
    `,
    params: [
      CLAUDE_CODE_STATS_ROLLOUT_PATH,
      claudeHome.root,
      claudeHome.childPrefix,
      claudeHome.childPrefix,
      codexHome.root,
      codexHome.childPrefix,
      codexHome.childPrefix
    ]
  };
}

function normalizePathBoundary(value: string): { root: string; childPrefix: string } {
  const root = path.resolve(value);
  return {
    root,
    childPrefix: root.endsWith(path.sep) ? root : `${root}${path.sep}`
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendInvalidQuery(reply: FastifyReply): { message: string } {
  reply.code(400);
  return { message: "Invalid query" };
}
