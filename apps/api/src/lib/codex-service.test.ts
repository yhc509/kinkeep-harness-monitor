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
  it("세션 목록과 상세를 읽고 프로젝트 정보를 붙인다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const sessions = service.listSessions({ limit: 10 });
    expect(sessions).toHaveLength(4);
    expect(sessions[0]?.title).toBe("데모 세션");
    expect(sessions[0]?.projectName).toBe("demo-project");

    const detail = service.getSessionDetail("thread-1");
    expect(detail?.timeline.some((item) => item.kind === "user_message")).toBe(true);
    expect(detail?.tokenSeries[0]?.totalTokens).toBe(140);
    expect(detail?.projectPath.endsWith("/workspace/demo-project")).toBe(true);
    expect(detail?.subagents).toHaveLength(2);
    expect(detail?.subagents[0]?.subagentNickname).toBe("Boyle");
    expect(detail?.subagents[1]?.subagentRole).toBe("explorer");
  });

  it("프로젝트를 git 루트 우선으로 묶고, 기본 목록에서는 서브에이전트를 숨긴다", () => {
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

  it("서브에이전트 상세에서는 부모 세션 정보를 준다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const detail = service.getSessionDetail("thread-5");
    expect(detail?.isSubagent).toBe(true);
    expect(detail?.parentSessionId).toBe("thread-1");
    expect(detail?.parentSessionTitle).toBe("데모 세션");
    expect(detail?.subagentNickname).toBe("Noether");
    expect(detail?.subagents).toHaveLength(0);
  });

  it("메모리와 통합 정보를 읽는다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    const service = new CodexDataService(fixture.config);

    const memory = service.getMemory();
    expect(memory.entries[0]?.rawMemory).toBe("기억된 메모리");
    expect(memory.sourceStatus).toBe("ready");
    expect(memory.stage1OutputCount).toBe(1);

    service.refreshIntegrationsUsage(new Date("2026-03-14T10:15:00+09:00"));
    const integrations = service.getIntegrations();
    expect(integrations.hooks[0]?.name).toBe("notify");
    expect(integrations.hooks[0]?.preview).toContain("notify-hook");
    expect(integrations.mcpServers[0]?.name).toBe("openaiDeveloperDocs");
    expect(integrations.mcpServers[0]?.usageCount).toBe(1);
    expect(integrations.skills).toHaveLength(2);
    expect(integrations.lastSyncedAt).not.toBeNull();
    expect(integrations.isStale).toBe(false);

    const hookDetail = service.getHookDetail(integrations.hooks[0]!.id);
    expect(hookDetail?.command).toContain("notify-hook.js");

    const skillDetail = service.getSkillDetail(integrations.skills[0]!.id);
    expect(skillDetail?.content).toContain("description:");
  });

  it("메모리 source 상태를 구분한다", () => {
    const emptyFixture = createTestFixture({ stage1Mode: "empty" });
    fixtures.push(emptyFixture);
    const emptyService = new CodexDataService(emptyFixture.config);
    const emptyMemory = emptyService.getMemory();
    expect(emptyMemory.sourceStatus).toBe("empty");
    expect(emptyMemory.stage1OutputCount).toBe(0);

    const unsupportedFixture = createTestFixture({ stage1Mode: "unsupported" });
    fixtures.push(unsupportedFixture);
    const unsupportedService = new CodexDataService(unsupportedFixture.config);
    const unsupportedMemory = unsupportedService.getMemory();
    expect(unsupportedMemory.sourceStatus).toBe("unsupported");
    expect(unsupportedMemory.hasStage1OutputsTable).toBe(false);
  });
});
