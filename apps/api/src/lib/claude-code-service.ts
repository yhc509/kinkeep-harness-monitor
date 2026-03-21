import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  HookDetail,
  IntegrationsResponse,
  MemoryResponse,
  OverviewResponse,
  ProjectSummary,
  SessionDetail,
  SessionListItem,
  SessionTimelineItem,
  SkillDetail,
  SkillSummary
} from "@codex-monitor/shared";
import {
  hookDetailSchema,
  integrationsResponseSchema,
  memoryResponseSchema,
  overviewResponseSchema,
  sessionDetailSchema,
  skillDetailSchema
} from "@codex-monitor/shared";
import type { AppConfig } from "../config";
import { humanizeEventName, stringifySnippet, toLocalDateTime } from "./format";
import type { MonitorProviderAdapter, OverviewTokenSnapshot, ProjectQueryOptions, SessionQueryOptions } from "./provider-adapter";
import { resolveProjectInfoFromCwd, type ResolvedProjectInfo } from "./project-resolver";

const CACHE_TTL_MS = 60_000;
const DEFAULT_SOURCE = "cli";

interface ClaudeHistoryEntry {
  title: string | null;
  projectPath: string | null;
  timestamp: number;
}

interface ClaudeSessionMetadata {
  cwd: string | null;
  startedAt: number | null;
}

interface ClaudeSessionRecord {
  session: SessionListItem;
  transcriptPath: string;
  firstUserMessage: string;
}

interface SessionIndexCacheEntry {
  expiresAt: number;
  sessions: ClaudeSessionRecord[];
  byId: Map<string, ClaudeSessionRecord>;
}

interface SkillsCacheEntry {
  expiresAt: number;
  value: SkillRecord[];
}

interface SettingsCacheEntry {
  expiresAt: number;
  value: ClaudeSettings;
}

interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSummary["source"];
}

interface HookRecord {
  id: string;
  name: string;
  preview: string;
  kind: string;
  source: string;
  command: string;
}

interface ClaudeSettings {
  mcpServers: Array<{ name: string; url: string | null }>;
  hooks: HookRecord[];
}

interface ClaudeStatsCache {
  totalSessions?: number;
}

interface TranscriptMetadataOptions {
  cwdFallback?: string | null;
  startedAtFallback?: number | null;
  titleFallback?: string | null;
}

interface TranscriptMetadata {
  createdAt: string;
  updatedAt: string;
  cwd: string | null;
  source: string;
  firstUserMessage: string;
  title: string;
}

interface TimelineParseResult {
  timeline: SessionTimelineItem[];
  firstUserMessage: string;
}

export class ClaudeCodeDataService implements MonitorProviderAdapter {
  readonly id = "claude-code" as const;
  private sessionIndexCache: SessionIndexCacheEntry | null = null;
  private skillsCache: SkillsCacheEntry | null = null;
  private settingsCache: SettingsCacheEntry | null = null;
  private readonly projectInfoCache = new Map<string, ResolvedProjectInfo>();

  constructor(private readonly config: AppConfig) {}

  ensureMonitorSchema(): void {}

  ensureFreshIntegrationsUsage(): Promise<void> {
    return Promise.resolve();
  }

  refreshIntegrationsUsageInBackground(): Promise<void> {
    return Promise.resolve();
  }

  getOverview(tokens: OverviewTokenSnapshot): OverviewResponse {
    const sessions = this.getSessionRecords();
    const settings = this.readSettings();
    const totalSessions = sessions.length > 0
      ? sessions.length
      : this.readStatsCache()?.totalSessions ?? 0;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayStartMs = startOfToday.getTime();

    return overviewResponseSchema.parse({
      stats: {
        totalSessions,
        activeToday: sessions.filter((record) => Date.parse(record.session.updatedAt) >= todayStartMs).length,
        totalSkills: this.getSkillInventory().length,
        totalMcpServers: settings.mcpServers.length,
        totalHooks: settings.hooks.length,
        todayTokens: tokens.todayTokens
      },
      daily: tokens.daily,
      heatmapDaily: tokens.heatmapDaily,
      averageTokens7d: tokens.averageTokens7d,
      lastSyncedAt: tokens.lastSyncedAt,
      collector: null
    });
  }

