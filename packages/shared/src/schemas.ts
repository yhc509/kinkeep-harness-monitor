import { z } from "zod";

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  sessionCount: z.number(),
  subagentCount: z.number(),
  updatedAt: z.string(),
  lastSessionTitle: z.string()
});

export const subagentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  updatedAt: z.string(),
  subagentDepth: z.number().nullable(),
  subagentNickname: z.string().nullable(),
  subagentRole: z.string().nullable()
});

export const sessionListItemSchema = z.object({
  id: z.string(),
  provider: z.enum(["codex", "claude-code"]).optional(),
  title: z.string(),
  cwd: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  isSubagent: z.boolean(),
  parentThreadId: z.string().nullable(),
  subagentDepth: z.number().nullable(),
  subagentNickname: z.string().nullable(),
  subagentRole: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tokensUsed: z.number(),
  memoryMode: z.string(),
  source: z.string(),
  modelProvider: z.string(),
  approvalMode: z.string(),
  sandboxPolicy: z.string(),
  agentNickname: z.string().nullable(),
  agentRole: z.string().nullable()
});

export const sessionTimelineItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  kind: z.enum([
    "user_message",
    "assistant_message",
    "developer_message",
    "system_message",
    "tool_call",
    "tool_result",
    "token_count",
    "event",
    "session_meta"
  ]),
  role: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  toolName: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).default({})
});

export const tokenSeriesPointSchema = z.object({
  timestamp: z.string(),
  totalTokens: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningOutputTokens: z.number().nullable(),
  lastTotalTokens: z.number().nullable()
});

export const sessionDetailSchema = sessionListItemSchema.extend({
  rolloutPath: z.string(),
  firstUserMessage: z.string(),
  parentSessionId: z.string().nullable(),
  parentSessionTitle: z.string().nullable(),
  subagents: z.array(subagentSummarySchema),
  tokenSeries: z.array(tokenSeriesPointSchema),
  timeline: z.array(sessionTimelineItemSchema)
});

export const collectorRunSchema = z.object({
  id: z.number(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["success", "warning", "failure"]),
  message: z.string(),
  snapshotId: z.number().nullable()
});

export const hourlyTokenUsageSchema = z.object({
  hourBucket: z.string(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  requestCount: z.number()
});

export const tokenBreakdownSchema = z.object({
  totalTokens: z.number(),
  cachedInputTokens: z.number(),
  uncachedTokens: z.number()
});

export const dailyTokenPointSchema = z.object({
  day: z.string(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  uncachedTokens: z.number(),
  uncachedInputTokens: z.number(),
  outputTokens: z.number()
});

export const dailyProviderTokensSchema = z.object({
  day: z.string(),
  codexTokens: z.number(),
  claudeCodeTokens: z.number()
});

export const tokenSyncStatsSchema = z.object({
  totalRollouts: z.number(),
  updatedRollouts: z.number(),
  deletedRollouts: z.number(),
  hourBuckets: z.number(),
  tokenEvents: z.number()
});

export const tokenPeriodUnitSchema = z.enum(["day", "week", "month"]);

export const projectTokenUsageItemSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  totalTokens: z.number(),
  requestCount: z.number()
});

export const modelTokenUsageItemSchema = z.object({
  modelName: z.string(),
  modelProvider: z.string().nullable(),
  totalTokens: z.number()
});

export const overviewStatsSchema = z.object({
  totalSessions: z.number(),
  activeToday: z.number(),
  totalSkills: z.number(),
  totalMcpServers: z.number(),
  totalHooks: z.number(),
  todayTokens: tokenBreakdownSchema
});

export const overviewResponseSchema = z.object({
  stats: overviewStatsSchema,
  daily: z.array(dailyTokenPointSchema),
  heatmapDaily: z.array(dailyTokenPointSchema),
  averageTokens7d: tokenBreakdownSchema,
  lastSyncedAt: z.string().nullable(),
  collector: collectorRunSchema.nullable()
});

