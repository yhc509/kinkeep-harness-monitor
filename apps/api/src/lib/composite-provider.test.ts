import { describe, expect, it, vi } from "vitest";
import type {
  HookDetail,
  IntegrationsResponse,
  MemoryResponse,
  OverviewResponse,
  ProjectSummary,
  SessionDetail,
  SessionListItem,
  SkillDetail
} from "@codex-monitor/shared";
import type { ProviderId } from "../config";
import { CompositeProvider } from "./composite-provider";
import type { MonitorProviderAdapter, OverviewTokenSnapshot } from "./provider-adapter";
import type { ResolvedProjectInfo } from "./project-resolver";

const OVERVIEW_TOKENS: OverviewTokenSnapshot = {
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
};

describe("CompositeProvider", () => {
  it("merges sessions and projects across providers", () => {
    const sessionA = createSession("session-a", {
      provider: "codex",
      title: "Codex session",
      projectId: "shared-project",
      projectName: "Shared",
      projectPath: "/workspace/shared",
      updatedAt: "2026-03-14T10:00:00.000Z",
      tokensUsed: 50
    });
    const subagentA = createSession("session-a-subagent", {
      provider: "codex",
      title: "Codex subagent",
      projectId: "shared-project",
      projectName: "Shared",
      projectPath: "/workspace/shared",
      isSubagent: true,
      parentThreadId: "session-a",
      subagentNickname: "Noether",
      updatedAt: "2026-03-14T11:00:00.000Z"
    });
    const sessionB = createSession("session-b", {
      provider: "claude-code",
      title: "Claude session",
      projectId: "shared-project",
      projectName: "Shared",
      projectPath: "/workspace/shared",
      cwd: "/workspace/shared/claude",
      updatedAt: "2026-03-14T12:00:00.000Z",
      tokensUsed: 30
    });
    const sessionC = createSession("session-c", {
      provider: "claude-code",
      title: "Standalone Claude session",
      projectId: "claude-project",
      projectName: "Claude Project",
      projectPath: "/workspace/claude-project",
      cwd: "/workspace/claude-project",
      updatedAt: "2026-03-13T12:00:00.000Z"
    });

    const providerA = createProvider({
      id: "codex",
      sessions: [sessionA, subagentA],
      projects: [
        createProject("shared-project", {
          name: "Shared",
          path: "/workspace/shared",
          sessionCount: 1,
          subagentCount: 1,
          updatedAt: "2026-03-14T10:00:00.000Z",
          lastSessionTitle: "Codex session"
        })
      ],
      sessionDetails: {
        "session-a": createSessionDetail(sessionA),
        "session-a-subagent": createSessionDetail(subagentA)
      }
    });
    const providerB = createProvider({
      id: "claude-code",
      sessions: [sessionB, sessionC],
      projects: [
        createProject("shared-project", {
          name: "Shared",
          path: "/workspace/shared",
          sessionCount: 2,
          subagentCount: 0,
          updatedAt: "2026-03-14T12:00:00.000Z",
          lastSessionTitle: "Claude session"
        }),
        createProject("claude-project", {
          name: "Claude Project",
          path: "/workspace/claude-project",
          sessionCount: 1,
          subagentCount: 0,
          updatedAt: "2026-03-13T12:00:00.000Z",
          lastSessionTitle: "Standalone Claude session"
        })
      ],
      sessionDetails: {
        "session-b": createSessionDetail(sessionB)
      }
    });

    const composite = new CompositeProvider([providerA.provider, providerB.provider]);

    expect(composite.id).toBe("codex");
    expect(composite.listSessions().map((session) => session.id)).toEqual([
      "session-b",
      "session-a",
      "session-c"
    ]);
    expect(composite.listSessions({
      includeSubagents: true,
      query: "noether"
    }).map((session) => session.id)).toEqual(["session-a-subagent"]);

    const projects = composite.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0]).toEqual({
      id: "shared-project",
      name: "Shared",
      path: "/workspace/shared",
      sessionCount: 3,
      subagentCount: 1,
      updatedAt: "2026-03-14T12:00:00.000Z",
      lastSessionTitle: "Claude session"
    });

    expect(composite.getSessionDetail("session-b")?.provider).toBe("claude-code");
    expect(composite.getSessionDetail("missing-session")).toBeNull();
  });

  it("aggregates overview, memory, integrations, and fan-out actions", async () => {
    const providerAProject = {
      projectId: "project-a",
      projectName: "Project A",
      projectPath: "/workspace/project-a"
    } satisfies ResolvedProjectInfo;
    const providerBProject = {
      projectId: "project-b",
      projectName: "Project B",
      projectPath: "/workspace/project-b"
    } satisfies ResolvedProjectInfo;
    const providerA = createProvider({
      id: "codex",
      overview: createOverview({
        stats: {
          totalSessions: 2,
          activeToday: 1,
          totalSkills: 3,
          totalMcpServers: 1,
          totalHooks: 2,
          todayTokens: {
            totalTokens: 100,
            cachedInputTokens: 25,
            uncachedTokens: 75
          }
        }
      }),
      memory: createMemory({
        entries: [createMemoryEntry("thread-a")],
        modeCounts: [{ mode: "enabled", count: 1 }],
        totalThreads: 1,
        developerInstructions: "provider-a-instructions",
        providerConfigs: [{
          provider: "codex",
          developerInstructions: "provider-a-instructions",
          personality: null,
          sourceStatus: "ready",
          entryCount: 1,
          totalThreads: 1
        }]
      }),
      integrations: createIntegrations({
        mcpServers: [{ name: "docs-a", url: null, usageCount: 1, toolNames: ["search"] }],
        skills: [{ id: "skill-a", name: "Skill A", description: "A", source: "codex" }],
        hooks: [{ id: "hook-a", name: "Hook A", preview: "echo a", kind: "shell", source: "codex" }]
      }),
      hookDetails: {
        "hook-a": createHookDetail("hook-a", "Hook A")
      },
      skillDetails: {
        "skill-a": createSkillDetail("skill-a", "Skill A", "codex")
      },
      sessionRoot: "/sessions/codex",
      resolvedProjects: {
        "/rollout-a": providerAProject
      }
    });
    const providerB = createProvider({
      id: "claude-code",
      overview: createOverview({
        stats: {
          totalSessions: 5,
          activeToday: 2,
          totalSkills: 1,
          totalMcpServers: 4,
          totalHooks: 1,
          todayTokens: {
            totalTokens: 40,
            cachedInputTokens: 10,
            uncachedTokens: 30
          }
        }
      }),
      memory: createMemory({
        entries: [createMemoryEntry("thread-b")],
        modeCounts: [
          { mode: "disabled", count: 2 },
          { mode: "enabled", count: 1 }
        ],
        totalThreads: 3,
        developerInstructions: "provider-b-instructions",
        providerConfigs: [{
          provider: "claude-code",
          developerInstructions: "provider-b-instructions",
          personality: null,
          sourceStatus: "ready",
          entryCount: 1,
          totalThreads: 3
        }]
      }),
      integrations: createIntegrations({
        mcpServers: [{ name: "docs-b", url: "https://example.com", usageCount: 2, toolNames: ["fetch"] }],
        skills: [{ id: "skill-b", name: "Skill B", description: "B", source: "claude-code" }],
        hooks: [{ id: "hook-b", name: "Hook B", preview: "echo b", kind: "shell", source: "claude-code" }]
      }),
      hookDetails: {
        "hook-b": createHookDetail("hook-b", "Hook B")
      },
      skillDetails: {
        "skill-b": createSkillDetail("skill-b", "Skill B", "claude-code")
      },
      resolvedProjects: {
        "/rollout-b": providerBProject
      }
    });

    const composite = new CompositeProvider([providerA.provider, providerB.provider]);
    const overview = composite.getOverview(OVERVIEW_TOKENS);
    const memory = composite.getMemory();
    const integrations = composite.getIntegrations();

    expect(overview.stats).toEqual({
      totalSessions: 7,
      activeToday: 3,
      totalSkills: 4,
      totalMcpServers: 5,
      totalHooks: 3,
      todayTokens: {
        totalTokens: 140,
        cachedInputTokens: 35,
        uncachedTokens: 105
      }
    });

    expect(memory.entries.map((entry) => entry.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(memory.modeCounts).toEqual([
      { mode: "disabled", count: 2 },
      { mode: "enabled", count: 2 }
    ]);
    expect(memory.totalThreads).toBe(4);
    expect(memory.developerInstructions).toBe("provider-a-instructions");
    expect(memory.providerConfigs).toHaveLength(2);
    expect(memory.providerConfigs.map((config) => config.provider)).toEqual(["codex", "claude-code"]);

    expect(integrations.mcpServers.map((server) => server.name)).toEqual(["docs-a", "docs-b"]);
    expect(integrations.skills.map((skill) => skill.id)).toEqual(["skill-a", "skill-b"]);
    expect(integrations.hooks.map((hook) => hook.id)).toEqual(["hook-a", "hook-b"]);

    composite.ensureMonitorSchema();
    await composite.ensureFreshIntegrationsUsage();
    await composite.refreshIntegrationsUsageInBackground();

    expect(providerA.ensureMonitorSchema).toHaveBeenCalledTimes(1);
    expect(providerB.ensureMonitorSchema).toHaveBeenCalledTimes(1);
    expect(providerA.ensureFreshIntegrationsUsage).toHaveBeenCalledTimes(1);
    expect(providerB.ensureFreshIntegrationsUsage).toHaveBeenCalledTimes(1);
    expect(providerA.refreshIntegrationsUsageInBackground).toHaveBeenCalledTimes(1);
    expect(providerB.refreshIntegrationsUsageInBackground).toHaveBeenCalledTimes(1);

    expect(composite.getHookDetail("hook-b")?.name).toBe("Hook B");
    expect(composite.getSkillDetail("skill-b")?.name).toBe("Skill B");
    expect(composite.getSessionRoot()).toBe("/sessions/codex");
    expect(composite.resolveProjectInfoForRolloutPath("/rollout-a")).toEqual(providerAProject);
    expect(composite.resolveProjectInfoForRolloutPath("/rollout-b")).toEqual(providerBProject);
    expect(composite.resolveProjectInfoForRolloutPath("/missing-rollout")).toBeNull();
  });
});

