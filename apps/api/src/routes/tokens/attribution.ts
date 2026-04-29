import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  subagentAttributionResponseSchema,
  toolAttributionResponseSchema,
  type Provider,
  type SubagentAttributionResponse,
  type ToolAttributionResponse
} from "@codex-monitor/shared";
import type { AppConfig } from "../../config";
import { formatHourBucket, startOfLocalDay } from "../../lib/format";

type AttributionRange = "7d" | "30d" | "90d";
type AttributionProviderFilter = "all" | Provider;
type StoredToolProvider = "claude-code" | "codex";

interface AttributionQuery {
  range: AttributionRange;
  provider: AttributionProviderFilter;
}

interface ToolAttributionRow {
  provider: StoredToolProvider;
  tool_name: string;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
}

interface RolloutAttributionRow {
  rollout_path: string;
  provider: StoredToolProvider;
  input_tokens: number;
  output_tokens: number;
}

interface ThreadMetaRow {
  id: string;
  rollout_path: string;
  source: string;
}

interface RolloutSessionMeta {
  sessionId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
}

export function registerTokenAttributionRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/tokens/tool-attribution", async (request, reply) => {
    const query = parseAttributionQuery(request.query);
    if (!query) {
      return sendInvalidQuery(reply);
    }

    return getToolAttribution(config, query.range, query.provider, new Date());
  });

  app.get("/api/tokens/subagent-attribution", async (request, reply) => {
    const query = parseAttributionQuery(request.query);
    if (!query) {
      return sendInvalidQuery(reply);
    }

    return getSubagentAttribution(config, query.range, query.provider, new Date());
  });
}

function getToolAttribution(
  config: AppConfig,
  range: AttributionRange,
  provider: AttributionProviderFilter,
  now: Date
): ToolAttributionResponse {
  const database = new DatabaseSync(config.monitorDbPath);
  const startHourBucket = getStartHourBucket(range, now);
  const storedProvider = toStoredProviderFilter(provider);

  try {
    const rows = database.prepare(`
      SELECT
        provider,
        tool_name,
        COALESCE(SUM(call_count), 0) AS call_count,
        COALESCE(SUM(attributed_input_tokens), 0) AS input_tokens,
        COALESCE(SUM(attributed_output_tokens), 0) AS output_tokens
      FROM tool_token_attribution
      WHERE hour_bucket >= ?
        AND (? = 'all' OR provider = ?)
      GROUP BY provider, tool_name
      ORDER BY (input_tokens + output_tokens) DESC, call_count DESC, tool_name ASC
    `).all(startHourBucket, storedProvider, storedProvider) as unknown as ToolAttributionRow[];

    return toolAttributionResponseSchema.parse({
      tools: rows.map((row) => ({
        toolName: row.tool_name,
        provider: toResponseProvider(row.provider),
        callCount: Math.max(0, Math.trunc(row.call_count)),
        inputTokens: Math.max(0, Math.trunc(row.input_tokens)),
        outputTokens: Math.max(0, Math.trunc(row.output_tokens)),
        estimated: row.provider === "codex"
      }))
    });
  } finally {
    database.close();
  }
}

function getSubagentAttribution(
  config: AppConfig,
  range: AttributionRange,
  provider: AttributionProviderFilter,
  now: Date
): SubagentAttributionResponse {
  const database = new DatabaseSync(config.monitorDbPath);
  const startHourBucket = getStartHourBucket(range, now);
  const storedProvider = toStoredProviderFilter(provider);
  const codexSessionMeta = readCodexSessionMeta(config);

  try {
    const rows = database.prepare(`
      SELECT
        rollout_path,
        provider,
        COALESCE(SUM(attributed_input_tokens), 0) AS input_tokens,
        COALESCE(SUM(attributed_output_tokens), 0) AS output_tokens
      FROM tool_token_attribution
      WHERE hour_bucket >= ?
        AND (? = 'all' OR provider = ?)
      GROUP BY rollout_path, provider
    `).all(startHourBucket, storedProvider, storedProvider) as unknown as RolloutAttributionRow[];

    const root = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const subagents = new Map<string, SubagentAttributionResponse["subagents"][number]>();

    for (const row of rows) {
      const inputTokens = Math.max(0, Math.trunc(row.input_tokens));
      const outputTokens = Math.max(0, Math.trunc(row.output_tokens));
      const totalTokens = inputTokens + outputTokens;
      const providerName = toResponseProvider(row.provider);
      const meta = row.provider === "codex" ? codexSessionMeta.get(row.rollout_path) : undefined;

      if (!meta?.isSubagent) {
        root.inputTokens += inputTokens;
        root.outputTokens += outputTokens;
        root.totalTokens += totalTokens;
        continue;
      }

      const key = `${providerName}:${meta.sessionId}`;
      const entry = subagents.get(key) ?? {
        sessionId: meta.sessionId,
        parentSessionId: meta.parentSessionId,
        provider: providerName,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimated: row.provider === "codex"
      };
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.totalTokens += totalTokens;
      subagents.set(key, entry);
    }

    return subagentAttributionResponseSchema.parse({
      root,
      subagents: Array.from(subagents.values())
        .sort((left, right) => right.totalTokens - left.totalTokens || left.sessionId.localeCompare(right.sessionId))
    });
  } finally {
    database.close();
  }
}

