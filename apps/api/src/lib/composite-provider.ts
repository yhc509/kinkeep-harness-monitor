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
import type { MonitorProviderAdapter, OverviewTokenSnapshot, ProjectQueryOptions, SessionQueryOptions } from "./provider-adapter";
import type { ResolvedProjectInfo } from "./project-resolver";

const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

export class CompositeProvider implements MonitorProviderAdapter {
  readonly id: ProviderId;

  constructor(private readonly providers: MonitorProviderAdapter[]) {
    this.id = this.getFirstProvider().id;
  }

  ensureMonitorSchema(): void {
    for (const provider of this.providers) {
      provider.ensureMonitorSchema();
    }
  }

  ensureFreshIntegrationsUsage(): Promise<void> {
    return Promise.all(this.providers.map((provider) => provider.ensureFreshIntegrationsUsage())).then(() => undefined);
  }

  refreshIntegrationsUsageInBackground(): Promise<void> {
    return Promise.all(this.providers.map((provider) => provider.refreshIntegrationsUsageInBackground())).then(() => undefined);
  }

  getOverview(tokens: OverviewTokenSnapshot): OverviewResponse {
    const [firstProvider, ...restProviders] = this.providers;
    const overview = (firstProvider ?? this.getFirstProvider()).getOverview(tokens);
    overview.stats.todayTokens = tokens.todayTokens;
    overview.daily = tokens.daily;
    overview.heatmapDaily = tokens.heatmapDaily;
    overview.averageTokens7d = tokens.averageTokens7d;
    overview.lastSyncedAt = tokens.lastSyncedAt;

    for (const provider of restProviders) {
      const nextOverview = provider.getOverview(tokens);
      overview.stats.totalSessions += nextOverview.stats.totalSessions;
      overview.stats.activeToday += nextOverview.stats.activeToday;
      overview.stats.totalSkills += nextOverview.stats.totalSkills;
      overview.stats.totalMcpServers += nextOverview.stats.totalMcpServers;
      overview.stats.totalHooks += nextOverview.stats.totalHooks;
    }

    return overview;
  }

  listSessions(options: SessionQueryOptions = {}): SessionListItem[] {
    const search = options.query?.trim().toLowerCase();
    const includeSubagents = options.includeSubagents ?? false;
    const sort = options.sort ?? "updatedAt";
    const order = options.order ?? "desc";
    const limit = options.limit ?? 200;

    const sessions = this.providers
      .flatMap((provider) => provider.listSessions({
        includeSubagents: true,
        limit: UNBOUNDED_LIMIT
      }))
      .filter((session) => {
        if (options.projectId && session.projectId !== options.projectId) {
          return false;
        }

        if (!includeSubagents && session.isSubagent) {
          return false;
        }

        if (!search) {
          return true;
        }

        return (
          session.title.toLowerCase().includes(search)
          || session.cwd.toLowerCase().includes(search)
          || session.subagentNickname?.toLowerCase().includes(search)
          || session.subagentRole?.toLowerCase().includes(search)
        );
      });

    sessions.sort((left, right) => compareSessions(left, right, sort, order));
    return sessions.slice(0, limit);
  }

  listProjects(options: ProjectQueryOptions = {}): ProjectSummary[] {
    const search = options.query?.trim().toLowerCase();
    const limit = options.limit ?? 200;
    const mergedProjects = new Map<string, ProjectSummary & { updatedAtEpoch: number }>();

    for (const project of this.providers.flatMap((provider) => provider.listProjects({ limit: UNBOUNDED_LIMIT }))) {
      const updatedAtEpoch = Date.parse(project.updatedAt);
      const existing = mergedProjects.get(project.id);
      if (!existing) {
        mergedProjects.set(project.id, {
          ...project,
          updatedAtEpoch
        });
        continue;
      }

      existing.sessionCount += project.sessionCount;
      existing.subagentCount += project.subagentCount;
      existing.providers = [...new Set([...existing.providers, ...project.providers])];
      if (updatedAtEpoch >= existing.updatedAtEpoch) {
        existing.updatedAtEpoch = updatedAtEpoch;
        existing.updatedAt = project.updatedAt;
        existing.lastSessionTitle = project.lastSessionTitle;
      }
    }

    return Array.from(mergedProjects.values())
      .filter((project) => {
        if (!search) {
          return true;
        }

        return project.name.toLowerCase().includes(search) || project.path.toLowerCase().includes(search);
      })
      .sort((left, right) => right.updatedAtEpoch - left.updatedAtEpoch)
      .slice(0, limit)
      .map(({ updatedAtEpoch, ...project }) => project);
  }