  listSessions(options: SessionQueryOptions = {}): SessionListItem[] {
    const search = options.query?.trim().toLowerCase();
    const sort = options.sort ?? "updatedAt";
    const order = options.order ?? "desc";
    const limit = options.limit ?? 200;

    const sessions = this.getSessionRecords()
      .map((record) => record.session)
      .filter((session) => {
        if (options.projectId && session.projectId !== options.projectId) {
          return false;
        }

        if (!search) {
          return true;
        }

        return session.title.toLowerCase().includes(search) || session.cwd.toLowerCase().includes(search);
      });

    sessions.sort((left, right) => compareSessions(left, right, sort, order));
    return sessions.slice(0, limit);
  }

  listProjects(options: ProjectQueryOptions = {}): ProjectSummary[] {
    const search = options.query?.trim().toLowerCase();
    const limit = options.limit ?? 200;
    const projects = new Map<string, ProjectSummary & { updatedAtEpoch: number }>();

    for (const session of this.getSessionRecords().map((record) => record.session)) {
      const updatedAtEpoch = Date.parse(session.updatedAt);
      const existing = projects.get(session.projectId);

      if (!existing) {
        projects.set(session.projectId, {
          id: session.projectId,
          name: session.projectName,
          path: session.projectPath,
          sessionCount: 1,
          subagentCount: 0,
          updatedAt: session.updatedAt,
          lastSessionTitle: session.title,
          updatedAtEpoch
        });
        continue;
      }

      existing.sessionCount += 1;
      if (updatedAtEpoch >= existing.updatedAtEpoch) {
        existing.updatedAtEpoch = updatedAtEpoch;
        existing.updatedAt = session.updatedAt;
        existing.lastSessionTitle = session.title;
      }
    }

    return Array.from(projects.values())
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
    const cached = this.getSessionIndex().byId.get(id) ?? this.buildTranscriptFallbackRecord(id);
    if (!cached) {
      return null;
    }

    const projectTranscriptPath = cached.transcriptPath;
    const fallbackTranscriptPath = this.getTranscriptFallbackPath(id);
    const rolloutPath = fs.existsSync(projectTranscriptPath)
      ? projectTranscriptPath
      : fallbackTranscriptPath;
    const parsed = parseClaudeTimeline(rolloutPath);

    return sessionDetailSchema.parse({
      ...cached.session,
      rolloutPath,
      firstUserMessage: parsed.firstUserMessage || cached.firstUserMessage,
      parentSessionId: null,
      parentSessionTitle: null,
      subagents: [],
      tokenSeries: [],
      timeline: parsed.timeline
    });
  }

