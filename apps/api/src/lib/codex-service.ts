import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import type {
  DailyTokenPoint,
  HookDetail,
  HookSummary,
  IntegrationsResponse,
  McpServerSummary,
  MemoryEntry,
  MemoryResponse,
  OverviewResponse,
  ProjectSummary,
  SessionDetail,
  SessionListItem,
  SessionTimelineItem,
  SkillDetail,
  SkillSummary,
  TokenBreakdown,
  TokenSeriesPoint
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
import { formatDayKey, formatHourBucket, fromEpochSeconds, humanizeEventName, stringifySnippet, toLocalDateTime } from "./format";
import type { MonitorProviderAdapter, OverviewTokenSnapshot, ProjectQueryOptions, SessionQueryOptions } from "./provider-adapter";
import { resolveProjectInfoFromCwd } from "./project-resolver";

const INTEGRATIONS_STALE_MS = 5 * 60 * 1000;
const MCP_USAGE_PARSE_VERSION = "1";

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  sandbox_policy: string;
  approval_mode: string;
  tokens_used: number;
  first_user_message: string;
  agent_nickname: string | null;
  agent_role: string | null;
  memory_mode: string;
}

interface TokenState {
  totalTokens: number;
  threadCount: number;
  latestThreadUpdatedAt: string | null;
}

interface HookRecord {
  id: string;
  name: string;
  preview: string;
  kind: string;
  source: string;
  command: string;
}

interface ParsedConfig {
  hooks: HookRecord[];
  mcpServers: Array<{ name: string; url: string | null }>;
  developerInstructions: string | null;
  personality: string | null;
}

interface SkillsCacheEntry {
  expiresAt: number;
  value: SkillRecord[];
}

interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSummary["source"];
}

interface ProjectInfo {
  projectId: string;
  projectName: string;
  projectPath: string;
}

interface SourceInfo {
  isSubagent: boolean;
  parentThreadId: string | null;
  subagentDepth: number | null;
  subagentNickname: string | null;
  subagentRole: string | null;
}

interface MonitorRolloutFileState {
  rolloutPath: string;
  fileSize: number;
  mtimeMs: number;
}

interface McpUsageIndexStateRow {
  rollout_path: string;
  file_size: number;
  mtime_ms: number;
  indexed_at: string;
  parse_version: string;
}

interface McpUsageRefreshStateRow {
  cache_key: string;
  last_synced_at: string | null;
  status: "success" | "warning" | "failure";
  message: string;
}

interface McpUsageSyncPreparation {
  totalRollouts: number;
  changedFiles: MonitorRolloutFileState[];
  deletedPaths: string[];
  hasCache: boolean;
}

export class CodexDataService implements MonitorProviderAdapter {
  readonly id = "codex" as const;
  private skillsCache: SkillsCacheEntry | null = null;
  private readonly projectInfoCache = new Map<string, ProjectInfo>();
  private readonly stateDbPath: string;
  private integrationsRefreshPromise: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {
    this.stateDbPath = resolveLatestSqlite(config.providers.codex.codexHome, /^state_\d+\.sqlite$/);
  }