  getSessionDetail(id: string): SessionDetail | null {
    for (const provider of this.providers) {
      const detail = provider.getSessionDetail(id);
      if (detail) {
        return detail;
      }
    }

    return null;
  }

  getMemory(): MemoryResponse {
    const [firstProvider, ...restProviders] = this.providers;
    const memory = (firstProvider ?? this.getFirstProvider()).getMemory();
    const modeCountMap = new Map(memory.modeCounts.map((entry) => [entry.mode, entry.count]));
    const providerConfigs = [...memory.providerConfigs];

    for (const provider of restProviders) {
      const nextMemory = provider.getMemory();
      memory.entries.push(...nextMemory.entries);
      providerConfigs.push(...nextMemory.providerConfigs);
      memory.totalThreads += nextMemory.totalThreads;

      for (const entry of nextMemory.modeCounts) {
        modeCountMap.set(entry.mode, (modeCountMap.get(entry.mode) ?? 0) + entry.count);
      }
    }

    memory.modeCounts = Array.from(modeCountMap.entries())
      .map(([mode, count]) => ({ mode, count }))
      .sort((left, right) => right.count - left.count || left.mode.localeCompare(right.mode));
    memory.providerConfigs = providerConfigs;

    return memory;
  }

  getIntegrations(): IntegrationsResponse {
    const [firstProvider, ...restProviders] = this.providers;
    const integrations = (firstProvider ?? this.getFirstProvider()).getIntegrations();

    for (const provider of restProviders) {
      const nextIntegrations = provider.getIntegrations();
      integrations.mcpServers.push(...nextIntegrations.mcpServers);
      integrations.skills.push(...nextIntegrations.skills);
      integrations.hooks.push(...nextIntegrations.hooks);
    }

    return integrations;
  }

  getHookDetail(id: string): HookDetail | null {
    for (const provider of this.providers) {
      const detail = provider.getHookDetail(id);
      if (detail) {
        return detail;
      }
    }

    return null;
  }

  getSkillDetail(id: string): SkillDetail | null {
    for (const provider of this.providers) {
      const detail = provider.getSkillDetail(id);
      if (detail) {
        return detail;
      }
    }

    return null;
  }

  getSessionRoot(): string {
    return this.getFirstProvider().getSessionRoot();
  }

  resolveProjectInfoForRolloutPath(rolloutPath: string): ResolvedProjectInfo | null {
    for (const provider of this.providers) {
      const info = provider.resolveProjectInfoForRolloutPath(rolloutPath);
      if (info) {
        return info;
      }
    }

    return null;
  }

  private getFirstProvider(): MonitorProviderAdapter {
    const [provider] = this.providers;
    if (!provider) {
      throw new Error("CompositeProvider requires at least one provider");
    }

    return provider;
  }
}

function compareSessions(
  left: SessionListItem,
  right: SessionListItem,
  sort: NonNullable<SessionQueryOptions["sort"]>,
  order: NonNullable<SessionQueryOptions["order"]>
): number {
  const multiplier = order === "asc" ? 1 : -1;
  const leftValue = sort === "tokensUsed" ? left.tokensUsed : Date.parse(sort === "createdAt" ? left.createdAt : left.updatedAt);
  const rightValue = sort === "tokensUsed" ? right.tokensUsed : Date.parse(sort === "createdAt" ? right.createdAt : right.updatedAt);
  return (leftValue - rightValue) * multiplier;
}
