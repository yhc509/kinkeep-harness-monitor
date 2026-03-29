import fs from "node:fs";
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
      providers: ["claude-code"],
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
    expect(detail?.timeline.filter((item) => item.kind === "user_message")).toHaveLength(1);
    expect(detail?.timeline.find((item) => item.kind === "tool_result")).toMatchObject({
      title: "Tool result: Bash",
      body: "1 failed assertion",
      metadata: { toolUseId: "toolu_1" }
    });
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
    expect(memory.sourceStatus).toBe("ready");
    expect(memory.modeCounts).toEqual([{ mode: "enabled", count: 2 }]);
    expect(memory.totalThreads).toBe(2);
    expect(memory.entries).toHaveLength(2);
    expect(memory.entries[0]?.provider).toBe("claude-code");
    expect(memory.stage1OutputCount).toBe(2);
    expect(memory.providerConfigs).toHaveLength(1);
    expect(memory.providerConfigs[0]).toMatchObject({
      provider: "claude-code",
      sourceStatus: "ready",
      entryCount: 2
    });

    const codingStyleEntry = memory.entries.find((entry) => entry.title === "Coding Style");
    expect(codingStyleEntry).toBeDefined();
    expect(codingStyleEntry!.rolloutSummary).toBe("Preferred coding conventions");
    expect(codingStyleEntry!.rawMemory).toContain("Use TypeScript strict mode");

    const notesEntry = memory.entries.find((entry) => entry.title === "notes");
    expect(notesEntry).toBeDefined();
    expect(notesEntry!.rawMemory).toContain("Remember this later");

    expect(memory.developerInstructions).toContain("# Project instructions");

    const integrations = service.getIntegrations();
    expect(integrations.mcpServers).toEqual([
      {
        name: "docs",
        source: "claude-code",
        url: null,
        usageCount: 0,
        toolNames: []
      },
      {
        name: "localtools",
        source: "claude-code",
        url: null,
        usageCount: 0,
        toolNames: []
      }
    ]);
    expect(integrations.skills.map((skill) => skill.name).sort()).toEqual(["debugger", "planner"]);
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

  it("splits mixed user content into user and tool timeline items", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);
    const service = new ClaudeCodeDataService(fixture.config);

    const detail = service.getSessionDetail(fixture.mixedContentSessionId);
    expect(detail?.provider).toBe("claude-code");
    expect(detail?.firstUserMessage).toBe("Review the failing tool output");
    expect(detail?.timeline.map((item) => item.kind)).toEqual([
      "user_message",
      "tool_result",
      "user_message"
    ]);
    expect(detail?.timeline[0]).toMatchObject({
      kind: "user_message",
      body: "Review the failing tool output"
    });
    expect(detail?.timeline[1]).toMatchObject({
      kind: "tool_result",
      title: "Tool result",
      body: "1 failed assertion",
      metadata: { toolUseId: "toolu_mixed" }
    });
    expect(detail?.timeline[2]).toMatchObject({
      kind: "user_message",
      body: "Summarize the next debugging step"
    });
  });

  it("omits user timeline items for empty content arrays", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);
    const service = new ClaudeCodeDataService(fixture.config);

    const detail = service.getSessionDetail(fixture.emptyContentSessionId);
    expect(detail?.provider).toBe("claude-code");
    expect(detail?.firstUserMessage).toBe("");
    expect(detail?.timeline.map((item) => item.kind)).toEqual(["assistant_message"]);
    expect(detail?.timeline.some((item) => item.kind === "user_message")).toBe(false);
    expect(detail?.timeline[0]).toMatchObject({
      kind: "assistant_message",
      body: "No visible user content to render."
    });
  });

  it("parses legacy top-level tool_result entries", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);

    const sessionId = "session-legacy-tool-result";
    const transcriptPath = path.join(fixture.claudeHome, "transcripts", `ses_${sessionId}.jsonl`);
    const cwd = path.join(fixture.rootDir, "workspace", "claudeproject", "app");

    fs.writeFileSync(transcriptPath, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_legacy",
              name: "Bash",
              input: {
                command: "pnpm test"
              }
            }
          ]
        },
        timestamp: "2026-03-15T05:00:00.000Z",
        sessionId,
        cwd,
        version: "1.0.0"
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_legacy",
        content: "legacy tool output",
        timestamp: "2026-03-15T05:00:01.000Z"
      }
    ].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

    const service = new ClaudeCodeDataService(fixture.config);
    const detail = service.getSessionDetail(sessionId);

    expect(detail?.timeline.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(detail?.timeline[1]).toMatchObject({
      kind: "tool_result",
      title: "Tool result: Bash",
      body: "legacy tool output",
      metadata: { toolUseId: "toolu_legacy" }
    });
  });

  it("includes symlinked skill directories and skips broken symlinks", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);

    const skillsDir = path.join(fixture.claudeHome, "skills");
    const symlinkedDirPath = path.join(skillsDir, "planner-link");
    const brokenSymlinkPath = path.join(skillsDir, "missing-link");

    fs.symlinkSync(path.join(skillsDir, "planner"), symlinkedDirPath, "dir");
    fs.symlinkSync(path.join(skillsDir, "missing-skill"), brokenSymlinkPath, "dir");

    const service = new ClaudeCodeDataService(fixture.config);
    const skills = service.getIntegrations().skills;

    expect(skills.map((skill) => skill.name).sort()).toEqual(["debugger", "planner", "planner"]);
    expect(skills.find((skill) => skill.id.includes("missing-link"))).toBeUndefined();
  });
});