  getMemory(): MemoryResponse {
    const memoryFiles = scanClaudeMemoryFiles(this.getSessionRoot());
    const totalSessions = this.getSessionRecords().length;
    const devInstructions = this.readDeveloperInstructions();
    const entries = memoryFiles.map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const frontmatter = extractFrontmatter(content);
      const bodyContent = stripFrontmatter(content).trim();
      const stat = fs.statSync(filePath);
      const fallbackTitle = path.basename(filePath, ".md");

      return {
        provider: "claude-code",
        threadId: filePath,
        title: frontmatter.name ?? fallbackTitle,
        rawMemory: bodyContent,
        rolloutSummary: frontmatter.description ?? "",
        usageCount: null,
        lastUsage: null,
        generatedAt: toLocalDateTime(stat.mtimeMs) ?? ""
      };
    });
    const providerConfigs = [{
      provider: "claude-code" as const,
      developerInstructions: devInstructions,
      personality: null,
      sourceStatus: entries.length > 0 ? "ready" as const : "empty" as const,
      entryCount: entries.length,
      totalThreads: totalSessions
    }];

    return memoryResponseSchema.parse({
      entries,
      providerConfigs,
      modeCounts: [{
        mode: "enabled",
        count: totalSessions
      }],
      totalThreads: totalSessions,
      hasStage1OutputsTable: false,
      stage1OutputCount: entries.length,
      sourceStatus: entries.length > 0 ? "ready" : "empty",
      developerInstructions: devInstructions,
      personality: null
    });
  }

  getIntegrations(): IntegrationsResponse {
    const settings = this.readSettings();

    return integrationsResponseSchema.parse({
      mcpServers: settings.mcpServers.map((server) => ({
        name: server.name,
        url: server.url,
        usageCount: 0,
        toolNames: []
      })),
      skills: this.getSkillInventory(),
      hooks: settings.hooks.map(({ id, name, preview, kind, source }) => ({
        id,
        name,
        preview,
        kind,
        source
      })),
      lastSyncedAt: null,
      isStale: false
    });
  }

  getHookDetail(id: string): HookDetail | null {
    const hook = this.readSettings().hooks.find((record) => record.id === id);
    if (!hook) {
      return null;
    }

    return hookDetailSchema.parse({
      id: hook.id,
      name: hook.name,
      preview: hook.preview,
      kind: hook.kind,
      source: hook.source,
      command: hook.command
    });
  }

  getSkillDetail(id: string): SkillDetail | null {
    const record = this.getSkillRecords().find((item) => item.id === id);
    if (!record || !fs.existsSync(record.path)) {
      return null;
    }

    return skillDetailSchema.parse({
      id: record.id,
      name: record.name,
      description: record.description,
      source: record.source,
      path: record.path,
      content: fs.readFileSync(record.path, "utf8")
    });
  }

  getSessionRoot(): string {
    return path.join(this.config.providers.claudeCode.home, "projects");
  }

  resolveProjectInfoForRolloutPath(rolloutPath: string): ResolvedProjectInfo | null {
    const projectDirName = path.basename(path.dirname(rolloutPath));
    const cwd = decodeClaudeProjectDir(projectDirName);
    if (!cwd) {
      return null;
    }

    return this.resolveProjectInfo(cwd);
  }

  private getSessionIndex(): SessionIndexCacheEntry {
    if (this.sessionIndexCache && this.sessionIndexCache.expiresAt > Date.now()) {
      return this.sessionIndexCache;
    }

    const history = readClaudeHistoryIndex(this.config.providers.claudeCode.home);
    const metadata = readClaudeSessionMetadataIndex(this.config.providers.claudeCode.home);
    const sessions = scanClaudeProjectSessions(this.getSessionRoot())
      .map(({ sessionId, transcriptPath, projectDirName }) => (
        this.buildSessionRecord(sessionId, transcriptPath, projectDirName, history.get(sessionId), metadata.get(sessionId))
      ))
      .filter((record): record is ClaudeSessionRecord => Boolean(record));
    const byId = new Map<string, ClaudeSessionRecord>();

    for (const record of sessions) {
      const existing = byId.get(record.session.id);
      if (!existing || Date.parse(record.session.updatedAt) >= Date.parse(existing.session.updatedAt)) {
        byId.set(record.session.id, record);
      }
    }

    const value = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      sessions: Array.from(byId.values()),
      byId
    };
    this.sessionIndexCache = value;
    return value;
  }

  private getSessionRecords(): ClaudeSessionRecord[] {
    return this.getSessionIndex().sessions;
  }

  private buildSessionRecord(
    sessionId: string,
    transcriptPath: string,
    projectDirName: string | null,
    history: ClaudeHistoryEntry | undefined,
    metadata: ClaudeSessionMetadata | undefined
  ): ClaudeSessionRecord | null {
    const cwdFallback = metadata?.cwd ?? history?.projectPath ?? decodeClaudeProjectDir(projectDirName);
    const parsed = readClaudeTranscriptMetadata(transcriptPath, {
      cwdFallback,
      startedAtFallback: metadata?.startedAt ?? null,
      titleFallback: history?.title ?? null
    });
    const cwd = parsed.cwd ?? cwdFallback;
    if (!cwd) {
      return null;
    }

    const project = this.resolveProjectInfo(cwd);

    return {
      session: {
        id: sessionId,
        provider: "claude-code",
        title: parsed.title,
        cwd,
        projectId: project.projectId,
        projectName: project.projectName,
        projectPath: project.projectPath,
        isSubagent: false,
        parentThreadId: null,
        subagentDepth: null,
        subagentNickname: null,
        subagentRole: null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        tokensUsed: 0,
        memoryMode: "enabled",
        source: parsed.source,
        modelProvider: "anthropic",
        approvalMode: "default",
        sandboxPolicy: "default",
        agentNickname: null,
        agentRole: null
      },
      transcriptPath,
      firstUserMessage: parsed.firstUserMessage
    };
  }

  private buildTranscriptFallbackRecord(id: string): ClaudeSessionRecord | null {
    const transcriptPath = this.getTranscriptFallbackPath(id);
    if (!fs.existsSync(transcriptPath)) {
      return null;
    }

    const history = readClaudeHistoryIndex(this.config.providers.claudeCode.home).get(id);
    const metadata = readClaudeSessionMetadataIndex(this.config.providers.claudeCode.home).get(id);
    return this.buildSessionRecord(id, transcriptPath, null, history, metadata);
  }

  private getTranscriptFallbackPath(id: string): string {
    return path.join(this.config.providers.claudeCode.home, "transcripts", `ses_${id}.jsonl`);
  }

  private getSkillRecords(): SkillRecord[] {
    if (this.skillsCache && this.skillsCache.expiresAt > Date.now()) {
      return this.skillsCache.value;
    }

    const value = scanClaudeSkills(path.join(this.config.providers.claudeCode.home, "skills"))
      .sort((left, right) => left.name.localeCompare(right.name));

    this.skillsCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value
    };

    return value;
  }

  private getSkillInventory(): SkillSummary[] {
    return this.getSkillRecords().map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      source: record.source
    }));
  }

  private readSettings(): ClaudeSettings {
    if (this.settingsCache && this.settingsCache.expiresAt > Date.now()) {
      return this.settingsCache.value;
    }

    const filePath = path.join(this.config.providers.claudeCode.home, "settings.json");
    const empty = {
      mcpServers: [],
      hooks: []
    } satisfies ClaudeSettings;

    if (!fs.existsSync(filePath)) {
      this.settingsCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: empty
      };
      return empty;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      this.settingsCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: empty
      };
      return empty;
    }

    const record = isRecord(parsed) ? parsed : {};
    const mcpServers = isRecord(record.mcpServers)
      ? Object.entries(record.mcpServers)
        .map(([name, value]) => ({
          name,
          url: readClaudeMcpServerUrl(value)
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const hooks = parseClaudeHooks(filePath, record.hooks);
    const value = {
      mcpServers,
      hooks
    };

    this.settingsCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value
    };

    return value;
  }

  private readStatsCache(): ClaudeStatsCache | null {
    const filePath = path.join(this.config.providers.claudeCode.home, "stats-cache.json");
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeStatsCache;
      return parsed;
    } catch {
      return null;
    }
  }

  private readDeveloperInstructions(): string | null {
    const sessionRoot = this.getSessionRoot();
    if (!fs.existsSync(sessionRoot)) {
      return null;
    }

    const projectDirs = fs.readdirSync(sessionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    for (const dir of projectDirs) {
      const claudeMdPath = path.join(sessionRoot, dir.name, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        return fs.readFileSync(claudeMdPath, "utf8");
      }
    }

    return null;
  }

  private resolveProjectInfo(cwd: string): ResolvedProjectInfo {
    const resolvedCwd = path.resolve(cwd);
    const cached = this.projectInfoCache.get(resolvedCwd);
    if (cached) {
      return cached;
    }

    const info = resolveProjectInfoFromCwd(resolvedCwd);
    this.projectInfoCache.set(resolvedCwd, info);
    return info;
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

function readClaudeTranscriptMetadata(filePath: string, options: TranscriptMetadataOptions = {}): TranscriptMetadata {
  const entries = readClaudeJsonl(filePath);
  const firstEntry = entries[0] ?? null;
  const lastEntry = entries.at(-1) ?? null;
  const firstUserMessage = extractFirstUserMessage(entries);
  const createdAt = toLocalDateTime(readClaudeTimestamp(firstEntry) ?? options.startedAtFallback ?? null) ?? "";
  const updatedAt = toLocalDateTime(readClaudeTimestamp(lastEntry) ?? readClaudeTimestamp(firstEntry) ?? options.startedAtFallback ?? null) ?? createdAt;
  const cwd = readClaudeCwd(firstEntry) ?? options.cwdFallback ?? null;
  const source = readClaudeEntrypoint(firstEntry) ?? DEFAULT_SOURCE;
  const title = normalizeSessionTitle(options.titleFallback ?? firstUserMessage, path.basename(filePath, ".jsonl"));

  return {
    createdAt,
    updatedAt,
    cwd,
    source,
    firstUserMessage,
    title
  };
}

function parseClaudeTimeline(filePath: string): TimelineParseResult {
  if (!fs.existsSync(filePath)) {
    return {
      timeline: [{
        id: "missing-transcript",
        timestamp: toLocalDateTime(new Date()) ?? "",
        kind: "event",
        role: null,
        title: "Missing transcript",
        body: `Missing transcript file: ${filePath}`,
        toolName: null,
        metadata: {}
      }],
      firstUserMessage: ""
    };
  }

  const entries = readClaudeJsonl(filePath);
  const timeline: SessionTimelineItem[] = [];
  const toolNames = new Map<string, string | null>();
  let firstUserMessage = "";
  let nextId = 1;

  const pushTimelineItem = (item: Omit<SessionTimelineItem, "id">) => {
    timeline.push({
      id: String(nextId),
      ...item
    });
    nextId += 1;
  };

  for (const entry of entries) {
    const type = typeof entry.type === "string" ? entry.type : "event";
    const timestamp = toLocalDateTime(readClaudeTimestamp(entry)) ?? "";

    if (type === "user") {
      const body = extractClaudeMessageText(isRecord(entry.message) ? entry.message.content : null);
      if (!firstUserMessage && body) {
        firstUserMessage = body;
      }

      pushTimelineItem({
        timestamp,
        kind: "user_message",
        role: "user",
        title: createPreview(body || "User message"),
        body,
        toolName: null,
        metadata: {}
      });
      continue;
    }

    if (type === "assistant") {
      const content = isRecord(entry.message) ? entry.message.content : null;
      const blocks = Array.isArray(content) ? content : [];
      const textBlocks: string[] = [];

      if (!Array.isArray(content)) {
        const body = extractClaudeMessageText(content);
        pushTimelineItem({
          timestamp,
          kind: "assistant_message",
          role: "assistant",
          title: createPreview(body || "Assistant message"),
          body,
          toolName: null,
          metadata: {}
        });
        continue;
      }

      for (const block of blocks) {
        if (!isRecord(block)) {
          continue;
        }

        if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : "";
          if (text) {
            textBlocks.push(text);
          }
          continue;
        }

        if (block.type === "tool_use") {
          if (textBlocks.length > 0) {
            const body = textBlocks.join("\n\n").trim();
            pushTimelineItem({
              timestamp,
              kind: "assistant_message",
              role: "assistant",
              title: createPreview(body || "Assistant message"),
              body,
              toolName: null,
              metadata: {}
            });
            textBlocks.length = 0;
          }

          const toolUseId = typeof block.id === "string" ? block.id : null;
          const toolName = typeof block.name === "string" ? block.name : null;
          if (toolUseId) {
            toolNames.set(toolUseId, toolName);
          }

          pushTimelineItem({
            timestamp,
            kind: "tool_call",
            role: "assistant",
            title: toolName ? `Tool call: ${toolName}` : "Tool call",
            body: stringifySnippet(block.input ?? ""),
            toolName,
            metadata: toolUseId ? { toolUseId } : {}
          });
        }
      }

      if (textBlocks.length > 0) {
        const body = textBlocks.join("\n\n").trim();
        pushTimelineItem({
          timestamp,
          kind: "assistant_message",
          role: "assistant",
          title: createPreview(body || "Assistant message"),
          body,
          toolName: null,
          metadata: {}
        });
      }
      continue;
    }

    if (type === "tool_result") {
      const toolUseId = typeof entry.tool_use_id === "string" ? entry.tool_use_id : null;
      const toolName = toolUseId ? toolNames.get(toolUseId) ?? null : null;
      pushTimelineItem({
        timestamp,
        kind: "tool_result",
        role: "tool",
        title: toolName ? `Tool result: ${toolName}` : "Tool result",
        body: extractClaudeContentBody(entry.content),
        toolName,
        metadata: toolUseId ? { toolUseId } : {}
      });
      continue;
    }

    if (type === "system") {
      const body = extractClaudeMessageText(
        isRecord(entry.message) ? entry.message.content : entry.content
      );
      pushTimelineItem({
        timestamp,
        kind: "system_message",
        role: "system",
        title: createPreview(body || "System message"),
        body,
        toolName: null,
        metadata: {}
      });
      continue;
    }

    if (type === "progress") {
      pushTimelineItem({
        timestamp,
        kind: "event",
        role: null,
        title: "Progress",
        body: extractClaudeContentBody(entry.content),
        toolName: null,
        metadata: {}
      });
      continue;
    }

    pushTimelineItem({
      timestamp,
      kind: "event",
      role: null,
      title: humanizeEventName(type),
      body: extractClaudeContentBody(entry),
      toolName: null,
      metadata: {}
    });
  }

  return {
    timeline,
    firstUserMessage
  };
}

function readClaudeJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function extractFirstUserMessage(entries: Array<Record<string, unknown>>): string {
  const firstUserEntry = entries.find((entry) => entry.type === "user");
  if (!firstUserEntry) {
    return "";
  }

  return extractClaudeMessageText(isRecord(firstUserEntry.message) ? firstUserEntry.message.content : null);
}

function readClaudeTimestamp(entry: Record<string, unknown> | null): string | number | null {
  if (!entry) {
    return null;
  }

  const timestamp = entry.timestamp;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return timestamp;
  }

  return null;
}