function createProvider(options: {
  id: ProviderId;
  sessions?: SessionListItem[];
  projects?: ProjectSummary[];
  overview?: OverviewResponse;
  memory?: MemoryResponse;
  integrations?: IntegrationsResponse;
  sessionDetails?: Record<string, SessionDetail>;
  hookDetails?: Record<string, HookDetail>;
  skillDetails?: Record<string, SkillDetail>;
  sessionRoot?: string;
  resolvedProjects?: Record<string, ResolvedProjectInfo>;
}) {
  const ensureMonitorSchema = vi.fn();
  const ensureFreshIntegrationsUsage = vi.fn(async () => undefined);
  const refreshIntegrationsUsageInBackground = vi.fn(async () => undefined);

  return {
    ensureMonitorSchema,
    ensureFreshIntegrationsUsage,
    refreshIntegrationsUsageInBackground,
    provider: {
      id: options.id,
      ensureMonitorSchema,
      ensureFreshIntegrationsUsage,
      refreshIntegrationsUsageInBackground,
      getOverview: () => options.overview ?? createOverview(),
      listSessions: () => options.sessions ?? [],
      listProjects: () => options.projects ?? [],
      getSessionDetail: (id) => options.sessionDetails?.[id] ?? null,
      getMemory: () => options.memory ?? createMemory(),
      getIntegrations: () => options.integrations ?? createIntegrations(),
      getHookDetail: (id) => options.hookDetails?.[id] ?? null,
      getSkillDetail: (id) => options.skillDetails?.[id] ?? null,
      getSessionRoot: () => options.sessionRoot ?? `/sessions/${options.id}`,
      resolveProjectInfoForRolloutPath: (rolloutPath) => options.resolvedProjects?.[rolloutPath] ?? null
    } satisfies MonitorProviderAdapter
  };
}

