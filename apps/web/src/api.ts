import {
  hookDetailSchema,
  integrationsResponseSchema,
  memoryResponseSchema,
  overviewResponseSchema,
  projectTokenUsageResponseSchema,
  projectsResponseSchema,
  sessionDetailSchema,
  sessionListItemSchema,
  skillDetailSchema,
  tokenPeriodUnitSchema,
  tokenSyncResultSchema,
  tokensResponseSchema
} from "@codex-monitor/shared";
import { z } from "zod";

const sessionListSchema = z.array(sessionListItemSchema);

export const apiResourceKeys = {
  overview: "overview",
  projects: (query: string) => `projects:${query.trim().toLowerCase()}`,
  sessions: (options: { projectId?: string; query?: string; includeSubagents?: boolean }) => JSON.stringify({
    type: "sessions",
    projectId: options.projectId ?? null,
    query: options.query?.trim().toLowerCase() ?? "",
    includeSubagents: Boolean(options.includeSubagents)
  }),
  sessionDetail: (id: string) => `session:${id}`,
  memory: "memory",
  integrations: "integrations",
  hookDetail: (id: string) => `hook:${id}`,
  skillDetail: (id: string) => `skill:${id}`,
  tokens: (rangeDays: number) => `tokens:${rangeDays}`,
  projectTokenUsage: (unit: z.infer<typeof tokenPeriodUnitSchema>, anchorDay: string) => `project-token-usage:${unit}:${anchorDay}`
} as const;

async function requestJson<T>(input: string, schema: z.ZodSchema<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return schema.parse(json);
}

export function getOverview() {
  return requestJson("/api/overview", overviewResponseSchema);
}

export function getProjects(query: string) {
  const search = new URLSearchParams();
  search.set("limit", "250");
  if (query.trim()) {
    search.set("query", query.trim());
  }
  return requestJson(`/api/projects?${search.toString()}`, projectsResponseSchema);
}

export function getSessions(options: { projectId?: string; query?: string; includeSubagents?: boolean }) {
  const search = new URLSearchParams();
  search.set("limit", "250");
  search.set("sort", "updatedAt");
  search.set("order", "desc");
  if (options.projectId) {
    search.set("projectId", options.projectId);
  }
  if (options.includeSubagents) {
    search.set("includeSubagents", "true");
  }
  if (options.query?.trim()) {
    search.set("query", options.query.trim());
  }
  return requestJson(`/api/sessions?${search.toString()}`, sessionListSchema);
}

export function getSessionDetail(id: string) {
  return requestJson(`/api/sessions/${id}`, sessionDetailSchema);
}

export function getMemory() {
  return requestJson("/api/memory", memoryResponseSchema);
}

export function getIntegrations() {
  return requestJson("/api/integrations", integrationsResponseSchema);
}

export function refreshIntegrations() {
  return requestJson("/api/integrations/refresh", integrationsResponseSchema, {
    method: "POST"
  });
}

export function getHookDetail(id: string) {
  return requestJson(`/api/integrations/hooks/${encodeURIComponent(id)}`, hookDetailSchema);
}

export function getSkillDetail(id: string) {
  return requestJson(`/api/integrations/skills/${encodeURIComponent(id)}`, skillDetailSchema);
}

export function getTokens(rangeDays: number) {
  return requestJson(`/api/tokens?range=${rangeDays}`, tokensResponseSchema);
}

export function getProjectTokenUsage(unit: z.infer<typeof tokenPeriodUnitSchema>, anchorDay: string) {
  const search = new URLSearchParams({
    unit,
    anchor: anchorDay
  });
  return requestJson(`/api/tokens/project-usage?${search.toString()}`, projectTokenUsageResponseSchema);
}

export function createSnapshot() {
  return requestJson("/api/tokens/snapshot", tokenSyncResultSchema, {
    method: "POST"
  });
}
