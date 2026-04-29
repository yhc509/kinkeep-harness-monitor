import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheBreaksResponseSchema, cacheTrendResponseSchema, type Provider } from "@codex-monitor/shared";
import { buildServer } from "../../server";
import { createTestFixture } from "../../test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];
const apps: FastifyInstance[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-14T19:10:00+09:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("token cache routes", () => {
  it("returns empty cache trend points", async () => {
    const { app } = await createAppWithCleanTokenCache();

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend"
    });

    expect(response.statusCode).toBe(200);
    const body = cacheTrendResponseSchema.parse(response.json());
    expect(body.points).toHaveLength(7);
    expect(body.points.every((point) => (
      point.hitRate === 0
      && point.totalInputTokens === 0
      && point.breakCount === 0
      && point.breakAvailability === "full"
    ))).toBe(true);
  });

  it("returns token-weighted cache trend points with break counts", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-a.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 5
      });
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-b.jsonl",
        hourBucket: "2026-03-14T12:00:00",
        inputTokens: 200,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 10
      });
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-c.jsonl",
        hourBucket: "2026-03-13T12:00:00",
        inputTokens: 50,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0
      });
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-a.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-14T10:30:00").getTime(),
        provider: "codex"
      });
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-b.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-14T12:30:00").getTime(),
        provider: "codex"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend"
    });

    expect(response.statusCode).toBe(200);
    const body = cacheTrendResponseSchema.parse(response.json());
    const point = body.points.find((entry) => entry.date === "2026-03-14");
    expect(point).toMatchObject({
      totalInputTokens: 300,
      breakCount: 2
    });
    expect(point?.hitRate).toBeCloseTo(70 / 300, 6);
  });

  it("applies cache trend ranges", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-old.jsonl",
        hourBucket: "2026-02-20T10:00:00",
        inputTokens: 80,
        cachedInputTokens: 40,
        cacheCreationInputTokens: 0
      });
    });

    const sevenDayResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?range=7d"
    });
    const thirtyDayResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?range=30d"
    });

    const sevenDayBody = cacheTrendResponseSchema.parse(sevenDayResponse.json());
    const thirtyDayBody = cacheTrendResponseSchema.parse(thirtyDayResponse.json());
    expect(sevenDayBody.points).toHaveLength(7);
    expect(sevenDayBody.points.find((point) => point.date === "2026-02-20")).toBeUndefined();
    expect(thirtyDayBody.points).toHaveLength(30);
    expect(thirtyDayBody.points.find((point) => point.date === "2026-02-20")).toMatchObject({
      hitRate: 0.5,
      totalInputTokens: 80
    });
  });

  it("filters cache trend points by provider", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-codex.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 0
      });
      insertUsage(database, {
        rolloutPath: "__claude-code-stats__",
        hourBucket: "2026-03-14T10:00:00",
        inputTokens: 200,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 20
      });
    });

    const allResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?provider=all"
    });
    const codexResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?provider=codex"
    });
    const claudeResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?provider=claude_code"
    });

    const allPoint = cacheTrendResponseSchema.parse(allResponse.json()).points.find((point) => point.date === "2026-03-14");
    const codexPoint = cacheTrendResponseSchema.parse(codexResponse.json()).points.find((point) => point.date === "2026-03-14");
    const claudePoint = cacheTrendResponseSchema.parse(claudeResponse.json()).points.find((point) => point.date === "2026-03-14");
    expect(allPoint).toMatchObject({
      totalInputTokens: 300
    });
    expect(allPoint?.hitRate).toBeCloseTo(150 / 300, 6);
    expect(codexPoint).toMatchObject({
      hitRate: 0.5,
      totalInputTokens: 100
    });
    expect(claudePoint).toMatchObject({
      hitRate: 0.5,
      totalInputTokens: 200
    });
  });

  it("marks stats-cache-only trend points as unavailable for break analysis", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertUsage(database, {
        rolloutPath: "__claude-code-stats__",
        hourBucket: "2026-03-14T00:00:00",
        inputTokens: 200,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 20,
        provider: "claude_code",
        dataSource: "stats_cache"
      });
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-codex.jsonl",
        hourBucket: "2026-03-13T10:00:00",
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 0,
        provider: "codex",
        dataSource: "jsonl"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?provider=all"
    });

    const body = cacheTrendResponseSchema.parse(response.json());
    expect(body.points.find((point) => point.date === "2026-03-14")).toMatchObject({
      breakAvailability: "none"
    });
    expect(body.points.find((point) => point.date === "2026-03-13")).toMatchObject({
      breakAvailability: "full"
    });
  });

  it("marks mixed jsonl and stats-cache trend points as partially available for break analysis", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertUsage(database, {
        rolloutPath: "__claude-code-stats__",
        hourBucket: "2026-03-14T00:00:00",
        inputTokens: 200,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 20,
        provider: "claude_code",
        dataSource: "stats_cache"
      });
      insertUsage(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-codex.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 0,
        provider: "codex",
        dataSource: "jsonl"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-trend?provider=all"
    });

    const body = cacheTrendResponseSchema.parse(response.json());
    expect(body.points.find((point) => point.date === "2026-03-14")).toMatchObject({
      totalInputTokens: 300,
      breakAvailability: "partial"
    });
  });

  it("returns empty cache break events", async () => {
    const { app } = await createAppWithCleanTokenCache();

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-breaks"
    });

    expect(response.statusCode).toBe(200);
    expect(cacheBreaksResponseSchema.parse(response.json())).toEqual({ events: [] });
  });

  it("returns cache break events with parsed evidence sorted newest first", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-a.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-14T10:00:00").getTime(),
        provider: "codex",
        evidence: { modelChanged: true }
      });
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-b.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-14T12:00:00").getTime(),
        provider: "claude_code",
        evidence: { ttlExpired: true }
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-breaks"
    });

    expect(response.statusCode).toBe(200);
    const body = cacheBreaksResponseSchema.parse(response.json());
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({
      provider: "claude_code",
      evidence: { ttlExpired: true },
      date: "2026-03-14"
    });
    expect(body.events[1]).toMatchObject({
      provider: "codex",
      evidence: { modelChanged: true },
      date: "2026-03-14"
    });
  });

  it("filters cache break events by date", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-a.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-13T10:00:00").getTime(),
        provider: "codex"
      });
      insertBreakEvent(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-b.jsonl",
        turnIndex: 1,
        ts: new Date("2026-03-14T10:00:00").getTime(),
        provider: "codex"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/cache-breaks?date=2026-03-13"
    });

    expect(response.statusCode).toBe(200);
    const body = cacheBreaksResponseSchema.parse(response.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      rolloutPath: "/tmp/.codex/sessions/rollout-a.jsonl",
      date: "2026-03-13"
    });
  });
});