  ensureMonitorSchema(): void {
    fs.mkdirSync(path.dirname(this.config.monitorDbPath), { recursive: true });
    const database = this.openMonitorDb();
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_usage_rollup (
        rollout_path TEXT NOT NULL,
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        usage_count INTEGER NOT NULL,
        PRIMARY KEY (rollout_path, server_name, tool_name)
      );

      CREATE TABLE IF NOT EXISTS mcp_usage_index_state (
        rollout_path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        parse_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_usage_refresh_state (
        cache_key TEXT PRIMARY KEY,
        last_synced_at TEXT,
        status TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    database.close();
  }

  getOverview(tokens: OverviewTokenSnapshot): OverviewResponse {
    const threads = this.readAllThreads();
    const configData = this.readConfigToml();
    const skills = this.getSkillInventory();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayEpoch = Math.floor(startOfToday.getTime() / 1000);

    return overviewResponseSchema.parse({
      stats: {
        totalSessions: threads.length,
        activeToday: threads.filter((thread) => thread.updated_at >= todayEpoch).length,
        totalSkills: skills.length,
        totalMcpServers: configData.mcpServers.length,
        totalHooks: configData.hooks.length,
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
    const includeSubagents = options.includeSubagents ?? false;
    const sort = options.sort ?? "updatedAt";
    const order = options.order ?? "desc";
    const limit = options.limit ?? 200;

    const sessions = this.readAllThreads()
      .map((thread) => this.normalizeThread(thread))
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
    const projects = new Map<string, ProjectSummary & { updatedAtEpoch: number; lastRootUpdatedAtEpoch: number }>();

    for (const session of this.readAllThreads().map((thread) => this.normalizeThread(thread))) {
      const project = {
        projectId: session.projectId,
        projectName: session.projectName,
        projectPath: session.projectPath
      };
      const existing = projects.get(project.projectId);
      const updatedAtEpoch = Date.parse(session.updatedAt);

      if (!existing) {
        projects.set(project.projectId, {
          id: project.projectId,
          name: project.projectName,
          path: project.projectPath,
          sessionCount: session.isSubagent ? 0 : 1,
          subagentCount: session.isSubagent ? 1 : 0,
          updatedAt: session.updatedAt,
          lastSessionTitle: session.isSubagent ? session.title : session.title,
          updatedAtEpoch,
          lastRootUpdatedAtEpoch: session.isSubagent ? Number.NEGATIVE_INFINITY : updatedAtEpoch
        });
        continue;
      }

      if (session.isSubagent) {
        existing.subagentCount += 1;
      } else {
        existing.sessionCount += 1;
      }

      if (updatedAtEpoch >= existing.updatedAtEpoch) {
        existing.updatedAtEpoch = updatedAtEpoch;
        existing.updatedAt = session.updatedAt;
      }

      if (!session.isSubagent && updatedAtEpoch >= existing.lastRootUpdatedAtEpoch) {
        existing.lastRootUpdatedAtEpoch = updatedAtEpoch;
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
      .map(({ updatedAtEpoch, lastRootUpdatedAtEpoch, ...project }) => project);
  }

  getSessionDetail(id: string): SessionDetail | null {
    const database = this.openStateDb();
    const row = database.prepare(`
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        first_user_message,
        agent_nickname,
        agent_role,
        memory_mode
      FROM threads
      WHERE id = ?
    `).get(id) as ThreadRow | undefined;
    database.close();

    if (!row) {
      return null;
    }

    const normalized = this.normalizeThread(row);
    const parsed = parseRolloutTimeline(row.rollout_path);
    const allSessions = this.readAllThreads().map((thread) => this.normalizeThread(thread));
    const parentSession = normalized.parentThreadId
      ? allSessions.find((session) => session.id === normalized.parentThreadId) ?? null
      : null;
    const subagents = normalized.isSubagent
      ? []
      : allSessions
        .filter((session) => session.parentThreadId === normalized.id)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .map((session) => ({
          id: session.id,
          title: session.title,
          cwd: session.cwd,
          updatedAt: session.updatedAt,
          subagentDepth: session.subagentDepth,
          subagentNickname: session.subagentNickname,
          subagentRole: session.subagentRole
        }));

    return sessionDetailSchema.parse({
      ...normalized,
      rolloutPath: row.rollout_path,
      firstUserMessage: row.first_user_message ?? "",
      parentSessionId: parentSession?.id ?? normalized.parentThreadId,
      parentSessionTitle: parentSession?.title ?? null,
      subagents,
      tokenSeries: parsed.tokenSeries,
      timeline: parsed.timeline
    });
  }

  getMemory(): MemoryResponse {
    const database = this.openStateDb();
    const configData = this.readConfigToml();
    const modeRows = database.prepare(`
      SELECT memory_mode AS mode, COUNT(*) AS count
      FROM threads
      GROUP BY memory_mode
      ORDER BY count DESC, mode ASC
    `).all() as Array<{ mode: string; count: number }>;

    const hasStage1OutputsTable = hasTable(database, "stage1_outputs");
    let entries: MemoryEntry[] = [];
    let stage1OutputCount = 0;
    if (hasStage1OutputsTable) {
      const countRow = database.prepare(`
        SELECT COUNT(*) AS count
        FROM stage1_outputs
      `).get() as { count: number };
      stage1OutputCount = countRow.count;
      const rows = database.prepare(`
        SELECT
          stage1_outputs.thread_id AS thread_id,
          threads.title AS title,
          stage1_outputs.raw_memory AS raw_memory,
          stage1_outputs.rollout_summary AS rollout_summary,
          stage1_outputs.usage_count AS usage_count,
          stage1_outputs.last_usage AS last_usage,
          stage1_outputs.generated_at AS generated_at
        FROM stage1_outputs
        JOIN threads ON threads.id = stage1_outputs.thread_id
        ORDER BY stage1_outputs.generated_at DESC
      `).all() as Array<{
        thread_id: string;
        title: string;
        raw_memory: string;
        rollout_summary: string;
        usage_count: number | null;
        last_usage: number | null;
        generated_at: number;
      }>;

      entries = rows.map((row) => ({
        provider: "codex",
        threadId: row.thread_id,
        title: row.title,
        rawMemory: row.raw_memory,
        rolloutSummary: row.rollout_summary,
        usageCount: row.usage_count,
        lastUsage: fromEpochSeconds(row.last_usage),
        generatedAt: fromEpochSeconds(row.generated_at) ?? ""
      }));
    }

    const totalThreads = database.prepare(`SELECT COUNT(*) AS count FROM threads`).get() as { count: number };
    database.close();
    const sourceStatus = hasStage1OutputsTable
      ? (stage1OutputCount > 0 ? "ready" : "empty")
      : "unsupported";
    const providerConfigs = [{
      provider: "codex" as const,
      developerInstructions: configData.developerInstructions,
      personality: configData.personality,
      sourceStatus,
      entryCount: entries.length,
      totalThreads: totalThreads.count
    }];

    return memoryResponseSchema.parse({
      entries,
      providerConfigs,
      modeCounts: modeRows.map((row) => ({
        mode: row.mode,
        count: row.count
      })),
      totalThreads: totalThreads.count,
      hasStage1OutputsTable,
      stage1OutputCount,
      sourceStatus,
      developerInstructions: configData.developerInstructions,
      personality: configData.personality
    });
  }

  getIntegrations(): IntegrationsResponse {
    this.ensureMonitorSchema();
    const configData = this.readConfigToml();
    const refreshState = this.readMcpUsageRefreshState();
    const isStale = isIntegrationsCacheStale(refreshState?.lastSyncedAt ?? null);
    if (isStale) {
      void this.refreshIntegrationsUsageInBackground();
    }

    const usageMap = this.readIndexedMcpUsage();
    const mcpServers = mergeMcpServers(configData.mcpServers, usageMap);
    const skills = this.getSkillInventory();

    return integrationsResponseSchema.parse({
      mcpServers,
      skills,
      hooks: configData.hooks.map(({ id, name, preview, kind, source }) => ({
        id,
        name,
        preview,
        kind,
        source
      })),
      lastSyncedAt: refreshState?.lastSyncedAt ?? null,
      isStale
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

  getHookDetail(id: string): HookDetail | null {
    const hook = this.readConfigToml().hooks.find((item) => item.id === id);
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

  refreshIntegrationsUsage(now = new Date()): void {
    this.ensureMonitorSchema();
    const preparation = this.prepareMcpUsageSyncState();
    const startedAt = toLocalDateTime(now) ?? "";
    const database = this.openMonitorDb();

    try {
      database.exec("BEGIN");

      for (const rolloutPath of preparation.deletedPaths) {
        database.prepare(`DELETE FROM mcp_usage_rollup WHERE rollout_path = ?`).run(rolloutPath);
        database.prepare(`DELETE FROM mcp_usage_index_state WHERE rollout_path = ?`).run(rolloutPath);
      }

      for (const file of preparation.changedFiles) {
        database.prepare(`DELETE FROM mcp_usage_rollup WHERE rollout_path = ?`).run(file.rolloutPath);
        const parsed = parseMcpUsageRollout(file.rolloutPath);
        const insertUsage = database.prepare(`
          INSERT INTO mcp_usage_rollup (
            rollout_path,
            server_name,
            tool_name,
            usage_count
          ) VALUES (?, ?, ?, ?)
        `);

        for (const [serverName, tools] of parsed.entries()) {
          for (const [toolName, usageCount] of tools.entries()) {
            insertUsage.run(file.rolloutPath, serverName, toolName, usageCount);
          }
        }

        database.prepare(`
          INSERT INTO mcp_usage_index_state (
            rollout_path,
            file_size,
            mtime_ms,
            indexed_at,
            parse_version
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(rollout_path) DO UPDATE SET
            file_size = excluded.file_size,
            mtime_ms = excluded.mtime_ms,
            indexed_at = excluded.indexed_at,
            parse_version = excluded.parse_version
        `).run(
          file.rolloutPath,
          file.fileSize,
          file.mtimeMs,
          startedAt,
          MCP_USAGE_PARSE_VERSION
        );
      }

      const finishedAt = toLocalDateTime(new Date()) ?? startedAt;
      database.prepare(`
        INSERT INTO mcp_usage_refresh_state (
          cache_key,
          last_synced_at,
          status,
          message
        ) VALUES ('default', ?, 'success', ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          status = excluded.status,
          message = excluded.message
      `).run(
        finishedAt,
        buildMcpUsageRefreshMessage(preparation)
      );

      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so we can still surface the original error.
      }

      database.prepare(`
        INSERT INTO mcp_usage_refresh_state (
          cache_key,
          last_synced_at,
          status,
          message
        ) VALUES ('default', NULL, 'failure', ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          status = excluded.status,
          message = excluded.message
      `).run(error instanceof Error ? error.message : "Unknown error");
      throw error;
    } finally {
      database.close();
    }
  }

  refreshIntegrationsUsageInBackground(): Promise<void> {
    if (this.integrationsRefreshPromise) {
      return this.integrationsRefreshPromise;
    }

    this.integrationsRefreshPromise = Promise.resolve()
      .then(() => {
        this.refreshIntegrationsUsage(new Date());
      })
      .catch(() => {
        // Background refresh failure is reflected in refresh state.
      })
      .finally(() => {
        this.integrationsRefreshPromise = null;
      });

    return this.integrationsRefreshPromise;
  }

  ensureFreshIntegrationsUsage(): Promise<void> {
    this.ensureMonitorSchema();
    const refreshState = this.readMcpUsageRefreshState();
    if (!isIntegrationsCacheStale(refreshState?.lastSyncedAt ?? null)) {
      return Promise.resolve();
    }

    return this.refreshIntegrationsUsageInBackground();
  }

  private getSkillRecords(): SkillRecord[] {
    if (this.skillsCache && this.skillsCache.expiresAt > Date.now()) {
      return this.skillsCache.value;
    }

    const value = [
      ...scanSkills(path.join(this.config.providers.codex.codexHome, "skills"), "codex"),
      ...scanSkills(path.join(this.config.providers.codex.agentsHome, "skills"), "agents")
    ].sort((left, right) => left.name.localeCompare(right.name));

    this.skillsCache = {
      expiresAt: Date.now() + 60_000,
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

  getCurrentTokenState(): TokenState {
    const database = this.openStateDb();
    const row = database.prepare(`
      SELECT
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        COUNT(*) AS thread_count,
        MAX(updated_at) AS latest_updated_at
      FROM threads
    `).get() as {
      total_tokens: number;
      thread_count: number;
      latest_updated_at: number | null;
    };
    database.close();

    return {
      totalTokens: row.total_tokens,
      threadCount: row.thread_count,
      latestThreadUpdatedAt: fromEpochSeconds(row.latest_updated_at)
    };
  }

  getSessionRoot(): string {
    return path.join(this.config.providers.codex.codexHome, "sessions");
  }

  resolveProjectInfoForRolloutPath(rolloutPath: string): ProjectInfo | null {
    const database = this.openStateDb();
    const row = database.prepare(`
      SELECT cwd
      FROM threads
      WHERE rollout_path = ?
      LIMIT 1
    `).get(rolloutPath) as { cwd: string } | undefined;
    database.close();

    if (!row?.cwd) {
      return null;
    }

    return this.resolveProjectInfo(row.cwd);
  }

  private readIndexedMcpUsage(): Map<string, { usageCount: number; toolNames: Set<string> }> {
    const database = this.openMonitorDb();
    const rows = database.prepare(`
      SELECT
        server_name,
        tool_name,
        SUM(usage_count) AS usage_count
      FROM mcp_usage_rollup
      GROUP BY server_name, tool_name
    `).all() as Array<{
      server_name: string;
      tool_name: string;
      usage_count: number;
    }>;
    database.close();

    const usageMap = new Map<string, { usageCount: number; toolNames: Set<string> }>();
    for (const row of rows) {
      const entry = usageMap.get(row.server_name) ?? { usageCount: 0, toolNames: new Set<string>() };
      entry.usageCount += row.usage_count;
      entry.toolNames.add(row.tool_name);
      usageMap.set(row.server_name, entry);
    }

    return usageMap;
  }

  private readMcpUsageRefreshState(): { lastSyncedAt: string | null; status: string; message: string } | null {
    const database = this.openMonitorDb();
    const row = database.prepare(`
      SELECT
        last_synced_at,
        status,
        message
      FROM mcp_usage_refresh_state
      WHERE cache_key = 'default'
    `).get() as {
      last_synced_at: string | null;
      status: string;
      message: string;
    } | undefined;
    database.close();

    if (!row) {
      return null;
    }

    return {
      lastSyncedAt: row.last_synced_at,
      status: row.status,
      message: row.message
    };
  }

  private prepareMcpUsageSyncState(): McpUsageSyncPreparation {
    const files = scanMonitorRolloutFiles(this.getSessionRoot());
    const database = this.openMonitorDb();
    const indexedRows = database.prepare(`
      SELECT
        rollout_path,
        file_size,
        mtime_ms,
        indexed_at,
        parse_version
      FROM mcp_usage_index_state
    `).all() as unknown as McpUsageIndexStateRow[];
    const usageCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM mcp_usage_rollup
    `).get() as { count: number };
    database.close();

    const indexedMap = new Map(indexedRows.map((row) => [row.rollout_path, row]));
    const currentPaths = new Set<string>();
    const changedFiles: MonitorRolloutFileState[] = [];

    for (const file of files) {
      currentPaths.add(file.rolloutPath);
      const previous = indexedMap.get(file.rolloutPath);
      if (
        !previous ||
        previous.file_size !== file.fileSize ||
        previous.mtime_ms !== file.mtimeMs ||
        previous.parse_version !== MCP_USAGE_PARSE_VERSION
      ) {
        changedFiles.push(file);
      }
    }

    const deletedPaths = indexedRows
      .map((row) => row.rollout_path)
      .filter((rolloutPath) => !currentPaths.has(rolloutPath));

    return {
      totalRollouts: files.length,
      changedFiles,
      deletedPaths,
      hasCache: usageCount.count > 0 || indexedRows.length > 0
    };
  }

  private normalizeThread(row: ThreadRow): SessionListItem {
    const sourceInfo = parseSourceInfo(row.source, row.agent_nickname, row.agent_role);
    return mapThreadRow(row, this.resolveProjectInfo(row.cwd), sourceInfo);
  }

  private resolveProjectInfo(cwd: string): ProjectInfo {
    const resolvedCwd = path.resolve(cwd);
    const cached = this.projectInfoCache.get(resolvedCwd);
    if (cached) {
      return cached;
    }

    const info = resolveProjectInfoFromCwd(resolvedCwd);
    this.projectInfoCache.set(resolvedCwd, info);
    return info;
  }

  private readAllThreads(): ThreadRow[] {
    const database = this.openStateDb();
    const rows = database.prepare(`
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        first_user_message,
        agent_nickname,
        agent_role,
        memory_mode
      FROM threads
    `).all() as unknown as ThreadRow[];
    database.close();
    return rows;
  }

  private readConfigToml(): ParsedConfig {
    const filePath = path.join(this.config.providers.codex.codexHome, "config.toml");
    if (!fs.existsSync(filePath)) {
      return {
        hooks: [],
        mcpServers: [],
        developerInstructions: null,
        personality: null
      };
    }

    const parsed = parseToml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const hooks: HookRecord[] = [];
    const mcpServers: ParsedConfig["mcpServers"] = [];
    const developerInstructions = typeof parsed.developer_instructions === "string"
      ? parsed.developer_instructions.trim() || null
      : null;
    const personality = typeof parsed.personality === "string"
      ? parsed.personality.trim() || null
      : null;

    const notify = parsed.notify;
    if (Array.isArray(notify)) {
      const command = notify.join(" ");
      hooks.push({
        id: createHookId(filePath, "notify"),
        name: "notify",
        preview: createPreview(command),
        kind: "command",
        source: filePath,
        command
      });
    }

    const hooksConfig = parsed.hooks;
    if (hooksConfig && typeof hooksConfig === "object" && !Array.isArray(hooksConfig)) {
      for (const [name, value] of Object.entries(hooksConfig as Record<string, unknown>)) {
        const command = stringifySnippet(value);
        hooks.push({
          id: createHookId(filePath, name),
          name,
          preview: createPreview(command),
          kind: "config",
          source: filePath,
          command
        });
      }
    }

    const mcp = parsed.mcp_servers;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      for (const [name, value] of Object.entries(mcp as Record<string, unknown>)) {
        const url = typeof value === "object" && value && "url" in value
          ? String((value as Record<string, unknown>).url ?? "")
          : null;
        mcpServers.push({
          name,
          url: url || null
        });
      }
    }

    return { hooks, mcpServers, developerInstructions, personality };
  }

  private openStateDb(): DatabaseSync {
    return new DatabaseSync(this.stateDbPath);
  }

  private openMonitorDb(): DatabaseSync {
    return new DatabaseSync(this.config.monitorDbPath);
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

function mapThreadRow(row: ThreadRow, project: ProjectInfo, sourceInfo: SourceInfo): SessionListItem {
  return {
    id: row.id,
    provider: "codex",
    title: row.title,
    cwd: row.cwd,
    projectId: project.projectId,
    projectName: project.projectName,
    projectPath: project.projectPath,
    isSubagent: sourceInfo.isSubagent,
    parentThreadId: sourceInfo.parentThreadId,
    subagentDepth: sourceInfo.subagentDepth,
    subagentNickname: sourceInfo.subagentNickname,
    subagentRole: sourceInfo.subagentRole,
    createdAt: fromEpochSeconds(row.created_at) ?? "",
    updatedAt: fromEpochSeconds(row.updated_at) ?? "",
    tokensUsed: row.tokens_used,
    memoryMode: row.memory_mode,
    source: row.source,
    modelProvider: row.model_provider,
    approvalMode: row.approval_mode,
    sandboxPolicy: row.sandbox_policy,
    agentNickname: sourceInfo.subagentNickname,
    agentRole: sourceInfo.subagentRole
  };
}

function parseSourceInfo(value: string, fallbackNickname: string | null, fallbackRole: string | null): SourceInfo {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const spawn = parsed.subagent && typeof parsed.subagent === "object"
      ? (parsed.subagent as Record<string, unknown>).thread_spawn
      : null;
    if (spawn && typeof spawn === "object") {
      const record = spawn as Record<string, unknown>;
      return {
        isSubagent: true,
        parentThreadId: typeof record.parent_thread_id === "string" ? record.parent_thread_id : null,
        subagentDepth: typeof record.depth === "number" ? record.depth : null,
        subagentNickname: typeof record.agent_nickname === "string" ? record.agent_nickname : fallbackNickname,
        subagentRole: typeof record.agent_role === "string" ? record.agent_role : fallbackRole
      };
    }
  } catch {
    return {
      isSubagent: false,
      parentThreadId: null,
      subagentDepth: null,
      subagentNickname: fallbackNickname,
      subagentRole: fallbackRole
    };
  }

  return {
    isSubagent: false,
    parentThreadId: null,
    subagentDepth: null,
    subagentNickname: fallbackNickname,
    subagentRole: fallbackRole
  };
}

function parseRolloutTimeline(rolloutPath: string): { timeline: SessionTimelineItem[]; tokenSeries: TokenSeriesPoint[] } {
  if (!fs.existsSync(rolloutPath)) {
    return {
      timeline: [{
        id: "missing-rollout",
        timestamp: toLocalDateTime(new Date()) ?? "",
        kind: "event",
        role: null,
        title: "Missing session file",
        body: `Missing rollout file: ${rolloutPath}`,
        toolName: null,
        metadata: {}
      }],
      tokenSeries: []
    };
  }

  const timeline: SessionTimelineItem[] = [];
  const tokenSeries: TokenSeriesPoint[] = [];
  const toolCallById = new Map<string, { name: string | null }>();
  const lines = fs.readFileSync(rolloutPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line, index) => {
    const parsed = JSON.parse(line) as {
      timestamp?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };
    const payload = parsed.payload ?? {};
    const rawTimestamp = typeof parsed.timestamp === "string"
      ? parsed.timestamp
      : typeof payload.timestamp === "string"
        ? payload.timestamp
        : new Date();
    const timestamp = toLocalDateTime(rawTimestamp) ?? "";
    const id = `${index + 1}`;

    if (parsed.type === "session_meta") {
      timeline.push({
        id,
        timestamp,
        kind: "session_meta",
        role: null,
        title: "Session metadata",
        body: stringifySnippet({
          cwd: payload.cwd,
          cliVersion: payload.cli_version,
          modelProvider: payload.model_provider
        }),
        toolName: null,
        metadata: {}
      });
      return;
    }

    if (parsed.type === "response_item") {
      const itemType = String(payload.type ?? "");
      if (itemType === "message") {
        const role = typeof payload.role === "string" ? payload.role : null;
        const kind = role === "user"
          ? "user_message"
          : role === "assistant"
            ? "assistant_message"
            : role === "developer"
              ? "developer_message"
              : "system_message";

        timeline.push({
          id,
          timestamp,
          kind,
          role,
          title: `${role ?? "unknown"} message`,
          body: extractMessageBody(payload.content),
          toolName: null,
          metadata: {}
        });
        return;
      }

      if (itemType === "function_call") {
        const toolName = typeof payload.name === "string" ? payload.name : null;
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        if (callId) {
          toolCallById.set(callId, { name: toolName });
        }

        timeline.push({
          id,
          timestamp,
          kind: "tool_call",
          role: "assistant",
          title: `Tool call: ${String(payload.name ?? "unknown")}`,
          body: stringifySnippet(payload.arguments ?? ""),
          toolName,
          metadata: callId ? { callId } : {}
        });
        return;
      }

      if (itemType === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        const toolName = callId
          ? toolCallById.get(callId)?.name ?? null
          : typeof payload.name === "string"
            ? payload.name
            : null;

        timeline.push({
          id,
          timestamp,
          kind: "tool_result",
          role: "tool",
          title: toolName ? `Tool output: ${toolName}` : "Tool output",
          body: extractToolOutput(payload),
          toolName,
          metadata: callId ? { callId } : {}
        });
        return;
      }

      timeline.push({
        id,
        timestamp,
        kind: "event",
        role: null,
        title: `Response item: ${itemType || "unknown"}`,
        body: stringifySnippet(payload),
        toolName: null,
        metadata: {}
      });
      return;
    }

    if (parsed.type === "event_msg") {
      const eventType = typeof payload.type === "string" ? payload.type : "event";
      if (eventType === "token_count") {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const total = (info.total_token_usage ?? {}) as Record<string, number>;
        const last = (info.last_token_usage ?? {}) as Record<string, number>;
        tokenSeries.push({
          timestamp,
          totalTokens: Number(total.total_tokens ?? 0),
          inputTokens: numberOrNull(total.input_tokens),
          cachedInputTokens: numberOrNull(total.cached_input_tokens),
          outputTokens: numberOrNull(total.output_tokens),
          reasoningOutputTokens: numberOrNull(total.reasoning_output_tokens),
          lastTotalTokens: numberOrNull(last.total_tokens)
        });
        timeline.push({
          id,
          timestamp,
          kind: "token_count",
          role: null,
          title: "Token totals",
          body: `Total ${Number(total.total_tokens ?? 0).toLocaleString("en-US")} tokens`,
          toolName: null,
          metadata: {
            input: String(total.input_tokens ?? ""),
            output: String(total.output_tokens ?? ""),
            cached: String(total.cached_input_tokens ?? "")
          }
        });
        return;
      }

      timeline.push({
        id,
        timestamp,
        kind: "event",
        role: null,
        title: humanizeEventName(eventType),
        body: stringifySnippet(payload.summary ?? payload.info ?? payload.message ?? payload),
        toolName: null,
        metadata: {}
      });
      return;
    }

    timeline.push({
      id,
      timestamp,
      kind: "event",
      role: null,
      title: parsed.type ? humanizeEventName(parsed.type) : "Unknown",
      body: stringifySnippet(payload),
      toolName: null,
      metadata: {}
    });
  });

  return { timeline, tokenSeries };
}

function extractMessageBody(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const chunks = content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string"
      ? record.text
      : typeof record.output_text === "string"
        ? record.output_text
        : typeof record.input_text === "string"
          ? record.input_text
          : typeof record.encrypted_content === "string"
            ? "[encrypted content]"
            : null;

    return text ? [text] : [];
  });

  return chunks.join("\n\n").trim();
}

function extractToolOutput(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output)) {
    return output.map((item) => stringifySnippet(item)).join("\n\n");
  }

  if (output) {
    return stringifySnippet(output);
  }

  return stringifySnippet(payload);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function resolveLatestSqlite(baseDir: string, pattern: RegExp): string {
  const files = fs.readdirSync(baseDir)
    .filter((entry) => pattern.test(entry))
    .sort((left, right) => extractNumericSuffix(right) - extractNumericSuffix(left));

  if (files.length === 0) {
    throw new Error(`State sqlite file not found: ${baseDir}`);
  }

  return path.join(baseDir, files[0]);
}

function extractNumericSuffix(fileName: string): number {
  const match = fileName.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
  const row = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined;

  return Boolean(row?.name);
}

function mergeMcpServers(
  configuredServers: Array<{ name: string; url: string | null }>,
  usageMap: Map<string, { usageCount: number; toolNames: Set<string> }>
): McpServerSummary[] {
  const names = new Set<string>([
    ...configuredServers.map((server) => server.name),
    ...usageMap.keys()
  ]);

  return Array.from(names)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const configured = configuredServers.find((server) => server.name === name);
      const usage = usageMap.get(name);
      return {
        name,
        url: configured?.url ?? null,
        usageCount: usage?.usageCount ?? 0,
        toolNames: Array.from(usage?.toolNames ?? []).sort()
      };
    });
}

function scanSkills(baseDir: string, source: SkillSummary["source"]): SkillRecord[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const skillFiles = walkFiles(baseDir)
    .filter((filePath) => filePath.endsWith("SKILL.md"));

  return skillFiles.map((filePath) => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(0, 16);
    const nameLine = lines.find((line) => line.startsWith("name: "));
    const descriptionLine = lines.find((line) => line.startsWith("description: "));
    return {
      id: createSkillId(filePath),
      name: stripQuotes(nameLine?.slice(6) ?? path.basename(path.dirname(filePath))),
      description: stripQuotes(descriptionLine?.slice(13) ?? ""),
      path: filePath,
      source
    };
  });
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
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

function createHookId(source: string, name: string): string {
  return createStableId("hook", `${source}\n${name}`);
}

function createStableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function walkFiles(baseDir: string): string[] {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }

    results.push(fullPath);
  }

  return results;
}

function scanMonitorRolloutFiles(baseDir: string): MonitorRolloutFileState[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  return walkFiles(baseDir)
    .filter((filePath) => filePath.endsWith(".jsonl"))
    .map((rolloutPath) => {
      const stats = fs.statSync(rolloutPath);
      return {
        rolloutPath,
        fileSize: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs)
      };
    })
    .sort((left, right) => left.rolloutPath.localeCompare(right.rolloutPath));
}

function parseMcpUsageRollout(rolloutPath: string): Map<string, Map<string, number>> {
  const usageMap = new Map<string, Map<string, number>>();
  const lines = fs.readFileSync(rolloutPath, "utf8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as {
      type?: string;
      payload?: Record<string, unknown>;
    };

    if (parsed.type !== "response_item") {
      continue;
    }

    const payload = parsed.payload ?? {};
    if (payload.type !== "function_call" || typeof payload.name !== "string" || !payload.name.startsWith("mcp__")) {
      continue;
    }

    const match = payload.name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
    if (!match) {
      continue;
    }

    const [, serverName, toolName] = match;
    const tools = usageMap.get(serverName) ?? new Map<string, number>();
    tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
    usageMap.set(serverName, tools);
  }

  return usageMap;
}

function buildMcpUsageRefreshMessage(preparation: McpUsageSyncPreparation): string {
  if (preparation.changedFiles.length === 0 && preparation.deletedPaths.length === 0) {
    return "No changes";
  }

  return [
    `total ${preparation.totalRollouts}`,
    `updated ${preparation.changedFiles.length}`,
    `deleted ${preparation.deletedPaths.length}`
  ].join(" · ");
}

function isIntegrationsCacheStale(lastSyncedAt: string | null): boolean {
  const lastSyncedAtMs = lastSyncedAt ? Date.parse(lastSyncedAt) : Number.NaN;
  return !Number.isFinite(lastSyncedAtMs) || (Date.now() - lastSyncedAtMs) > INTEGRATIONS_STALE_MS;
}

export function createTokenFixturesForDay(points: TokenSeriesPoint[]): Array<{ hourBucket: string; total: number }> {
  return points.map((point) => ({
    hourBucket: formatHourBucket(new Date(point.timestamp)),
    total: point.totalTokens
  }));
}

export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

export { formatDayKey };