function readClaudeCwd(entry: Record<string, unknown> | null): string | null {
  if (!entry) {
    return null;
  }

  const cwd = entry.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
}

function readClaudeEntrypoint(entry: Record<string, unknown> | null): string | null {
  if (!entry) {
    return null;
  }

  const entrypoint = entry.entrypoint;
  return typeof entrypoint === "string" && entrypoint.trim() ? entrypoint.trim() : null;
}

function extractClaudeMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return entry.trim() ? [entry.trim()] : [];
      }

      if (!isRecord(entry)) {
        return [];
      }

      if (typeof entry.text === "string" && entry.text.trim()) {
        return [entry.text.trim()];
      }

      if (typeof entry.content === "string" && entry.content.trim()) {
        return [entry.content.trim()];
      }

      return [];
    })
    .join("\n\n")
    .trim();
}

function extractClaudeContentBody(content: unknown): string {
  const text = extractClaudeMessageText(content);
  if (text) {
    return text;
  }

  return stringifySnippet(content);
}

function scanClaudeProjectSessions(baseDir: string): Array<{
  sessionId: string;
  transcriptPath: string;
  projectDirName: string;
}> {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const projectDirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const results: Array<{
    sessionId: string;
    transcriptPath: string;
    projectDirName: string;
  }> = [];

  for (const projectDir of projectDirs) {
    const projectPath = path.join(baseDir, projectDir.name);
    const entries = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      results.push({
        sessionId: path.basename(entry.name, ".jsonl"),
        transcriptPath: path.join(projectPath, entry.name),
        projectDirName: projectDir.name
      });
    }
  }

  return results;
}

