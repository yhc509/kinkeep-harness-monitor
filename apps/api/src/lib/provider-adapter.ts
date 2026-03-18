import type {
  HookDetail,
  IntegrationsResponse,
  MemoryResponse,
  OverviewResponse,
  ProjectSummary,
  SessionDetail,
  SessionListItem,
  SkillDetail,
  TokenBreakdown,
  DailyTokenPoint
} from "@codex-monitor/shared";
import type { ProviderId } from "../config";
import type { ResolvedProjectInfo } from "./project-resolver";

export interface SessionQueryOptions {
  query?: string;
  projectId?: string;
  includeSubagents?: boolean;
  sort?: "updatedAt" | "tokensUsed" | "createdAt";
  order?: "asc" | "desc";
  limit?: number;
}

export interface ProjectQueryOptions {
  query?: string;
  limit?: number;
}

export interface OverviewTokenSnapshot {
  todayTokens: TokenBreakdown;
  daily: DailyTokenPoint[];
  heatmapDaily: DailyTokenPoint[];
  averageTokens7d: TokenBreakdown;
  lastSyncedAt: string | null;
}

export interface SessionLogProvider {
  getSessionRoot(): string;
  resolveProjectInfoForRolloutPath(rolloutPath: string): ResolvedProjectInfo | null;
}

export interface MonitorProviderAdapter extends SessionLogProvider {
  readonly id: ProviderId;
  ensureMonitorSchema(): void;
  ensureFreshIntegrationsUsage(): Promise<void>;
  refreshIntegrationsUsageInBackground(): Promise<void>;
  getOverview(tokens: OverviewTokenSnapshot): OverviewResponse;
  listSessions(options?: SessionQueryOptions): SessionListItem[];
  listProjects(options?: ProjectQueryOptions): ProjectSummary[];
  getSessionDetail(id: string): SessionDetail | null;
  getMemory(): MemoryResponse;
  getIntegrations(): IntegrationsResponse;
  getHookDetail(id: string): HookDetail | null;
  getSkillDetail(id: string): SkillDetail | null;
}
