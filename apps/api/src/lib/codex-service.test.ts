import { afterEach, describe, expect, it } from "vitest";
import { CodexDataService } from "./codex-service";
import { createTestFixture } from "../test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("CodexDataService", () => {
  it("reads session lists and details with project metadata", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const sessions = service.listSessions({ limit: 10 });
    expect(sessions).toHaveLength(4);
    expect(sessions[0]?.provider).toBe("codex");
    expect(sessions[0]?.title).toBe("Demo session");
    expect(sessions[0]?.projectName).toBe("demo-project");

    const detail = service.getSessionDetail("thread-1");
    expect(detail?.provider).toBe("codex");
    expect(detail?.timeline.some((item) => item.kind === "user_message")).toBe(true);
    expect(detail?.tokenSeries[0]?.totalTokens).toBe(140);
    expect(detail?.projectPath.endsWith("/workspace/demo-project")).toBe(true);
    expect(detail?.subagents).toHaveLength(2);
    expect(detail?.subagents[0]?.subagentNickname).toBe("Boyle");
    expect(detail?.subagents[1]?.subagentRole).toBe("explorer");
    expect(detail?.timeline.find((item) => item.kind === "tool_call" && item.toolName === "spawn_agent")?.metadata.callId).toBe("call-spawn-1");
    expect(detail?.timeline.find((item) => item.kind === "tool_result" && item.toolName === "spawn_agent")?.title).toBe("Tool output: spawn_agent");
  });

  it("groups projects by git root first and hides subagents in the default list", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const projects = service.listProjects();
    expect(projects).toHaveLength(3);
    expect(projects[0]?.name).toBe("demo-project");
    expect(projects[0]?.sessionCount).toBe(2);
    expect(projects[0]?.subagentCount).toBe(2);

    const gitSessions = service.listSessions({ projectId: projects[0]?.id });
    expect(gitSessions).toHaveLength(2);
    expect(new Set(gitSessions.map((session) => session.projectPath)).size).toBe(1);
    expect(gitSessions.every((session) => !session.isSubagent)).toBe(true);

    const gitSessionsWithSubagents = service.listSessions({ projectId: projects[0]?.id, includeSubagents: true });
    expect(gitSessionsWithSubagents).toHaveLength(4);
    expect(gitSessionsWithSubagents.filter((session) => session.isSubagent)).toHaveLength(2);
    expect(gitSessionsWithSubagents.find((session) => session.id === "thread-5")?.parentThreadId).toBe("thread-1");

    const standalone = projects.find((project) => project.name === "scratchpad");
    expect(standalone?.path.endsWith("/scratchpad")).toBe(true);
  });

  it("returns parent session information for subagent detail", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const detail = service.getSessionDetail("thread-5");
    expect(detail?.isSubagent).toBe(true);
    expect(detail?.parentSessionId).toBe("thread-1");
    expect(detail?.parentSessionTitle).toBe("Demo session");
    expect(detail?.subagentNickname).toBe("Noether");
    expect(detail?.subagents).toHaveLength(0);
  });

  it("reads memory and integration data", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const memory = service.getMemory();
    expect(memory.entries[0]?.rawMemory).toBe("Remembered memory");
    expect(memory.entries[0]?.provider).toBe("codex");
    expect(memory.sourceStatus).toBe("ready");
    expect(memory.stage1OutputCount).toBe(1);
    expect(memory.developerInstructions).toContain("root causes");
    expect(memory.personality).toBe("friendly");
    expect(memory.providerConfigs).toHaveLength(1);
    expect(memory.providerConfigs[0]).toMatchObject({ provider: "codex", sourceStatus: "ready" });

    service.refreshIntegrationsUsage(new Date("2026-03-14T10:15:00+09:00"));
    const integrations = service.getIntegrations();
    expect(integrations.hooks[0]?.name).toBe("notify");
    expect(integrations.hooks[0]?.preview).toContain("notify-hook");
    expect(integrations.mcpServers[0]?.name).toBe("openaiDeveloperDocs");
    expect(integrations.mcpServers[0]?.source).toBe("codex");
    expect(integrations.mcpServers[0]?.usageCount).toBe(1);
    expect(integrations.skills).toHaveLength(2);
    expect(integrations.lastSyncedAt).not.toBeNull();
    expect(integrations.isStale).toBe(false);

    const hookDetail = service.getHookDetail(integrations.hooks[0]!.id);
    expect(hookDetail?.command).toContain("notify-hook.js");

    const skillDetail = service.getSkillDetail(integrations.skills[0]!.id);
    expect(skillDetail?.content).toContain("description:");
  });

  it("distinguishes memory source states", () => {
    const emptyFixture = createTestFixture({ stage1Mode: "empty" });
    fixtures.push(emptyFixture);
    const emptyService = new CodexDataService(emptyFixture.config);
    const emptyMemory = emptyService.getMemory();
    expect(emptyMemory.sourceStatus).toBe("empty");
    expect(emptyMemory.stage1OutputCount).toBe(0);
    expect(emptyMemory.developerInstructions).toContain("Respond in English");

    const unsupportedFixture = createTestFixture({ stage1Mode: "unsupported" });
    fixtures.push(unsupportedFixture);
    const unsupportedService = new CodexDataService(unsupportedFixture.config);
    const unsupportedMemory = unsupportedService.getMemory();
    expect(unsupportedMemory.sourceStatus).toBe("unsupported");
    expect(unsupportedMemory.hasStage1OutputsTable).toBe(false);
    expect(unsupportedMemory.personality).toBe("friendly");
  });
});