function scanClaudeMemoryFiles(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const results: string[] = [];
  const projectDirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const projectDir of projectDirs) {
    const memoryDir = path.join(baseDir, projectDir.name, "memory");
    if (!fs.existsSync(memoryDir)) {
      continue;
    }

    const memoryFiles = fs.readdirSync(memoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(memoryDir, entry.name));
    results.push(...memoryFiles);
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function readClaudeHistoryIndex(homeDir: string): Map<string, ClaudeHistoryEntry> {
  const filePath = path.join(homeDir, "history.jsonl");
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const index = new Map<string, ClaudeHistoryEntry>();
  const lines = fs.readFileSync(filePath, "utf8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || typeof parsed.sessionId !== "string") {
      continue;
    }

    const timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp : Number.MAX_SAFE_INTEGER;
    const nextRecord: ClaudeHistoryEntry = {
      title: typeof parsed.display === "string" && parsed.display.trim() ? parsed.display.trim() : null,
      projectPath: typeof parsed.project === "string" && parsed.project.trim() ? parsed.project.trim() : null,
      timestamp
    };
    const existing = index.get(parsed.sessionId);
    if (!existing || nextRecord.timestamp < existing.timestamp) {
      index.set(parsed.sessionId, nextRecord);
      continue;
    }

    if (!existing.title && nextRecord.title) {
      existing.title = nextRecord.title;
    }

    if (!existing.projectPath && nextRecord.projectPath) {
      existing.projectPath = nextRecord.projectPath;
    }
  }

  return index;
}

