import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  subagentAttributionResponseSchema,
  toolAttributionResponseSchema
} from "@codex-monitor/shared";
import { buildServer } from "../../server";
import { createTestFixture } from "../../test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];
const apps: FastifyInstance[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-14T19:10:00+09:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("token attribution routes", () => {
  it("returns empty attribution responses", async () => {
    const { app } = await createAppWithCleanTokenCache();

    const toolResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution"
    });
    const subagentResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/subagent-attribution"
    });

    expect(toolResponse.statusCode).toBe(200);
    expect(toolAttributionResponseSchema.parse(toolResponse.json())).toEqual({ tools: [] });
    expect(subagentResponse.statusCode).toBe(200);
    expect(subagentAttributionResponseSchema.parse(subagentResponse.json())).toEqual({
      root: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      subagents: [],
      notes: ["Claude Code Task tool sub-agents are counted in root sessions."]
    });
  });

  it("returns tool attribution sorted by attributed tokens", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertAttribution(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-codex.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        provider: "codex",
        toolName: "rg",
        callCount: 2,
        inputTokens: 30,
        outputTokens: 10
      });
      insertAttribution(database, {
        rolloutPath: "/tmp/.claude/projects/session.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        provider: "claude-code",
        toolName: "Bash",
        callCount: 1,
        inputTokens: 20,
        outputTokens: 15
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution"
    });

    expect(response.statusCode).toBe(200);
    expect(toolAttributionResponseSchema.parse(response.json()).tools).toEqual([
      {
        toolName: "rg",
        provider: "codex",
        callCount: 2,
        inputTokens: 30,
        outputTokens: 10,
        estimated: true
      },
      {
        toolName: "Bash",
        provider: "claude_code",
        callCount: 1,
        inputTokens: 20,
        outputTokens: 15,
        estimated: false
      }
    ]);
  });

  it("applies attribution ranges", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertAttribution(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-old.jsonl",
        hourBucket: "2026-02-20T10:00:00",
        provider: "codex",
        toolName: "old-tool",
        callCount: 1,
        inputTokens: 80,
        outputTokens: 20
      });
    });

    const sevenDayResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution?range=7d"
    });
    const thirtyDayResponse = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution?range=30d"
    });

    expect(toolAttributionResponseSchema.parse(sevenDayResponse.json()).tools).toEqual([]);
    expect(toolAttributionResponseSchema.parse(thirtyDayResponse.json()).tools).toEqual([
      {
        toolName: "old-tool",
        provider: "codex",
        callCount: 1,
        inputTokens: 80,
        outputTokens: 20,
        estimated: true
      }
    ]);
  });

  it("filters attribution by provider", async () => {
    const { app, databasePath } = await createAppWithCleanTokenCache();
    withDatabase(databasePath, (database) => {
      insertAttribution(database, {
        rolloutPath: "/tmp/.codex/sessions/rollout-codex.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        provider: "codex",
        toolName: "rg",
        callCount: 1,
        inputTokens: 30,
        outputTokens: 10
      });
      insertAttribution(database, {
        rolloutPath: "/tmp/.claude/projects/session.jsonl",
        hourBucket: "2026-03-14T10:00:00",
        provider: "claude-code",
        toolName: "Bash",
        callCount: 1,
        inputTokens: 20,
        outputTokens: 15
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution?provider=claude_code"
    });

    expect(response.statusCode).toBe(200);
    expect(toolAttributionResponseSchema.parse(response.json()).tools).toEqual([
      {
        toolName: "Bash",
        provider: "claude_code",
        callCount: 1,
        inputTokens: 20,
        outputTokens: 15,
        estimated: false
      }
    ]);
  });

  it("separates root and subagent attribution", async () => {
    const { app, databasePath, fixture } = await createAppWithCleanTokenCache();
    const subagentRolloutPath = path.join(
      fixture.config.providers.codex.codexHome,
      "sessions",
      "2026",
      "03",
      "14",
      "rollout-explorer.jsonl"
    );

    withDatabase(databasePath, (database) => {
      insertAttribution(database, {
        rolloutPath: fixture.rolloutPath,
        hourBucket: "2026-03-14T10:00:00",
        provider: "codex",
        toolName: "rg",
        callCount: 1,
        inputTokens: 30,
        outputTokens: 10
      });
      insertAttribution(database, {
        rolloutPath: subagentRolloutPath,
        hourBucket: "2026-03-14T10:10:00",
        provider: "codex",
        toolName: "sed",
        callCount: 1,
        inputTokens: 50,
        outputTokens: 25
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/subagent-attribution"
    });

    expect(response.statusCode).toBe(200);
    expect(subagentAttributionResponseSchema.parse(response.json())).toEqual({
      root: {
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40
      },
      subagents: [
        {
          sessionId: "thread-5",
          parentSessionId: "thread-1",
          provider: "codex",
          inputTokens: 50,
          outputTokens: 25,
          totalTokens: 75,
          estimated: true
        }
      ],
      notes: ["Claude Code Task tool sub-agents are counted in root sessions."]
    });
  });

  it("rejects invalid attribution queries", async () => {
    const { app } = await createAppWithCleanTokenCache();

    const response = await app.inject({
      method: "GET",
      url: "/api/tokens/tool-attribution?range=14d"
    });

    expect(response.statusCode).toBe(400);
  });
});

async function createAppWithCleanTokenCache(): Promise<{
  app: FastifyInstance;
  databasePath: string;
  fixture: ReturnType<typeof createTestFixture>;
}> {
  const fixture = createTestFixture();
  fixtures.push(fixture);
  const app = await buildServer(fixture.config);
  apps.push(app);
  withDatabase(fixture.config.monitorDbPath, resetTokenCache);
  return {
    app,
    databasePath: fixture.config.monitorDbPath,
    fixture
  };
}

function withDatabase(databasePath: string, callback: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    callback(database);
  } finally {
    database.close();
  }
}

function resetTokenCache(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM cache_break_event;
    DELETE FROM rollout_hourly_usage;
    DELETE FROM rollout_hourly_model_usage;
    DELETE FROM tool_token_attribution;
  `);
}

function insertAttribution(
  database: DatabaseSync,
  input: {
    rolloutPath: string;
    hourBucket: string;
    provider: "claude-code" | "codex";
    toolName: string;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
  }
): void {
  database.prepare(`
    INSERT INTO tool_token_attribution (
      rollout_path,
      hour_bucket,
      provider,
      tool_name,
      call_count,
      attributed_input_tokens,
      attributed_output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rolloutPath,
    input.hourBucket,
    input.provider,
    input.toolName,
    input.callCount,
    input.inputTokens,
    input.outputTokens
  );
}