function readCodexSessionMeta(config: AppConfig): Map<string, RolloutSessionMeta> {
  const stateDbPath = resolveLatestSqliteOrNull(config.providers.codex.codexHome, /^state_\d+\.sqlite$/);
  if (!stateDbPath) {
    return new Map();
  }

  const database = new DatabaseSync(stateDbPath);
  try {
    const rows = database.prepare(`
      SELECT
        id,
        rollout_path,
        source
      FROM threads
    `).all() as unknown as ThreadMetaRow[];

    return new Map(rows.map((row) => {
      const sourceInfo = parseCodexSourceInfo(row.source);
      return [row.rollout_path, {
        sessionId: row.id,
        isSubagent: sourceInfo.isSubagent,
        parentSessionId: sourceInfo.parentSessionId
      }];
    }));
  } catch {
    return new Map();
  } finally {
    database.close();
  }
}

function parseCodexSourceInfo(value: string): { isSubagent: boolean; parentSessionId: string | null } {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = isRecord(parsed) ? parsed : {};
    const subagent = isRecord(record.subagent) ? record.subagent : {};
    const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : {};
    const parentThreadId = typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : null;
    return {
      isSubagent: Boolean(parentThreadId),
      parentSessionId: parentThreadId
    };
  } catch {
    return {
      isSubagent: false,
      parentSessionId: null
    };
  }
}

function getStartHourBucket(range: AttributionRange, now: Date): string {
  const rangeDays = range === "90d" ? 90 : range === "30d" ? 30 : 7;
  const today = startOfLocalDay(now);
  return formatHourBucket(startOfLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (rangeDays - 1))));
}

function parseAttributionQuery(query: unknown): AttributionQuery | null {
  const record = isRecord(query) ? query : {};
  const range = parseAttributionRange(record.range);
  const provider = parseProviderFilter(record.provider);

  if (!range || !provider) {
    return null;
  }

  return { range, provider };
}

function parseAttributionRange(value: unknown): AttributionRange | null {
  if (value === undefined) {
    return "7d";
  }

  return value === "7d" || value === "30d" || value === "90d" ? value : null;
}

function parseProviderFilter(value: unknown): AttributionProviderFilter | null {
  if (value === undefined) {
    return "all";
  }

  return value === "all" || value === "claude_code" || value === "codex" ? value : null;
}

function toStoredProviderFilter(provider: AttributionProviderFilter): StoredToolProvider | "all" {
  return provider === "claude_code" ? "claude-code" : provider;
}

function toResponseProvider(provider: StoredToolProvider): Provider {
  return provider === "claude-code" ? "claude_code" : "codex";
}

function resolveLatestSqliteOrNull(baseDir: string, pattern: RegExp): string | null {
  if (!fs.existsSync(baseDir)) {
    return null;
  }

  const files = fs.readdirSync(baseDir)
    .filter((entry) => pattern.test(entry))
    .sort((left, right) => extractNumericSuffix(right) - extractNumericSuffix(left));

  return files[0] ? path.join(baseDir, files[0]) : null;
}

function extractNumericSuffix(fileName: string): number {
  const match = fileName.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendInvalidQuery(reply: FastifyReply): { message: string } {
  reply.code(400);
  return { message: "Invalid query" };
}