function readClaudeSessionMetadataIndex(homeDir: string): Map<string, ClaudeSessionMetadata> {
  const sessionsDir = path.join(homeDir, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return new Map();
  }

  const index = new Map<string, ClaudeSessionMetadata>();
  const files = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

  for (const entry of files) {
    const filePath = path.join(sessionsDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.sessionId !== "string") {
        continue;
      }

      index.set(parsed.sessionId, {
        cwd: typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : null,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null
      });
    } catch {
      continue;
    }
  }

  return index;
}

function parseClaudeHooks(sourcePath: string, value: unknown): HookRecord[] {
  if (!isRecord(value)) {
    return [];
  }

  const hooks: HookRecord[] = [];
  for (const [eventName, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    entries.forEach((entry, entryIndex) => {
      const matcher = isRecord(entry) && typeof entry.matcher === "string" && entry.matcher.trim()
        ? entry.matcher.trim()
        : null;
      const entryHooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];

      if (entryHooks.length === 0) {
        const command = stringifySnippet(entry);
        hooks.push({
          id: createHookId(sourcePath, eventName, entryIndex, 0),
          name: matcher ? `${eventName} (${matcher})` : eventName,
          preview: createPreview(command),
          kind: "config",
          source: sourcePath,
          command
        });
        return;
      }

      entryHooks.forEach((hook, hookIndex) => {
        const hookRecord = isRecord(hook) ? hook : {};
        const command = typeof hookRecord.command === "string"
          ? hookRecord.command
          : stringifySnippet(hook);
        const kind = typeof hookRecord.type === "string" ? hookRecord.type : "unknown";
        hooks.push({
          id: createHookId(sourcePath, eventName, entryIndex, hookIndex),
          name: matcher ? `${eventName} (${matcher})` : eventName,
          preview: createPreview(command),
          kind,
          source: sourcePath,
          command
        });
      });
    });
  }

  return hooks.sort((left, right) => left.name.localeCompare(right.name) || left.preview.localeCompare(right.preview));
}