export const memoryEntrySchema = z.object({
  threadId: z.string(),
  title: z.string(),
  rawMemory: z.string(),
  rolloutSummary: z.string(),
  usageCount: z.number().nullable(),
  lastUsage: z.string().nullable(),
  generatedAt: z.string()
});

export const memoryModeCountSchema = z.object({
  mode: z.string(),
  count: z.number()
});

export const memoryResponseSchema = z.object({
  entries: z.array(memoryEntrySchema),
  modeCounts: z.array(memoryModeCountSchema),
  totalThreads: z.number(),
  hasStage1OutputsTable: z.boolean(),
  stage1OutputCount: z.number(),
  sourceStatus: z.enum(["ready", "empty", "unsupported"]),
  developerInstructions: z.string().nullable(),
  personality: z.string().nullable()
});

export const mcpServerSummarySchema = z.object({
  name: z.string(),
  url: z.string().nullable(),
  usageCount: z.number(),
  toolNames: z.array(z.string())
});

export const skillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["codex", "agents", "claude-code"])
});

export const hookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  preview: z.string(),
  kind: z.string(),
  source: z.string()
});

export const skillDetailSchema = skillSummarySchema.extend({
  path: z.string(),
  content: z.string()
});

export const hookDetailSchema = hookSummarySchema.extend({
  command: z.string()
});

export const projectsResponseSchema = z.array(projectSummarySchema);

export const integrationsResponseSchema = z.object({
  mcpServers: z.array(mcpServerSummarySchema),
  skills: z.array(skillSummarySchema),
  hooks: z.array(hookSummarySchema),
  lastSyncedAt: z.string().nullable(),
  isStale: z.boolean()
});

export const tokensResponseSchema = z.object({
  rangeDays: z.number(),
  currentHourTokens: tokenBreakdownSchema,
  daily: z.array(dailyTokenPointSchema),
  dailyProviderTokens: z.array(dailyProviderTokensSchema),
  hourly: z.array(hourlyTokenUsageSchema),
  modelUsage: z.array(modelTokenUsageItemSchema),
  collectorRuns: z.array(collectorRunSchema),
  lastSyncedAt: z.string().nullable()
});

export const projectTokenUsageResponseSchema = z.object({
  unit: tokenPeriodUnitSchema,
  anchorDay: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  label: z.string(),
  isCurrentPeriod: z.boolean(),
  totalTokens: z.number(),
  projects: z.array(projectTokenUsageItemSchema)
});

export const tokenSyncResultSchema = z.object({
  run: collectorRunSchema,
  stats: tokenSyncStatsSchema
});

export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type SessionTimelineItem = z.infer<typeof sessionTimelineItemSchema>;
export type TokenSeriesPoint = z.infer<typeof tokenSeriesPointSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type SubagentSummary = z.infer<typeof subagentSummarySchema>;
export type CollectorRun = z.infer<typeof collectorRunSchema>;
export type HourlyTokenUsage = z.infer<typeof hourlyTokenUsageSchema>;
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;
export type DailyTokenPoint = z.infer<typeof dailyTokenPointSchema>;
export type DailyProviderTokens = z.infer<typeof dailyProviderTokensSchema>;
export type TokenSyncStats = z.infer<typeof tokenSyncStatsSchema>;
export type TokenPeriodUnit = z.infer<typeof tokenPeriodUnitSchema>;
export type ProjectTokenUsageItem = z.infer<typeof projectTokenUsageItemSchema>;
export type ModelTokenUsageItem = z.infer<typeof modelTokenUsageItemSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryResponse = z.infer<typeof memoryResponseSchema>;
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type HookSummary = z.infer<typeof hookSummarySchema>;
export type SkillDetail = z.infer<typeof skillDetailSchema>;
export type HookDetail = z.infer<typeof hookDetailSchema>;
export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;
export type TokensResponse = z.infer<typeof tokensResponseSchema>;
export type ProjectTokenUsageResponse = z.infer<typeof projectTokenUsageResponseSchema>;
export type TokenSyncResult = z.infer<typeof tokenSyncResultSchema>;
