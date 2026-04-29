import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokensResponseSchema } from "@codex-monitor/shared";
import { buildServer } from "./server";
import { createTestFixture } from "./test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-14T19:10:00+09:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("API server", () => {
  it("returns the main API responses", async () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const app = await buildServer(fixture.config);

    const health = await app.inject({
      method: "GET",
      url: "/api/health"
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      provider: "codex",
      providers: ["codex"]
    });

    const snapshot = await app.inject({
      method: "POST",
      url: "/api/tokens/snapshot"
    });
    expect(snapshot.statusCode).toBe(200);

    const overview = await app.inject({
      method: "GET",
      url: "/api/overview"
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().collector).not.toBeNull();
    expect(overview.json().daily).toHaveLength(7);
    expect(overview.json().heatmapDaily).toHaveLength(365);
    expect(overview.json().stats.todayTokens).toEqual({
      totalTokens: 140,
      cachedInputTokens: 20,
      uncachedTokens: 120
    });
    expect(overview.json().todayCost).toBeCloseTo(0.000805, 8);
    expect(overview.json().cacheSavings.savedCost).toBeCloseTo(0.000045, 8);

    const session = await app.inject({
      method: "GET",
      url: "/api/sessions/thread-1"
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().provider).toBe("codex");
    expect(session.json().projectName).toBe("demo-project");
    expect(session.json().subagents).toHaveLength(2);

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects"
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()[0].providers).toEqual(["codex"]);
    expect(projects.json()[0].sessionCount).toBe(2);
    expect(projects.json()[0].subagentCount).toBe(2);

    const projectSessions = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projects.json()[0].id}`
    });
    expect(projectSessions.statusCode).toBe(200);
    expect(projectSessions.json()).toHaveLength(2);

    const projectSessionsWithSubagents = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projects.json()[0].id}&includeSubagents=true`
    });
    expect(projectSessionsWithSubagents.statusCode).toBe(200);
    expect(projectSessionsWithSubagents.json()).toHaveLength(4);

    const tokens = await app.inject({
      method: "GET",
      url: "/api/tokens?range=7"
    });
    expect(tokens.statusCode).toBe(200);
    const tokensJson = tokensResponseSchema.parse(tokens.json());
    expect(tokensJson.daily.some((entry) => entry.totalTokens === 140)).toBe(true);
    expect(tokensJson.dailyProviderTokens).toBeDefined();
    expect(tokensJson.dailyProviderTokens.some((entry) => entry.codexTokens === 140)).toBe(true);
    expect(tokensJson.toolUsage).toEqual([
      {
        provider: "codex",
        toolName: "mcp__openaiDeveloperDocs__search_openai_docs",
        callCount: 1
      },
      {
        provider: "codex",
        toolName: "spawn_agent",
        callCount: 1
      }
    ]);
    expect(tokensJson.patterns.dowHourHeatmap).toEqual([
      {
        dow: 6,
        hour: 19,
        totalTokens: 140,
        requestCount: 1
      }
    ]);
    expect(tokensJson.patterns.hourOfDayAverages).toEqual([
      {
        hour: 19,
        avgTokens: 140,
        avgRequests: 1,
        sampleDays: 1
      }
    ]);
    expect(tokensJson.patterns.hourOfDayCacheHit).toHaveLength(1);
    expect(tokensJson.patterns.hourOfDayCacheHit[0]).toMatchObject({
      hour: 19,
      sampleRequests: 1
    });
    expect(tokensJson.patterns.hourOfDayCacheHit[0].hitRate).toBeCloseTo(0.2, 6);
    expect(tokensJson.patterns.sessionDuration.startHistogram).toEqual([
      {
        hour: 19,
        count: 1
      }
    ]);
    expect(tokensJson.patterns.sessionDuration.durationBuckets[0]).toEqual({
      bucketMin: 0,
      bucketMax: 30,
      count: 1
    });
    expect(tokensJson.modelUsage).toEqual([
      {
        modelName: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 140
      }
    ]);

    const projectUsage = await app.inject({
      method: "GET",
      url: "/api/tokens/project-usage?unit=day&anchor=2026-03-14"
    });
    expect(projectUsage.statusCode).toBe(200);
    expect(projectUsage.json().unit).toBe("day");
    expect(projectUsage.json().projects[0].projectName).toBe("demo-project");

    const integrations = await app.inject({
      method: "GET",
      url: "/api/integrations"
    });
    expect(integrations.statusCode).toBe(200);

    const hookDetail = await app.inject({
      method: "GET",
      url: `/api/integrations/hooks/${encodeURIComponent(integrations.json().hooks[0].id)}`
    });
    expect(hookDetail.statusCode).toBe(200);
    expect(hookDetail.json().command).toContain("notify-hook.js");

    const skillDetail = await app.inject({
      method: "GET",
      url: `/api/integrations/skills/${encodeURIComponent(integrations.json().skills[0].id)}`
    });
    expect(skillDetail.statusCode).toBe(200);
    expect(skillDetail.json().content).toContain("description:");

    const refreshIntegrations = await app.inject({
      method: "POST",
      url: "/api/integrations/refresh"
    });
    expect(refreshIntegrations.statusCode).toBe(200);
    expect(refreshIntegrations.json().lastSyncedAt).not.toBeNull();

    await app.close();
  });

  it("returns empty token usage patterns when rollout hourly usage is empty", async () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const app = await buildServer(fixture.config);
    const database = new DatabaseSync(fixture.config.monitorDbPath);
    database.exec(`
      DELETE FROM rollout_hourly_model_usage;
      DELETE FROM rollout_hourly_usage;
      DELETE FROM tool_token_attribution;
    `);
    database.close();

    const tokens = await app.inject({
      method: "GET",
      url: "/api/tokens?range=7"
    });

    expect(tokens.statusCode).toBe(200);
    expect(tokens.json().currentHourTokens).toEqual({
      totalTokens: 0,
      cachedInputTokens: 0,
      uncachedTokens: 0
    });
    expect(tokens.json().daily.every((entry: { totalTokens: number }) => entry.totalTokens === 0)).toBe(true);
    expect(tokens.json().hourly).toEqual([]);
    expect(tokens.json().toolUsage).toEqual([]);
    expect(tokens.json().patterns).toEqual({
      dowHourHeatmap: [],
      hourOfDayAverages: [],
      hourOfDayCacheHit: [],
      sessionDuration: {
        startHistogram: [],
        durationBuckets: []
      }
    });

    await app.close();
  });

  it("does not double-count overview todayTokens when all providers are active", async () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    fixture.config.activeProviderIds = ["codex", "claude-code"];

    const app = await buildServer(fixture.config);

    const snapshot = await app.inject({
      method: "POST",
      url: "/api/tokens/snapshot"
    });
    expect(snapshot.statusCode).toBe(200);

    const overview = await app.inject({
      method: "GET",
      url: "/api/overview"
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().stats.todayTokens).toEqual({
      totalTokens: 140,
      cachedInputTokens: 20,
      uncachedTokens: 120
    });
    expect(overview.json().todayCost).toBeCloseTo(0.000805, 8);

    await app.close();
  });
});