function readClaudeMcpServerUrl(value: unknown): string | null {
  if (!isRecord(value) || typeof value.url !== "string" || !value.url.trim()) {
    return null;
  }

  return value.url.trim();
}

function scanClaudeSkills(baseDir: string): SkillRecord[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const records: SkillRecord[] = [];

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      const markdownFile = findClaudeSkillMarkdown(fullPath);
      if (!markdownFile) {
        continue;
      }

      const parsed = parseClaudeSkillFile(markdownFile, entry.name);
      records.push({
        id: createSkillId(markdownFile),
        name: parsed.name,
        description: parsed.description,
        path: markdownFile,
        source: "claude-code"
      });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const parsed = parseClaudeSkillFile(fullPath, path.basename(entry.name, ".md"));
      records.push({
        id: createSkillId(fullPath),
        name: parsed.name,
        description: parsed.description,
        path: fullPath,
        source: "claude-code"
      });
    }
  }

  return records;
}

function findClaudeSkillMarkdown(skillDir: string): string | null {
  const files = fs.readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => {
      if (left.name === "SKILL.md") {
        return -1;
      }

      if (right.name === "SKILL.md") {
        return 1;
      }

      return left.name.localeCompare(right.name);
    });
  return files[0] ? path.join(skillDir, files[0].name) : null;
}