async function createAppWithCleanTokenCache(): Promise<{ app: FastifyInstance; databasePath: string }> {
  const fixture = createTestFixture();
  fixtures.push(fixture);
  const app = await buildServer(fixture.config);
  apps.push(app);
  withDatabase(fixture.config.monitorDbPath, resetTokenCache);
  return {
    app,
    databasePath: fixture.config.monitorDbPath
  };
}

function withDatabase(databasePath: string, callback: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    callback(database);
  } finally {
    database.close();
  }
}

function resetTokenCache(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM cache_break_event;
    DELETE FROM rollout_hourly_usage;
    DELETE FROM rollout_hourly_model_usage;
    DELETE FROM tool_token_attribution;
  `);
}

function insertUsage(
  database: DatabaseSync,
  input: {
    rolloutPath: string;
    hourBucket: string;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    provider?: Provider;
    dataSource?: "jsonl" | "stats_cache";
  }
): void {
  const resolvedProvider = input.provider ?? (input.rolloutPath === "__claude-code-stats__" ? "claude_code" : "codex");
  const resolvedDataSource = input.dataSource ?? (input.rolloutPath === "__claude-code-stats__" ? "stats_cache" : "jsonl");
  database.prepare(`
    INSERT INTO rollout_hourly_usage (
      rollout_path,
      hour_bucket,
      provider,
      data_source,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rolloutPath,
    input.hourBucket,
    resolvedProvider,
    resolvedDataSource,
    "project",
    "Project",
    "/tmp/project",
    input.inputTokens,
    input.inputTokens,
    input.cachedInputTokens,
    input.cacheCreationInputTokens,
    Math.max(0, input.inputTokens - input.cachedInputTokens - input.cacheCreationInputTokens),
    0,
    0,
    1
  );
}

function insertBreakEvent(
  database: DatabaseSync,
  input: {
    rolloutPath: string;
    turnIndex: number;
    ts: number;
    provider: Provider;
    evidence?: Record<string, unknown>;
  }
): void {
  database.prepare(`
    INSERT INTO cache_break_event (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rolloutPath,
    input.turnIndex,
    input.ts,
    formatLocalDate(input.ts),
    input.provider,
    "gpt-5.4",
    0.9,
    0.1,
    0.8,
    "model_switch",
    "high",
    JSON.stringify(input.evidence ?? { cause: "model_switch" }),
    "1"
  );
}

function formatLocalDate(ts: number): string {
  const date = new Date(ts);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}