function createSession(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    provider: "codex",
    title: "Session",
    cwd: "/workspace/project",
    projectId: "project",
    projectName: "Project",
    projectPath: "/workspace/project",
    isSubagent: false,
    parentThreadId: null,
    subagentDepth: null,
    subagentNickname: null,
    subagentRole: null,
    createdAt: "2026-03-14T09:00:00.000Z",
    updatedAt: "2026-03-14T09:00:00.000Z",
    tokensUsed: 0,
    memoryMode: "enabled",
    source: "cli",
    modelProvider: "openai",
    approvalMode: "never",
    sandboxPolicy: "danger-full-access",
    agentNickname: null,
    agentRole: null,
    ...overrides
  };
}

function createSessionDetail(session: SessionListItem): SessionDetail {
  return {
    ...session,
    rolloutPath: `/rollouts/${session.id}.jsonl`,
    firstUserMessage: "User request",
    parentSessionId: session.parentThreadId,
    parentSessionTitle: null,
    subagents: [],
    tokenSeries: [],
    timeline: []
  };
}

function createProject(id: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    name: "Project",
    path: "/workspace/project",
    sessionCount: 1,
    subagentCount: 0,
    updatedAt: "2026-03-14T09:00:00.000Z",
    lastSessionTitle: "Session",
    ...overrides
  };
}

function createOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    stats: {
      totalSessions: 0,
      activeToday: 0,
      totalSkills: 0,
      totalMcpServers: 0,
      totalHooks: 0,
      todayTokens: {
        totalTokens: 0,
        cachedInputTokens: 0,
        uncachedTokens: 0
      }
    },
    daily: [],
    heatmapDaily: [],
    averageTokens7d: {
      totalTokens: 0,
      cachedInputTokens: 0,
      uncachedTokens: 0
    },
    lastSyncedAt: null,
    collector: null,
    ...overrides
  };
}

function createMemory(overrides: Partial<MemoryResponse> = {}): MemoryResponse {
  return {
    entries: [],
    providerConfigs: [],
    modeCounts: [],
    totalThreads: 0,
    hasStage1OutputsTable: true,
    stage1OutputCount: 0,
    sourceStatus: "ready",
    developerInstructions: null,
    personality: null,
    ...overrides
  };
}

function createMemoryEntry(threadId: string): MemoryResponse["entries"][number] {
  return {
    provider: "codex",
    threadId,
    title: threadId,
    rawMemory: `memory-${threadId}`,
    rolloutSummary: `summary-${threadId}`,
    usageCount: 1,
    lastUsage: "2026-03-14T10:00:00.000Z",
    generatedAt: "2026-03-14T10:00:00.000Z"
  };
}

function createIntegrations(overrides: Partial<IntegrationsResponse> = {}): IntegrationsResponse {
  return {
    mcpServers: [],
    skills: [],
    hooks: [],
    lastSyncedAt: "2026-03-14T10:00:00.000Z",
    isStale: false,
    ...overrides
  };
}

function createHookDetail(id: string, name: string): HookDetail {
  return {
    id,
    name,
    preview: `preview-${id}`,
    kind: "shell",
    source: "codex",
    command: `echo ${name}`
  };
}

function createSkillDetail(id: string, name: string, source: SkillDetail["source"]): SkillDetail {
  return {
    id,
    name,
    description: `description-${id}`,
    source,
    path: `/skills/${id}/SKILL.md`,
    content: `# ${name}`
  };
}