function parseClaudeSkillFile(filePath: string, fallbackName: string): { name: string; description: string } {
  const content = fs.readFileSync(filePath, "utf8");
  const frontmatter = extractFrontmatter(content);
  const lines = content.split("\n").map((line) => line.trim());
  const heading = lines.find((line) => line.startsWith("# "));
  const bodyLine = lines.find((line) => (
    Boolean(line)
    && !line.startsWith("---")
    && !line.startsWith("name:")
    && !line.startsWith("description:")
    && !line.startsWith("# ")
  ));

  return {
    name: normalizeSkillField(frontmatter.name ?? heading?.slice(2) ?? fallbackName),
    description: normalizeSkillField(frontmatter.description ?? bodyLine ?? "")
  };
}

function extractFrontmatter(content: string): { name: string | null; description: string | null } {
  if (!content.startsWith("---")) {
    return { name: null, description: null };
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { name: null, description: null };
  }

  const frontmatter = content.slice(3, endIndex).split("\n");
  let name: string | null = null;
  let description: string | null = null;

  for (const line of frontmatter) {
    if (line.startsWith("name:")) {
      name = stripQuotes(line.slice(5).trim());
    }

    if (line.startsWith("description:")) {
      description = stripQuotes(line.slice(12).trim());
    }
  }

  return { name, description };
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }

  return content.slice(endIndex + 4);
}

function normalizeSkillField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSessionTitle(value: string | null | undefined, fallbackId: string): string {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
  return normalized ? createPreview(normalized) : `Session ${fallbackId}`;
}

function decodeClaudeProjectDir(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const restored = value.replace(/-/g, "/");
  const absolutePath = restored.startsWith("/") ? restored : `/${restored}`;
  return path.normalize(absolutePath);
}

function createPreview(value: string, maxLength = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function createSkillId(filePath: string): string {
  return createStableId("skill", filePath);
}

function createHookId(sourcePath: string, eventName: string, entryIndex: number, hookIndex: number): string {
  return createStableId("hook", `${sourcePath}\n${eventName}\n${entryIndex}\n${hookIndex}`);
}

function createStableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
