import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server";
import { createTestFixture } from "./test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("API server", () => {
  it("returns the main API responses", async () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

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
    expect(overview.json().collector).not.toBeNull();
    expect(overview.json().daily).toHaveLength(7);
    expect(overview.json().heatmapDaily).toHaveLength(365);
    expect(overview.json().stats.todayTokens).toEqual({
      totalTokens: 0,
      cachedInputTokens: 0,
      uncachedTokens: 0
    });

    const session = await app.inject({
      method: "GET",
      url: "/api/sessions/thread-1"
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().projectName).toBe("demo-project");
    expect(session.json().subagents).toHaveLength(2);

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects"
    });
    expect(projects.statusCode).toBe(200);
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
    expect(tokens.json().daily.some((entry: { totalTokens: number }) => entry.totalTokens === 140)).toBe(true);
    expect(tokens.json().modelUsage).toEqual([
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
});
