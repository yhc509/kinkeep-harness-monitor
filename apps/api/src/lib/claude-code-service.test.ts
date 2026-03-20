import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeDataService } from "./claude-code-service";
import { createProviderRegistry } from "./provider-registry";
import { createClaudeCodeTestFixture } from "../test-support/claude-fixture";

const fixtures: Array<ReturnType<typeof createClaudeCodeTestFixture>> = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("ClaudeCodeDataService", () => {
  it("reads Claude sessions, projects, and transcript details", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);
    const service = new ClaudeCodeDataService(fixture.config);

    const sessions = service.listSessions({ limit: 10 });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.provider).toBe("claude-code");
    expect(sessions[0]?.title).toBe("Investigate failing tests");
    expect(sessions[0]?.projectName).toBe("claudeproject");
    expect(sessions[0]?.source).toBe("tui");
    expect(sessions[0]?.tokensUsed).toBe(0);
    expect(sessions[0]?.modelProvider).toBe("anthropic");

    const projects = service.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      name: "claudeproject",
      sessionCount: 1,
      subagentCount: 0,
      lastSessionTitle: "Investigate failing tests"
    });

    const detail = service.getSessionDetail(fixture.primarySessionId);
    expect(detail?.provider).toBe("claude-code");
    expect(detail?.firstUserMessage).toBe("Investigate failing tests");
    expect(detail?.timeline.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "assistant_message",
      "tool_result",
      "event"
    ]);
    expect(detail?.timeline.find((item) => item.kind === "tool_call")?.toolName).toBe("Bash");
    expect(detail?.timeline.find((item) => item.kind === "tool_result")?.title).toBe("Tool result: Bash");
    expect(detail?.rolloutPath).toBe(fixture.primaryRolloutPath);

    const fallbackDetail = service.getSessionDetail(fixture.fallbackSessionId);
    expect(fallbackDetail?.provider).toBe("claude-code");
    expect(fallbackDetail?.title).toBe("Fallback transcript title");
    expect(fallbackDetail?.timeline.some((item) => item.kind === "assistant_message")).toBe(true);

    expect(service.getSessionRoot()).toBe(path.join(fixture.claudeHome, "projects"));
    expect(service.resolveProjectInfoForRolloutPath(fixture.primaryRolloutPath)?.projectName).toBe("claudeproject");
  });

  it("reads overview, memory, integrations, and registry wiring", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);
    const service = new ClaudeCodeDataService(fixture.config);

    const overview = service.getOverview({
      todayTokens: {
        totalTokens: 0,
        cachedInputTokens: 0,
        uncachedTokens: 0
      },
      daily: [],
      heatmapDaily: [],
      averageTokens7d: {
        totalTokens: 0,
        cachedInputTokens: 0,
        uncachedTokens: 0
      },
      lastSyncedAt: null
    });
    expect(overview.stats).toEqual({
      totalSessions: 2,
      activeToday: 0,
      totalSkills: 2,
      totalMcpServers: 2,
      totalHooks: 2,
      todayTokens: {
        totalTokens: 0,
        cachedInputTokens: 0,
        uncachedTokens: 0
      }
    });

    const memory = service.getMemory();
    expect(memory.sourceStatus).toBe("unsupported");
    expect(memory.modeCounts).toEqual([{ mode: "enabled", count: 2 }]);
    expect(memory.totalThreads).toBe(2);
    expect(memory.entries).toEqual([]);

    const integrations = service.getIntegrations();
    expect(integrations.mcpServers).toEqual([
      {
        name: "docs",
        url: null,
        usageCount: 0,
        toolNames: []
      },
      {
        name: "localtools",
        url: null,
        usageCount: 0,
        toolNames: []
      }
    ]);
    expect(integrations.skills.map((skill) => skill.name)).toEqual(["debugger", "planner"]);
    expect(integrations.hooks).toHaveLength(2);
    expect(integrations.lastSyncedAt).toBeNull();
    expect(integrations.isStale).toBe(false);

    const hookDetail = service.getHookDetail(integrations.hooks[0]!.id);
    expect(hookDetail?.command).toContain("echo");

    const skillDetail = service.getSkillDetail(integrations.skills[0]!.id);
    expect(skillDetail?.content).toContain("description:");

    const registry = createProviderRegistry(fixture.config);
    expect(registry.getProviders()).toHaveLength(1);
    expect(registry.getProviders()[0]?.id).toBe("claude-code");
  });
});
