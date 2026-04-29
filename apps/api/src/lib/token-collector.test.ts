import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeDataService } from "./claude-code-service";
import { CodexDataService } from "./codex-service";
import { BREAK_PARSE_VERSION, TokenCollectorService } from "./token-collector";
import { createClaudeCodeTestFixture } from "../test-support/claude-fixture";
import { createTestFixture } from "../test-support/fixture";

const fixtures: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("TokenCollectorService", () => {
  it("exposes the cache break parse version", () => {
    expect(BREAK_PARSE_VERSION).toBe("1");
  });

  it("migrates cache break local_date before creating cache break indexes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);
    fs.mkdirSync(path.dirname(fixture.config.monitorDbPath), { recursive: true });
    const setupDatabase = new DatabaseSync(fixture.config.monitorDbPath);
    setupDatabase.exec(`
      CREATE TABLE cache_break_event (
        rollout_path TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prev_hit_rate REAL NOT NULL,
        curr_hit_rate REAL NOT NULL,
        dropped_pp REAL NOT NULL,
        primary_cause TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        parse_version TEXT NOT NULL,
        PRIMARY KEY (rollout_path, turn_index)
      );
      CREATE INDEX idx_cache_break_ts
        ON cache_break_event(ts);
      CREATE INDEX idx_cache_break_provider_ts
        ON cache_break_event(provider, ts);
      INSERT INTO cache_break_event (
        rollout_path,
        turn_index,
        ts,
        provider,
        model,
        prev_hit_rate,
        curr_hit_rate,
        dropped_pp,
        primary_cause,
        confidence,
        evidence_json,
        parse_version
      ) VALUES (
        '/tmp/old-rollout.jsonl',
        1,
        1773463200000,
        'codex',
        'gpt-5.4',
        0.9,
        0.1,
        0.8,
        'unknown',
        'low',
        '{}',
        '1'
      );
    `);
    setupDatabase.close();

    const collector = new TokenCollectorService(fixture.config, [new CodexDataService(fixture.config)]);
    collector.ensureSchema();

    const verifyDatabase = new DatabaseSync(fixture.config.monitorDbPath);
    const columns = verifyDatabase.prepare(`PRAGMA table_info(cache_break_event)`).all() as Array<{ name: string }>;
    const indexes = verifyDatabase.prepare(`PRAGMA index_list(cache_break_event)`).all() as Array<{ name: string }>;
    verifyDatabase.prepare(`
      INSERT INTO cache_break_event (
        rollout_path,
        turn_index,
        ts,
        local_date,
        provider,
        model,
        prev_hit_rate,
        curr_hit_rate,
        dropped_pp,
        primary_cause,
        confidence,
        evidence_json,
        parse_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "/tmp/new-rollout.jsonl",
      2,
      1773463260000,
      "2026-03-14",
      "codex",
      "gpt-5.4",
      0.9,
      0.1,
      0.8,
      "unknown",
      "low",
      "{}",
      "1"
    );
    const rowCount = verifyDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM cache_break_event
    `).get() as { count: number };
    verifyDatabase.close();

    expect(columns.map((column) => column.name)).toContain("local_date");
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_cache_break_ts",
      "idx_cache_break_provider_ts",
      "idx_cache_break_provider_local_date"
    ]));
    expect(rowCount.count).toBe(2);
  });

  it("inserts cache break events while collecting rollout token turns", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rollout_path: fixture.rolloutPath,
      turn_index: 1,
      local_date: "2026-03-14",
      provider: "codex",
      model: "gpt-5.4",
      primary_cause: "context_rebuild",
      confidence: "low",
      parse_version: BREAK_PARSE_VERSION
    });
    expect(events[0]?.prev_hit_rate).toBeCloseTo(0.9, 6);
    expect(events[0]?.curr_hit_rate).toBeCloseTo(0.1, 6);
    expect(events[0]?.dropped_pp).toBeCloseTo(0.8, 6);
    expect(JSON.parse(events[0]!.evidence_json)).toMatchObject({
      prevCachedInputTokens: 900,
      currCachedInputTokens: 100
    });
  });

  it("extracts Claude Code turns for cache break events", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    writeClaudeCodeCacheBreakTranscript(fixture.primaryRolloutPath);

    collector.captureSnapshot(new Date("2026-03-18T10:05:00+09:00"));

    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rollout_path: fixture.primaryRolloutPath,
      turn_index: 1,
      local_date: "2026-03-18",
      provider: "claude_code",
      model: "claude-opus-4-6",
      primary_cause: "context_rebuild",
      confidence: "high",
      parse_version: BREAK_PARSE_VERSION
    });
    expect(events[0]?.prev_hit_rate).toBeCloseTo(0.9, 6);
    expect(events[0]?.curr_hit_rate).toBeCloseTo(0.1, 6);
  });

  it("recalculates cache break events when only the break parse version changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));
    const usageBefore = readRolloutUsageSummary(fixture.config.monitorDbPath, fixture.rolloutPath);
    overwriteCacheBreakEvidence(fixture.config.monitorDbPath, fixture.rolloutPath, {
      evidenceJson: JSON.stringify({ stale: true }),
      parseVersion: BREAK_PARSE_VERSION
    });

    vi.stubEnv("HARNESS_MONITOR_BREAK_PARSE_VERSION", "2");
    const result = collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    expect(result.stats.updatedRollouts).toBe(0);
    expect(readRolloutUsageSummary(fixture.config.monitorDbPath, fixture.rolloutPath)).toEqual(usageBefore);
    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]?.parse_version).toBe("2");
    expect(JSON.parse(events[0]!.evidence_json)).toMatchObject({
      prevCachedInputTokens: 900,
      currCachedInputTokens: 100
    });
  });

  it("refreshes cache break events as part of a rollout parse-version reindex", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));
    overwriteCacheBreakEvidence(fixture.config.monitorDbPath, fixture.rolloutPath, {
      evidenceJson: JSON.stringify({ stale: true }),
      parseVersion: BREAK_PARSE_VERSION
    });
    const database = new DatabaseSync(fixture.config.monitorDbPath);
    database.prepare(`
      UPDATE rollout_index_state
      SET parse_version = ?
      WHERE rollout_path = ?
    `).run("rollout-parse-v0", fixture.rolloutPath);
    database.close();

    const result = collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    expect(result.stats.updatedRollouts).toBe(1);
    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]?.parse_version).toBe(BREAK_PARSE_VERSION);
    expect(JSON.parse(events[0]!.evidence_json)).toMatchObject({
      prevCachedInputTokens: 900,
      currCachedInputTokens: 100
    });
  });

  it("wipes stale cache break rows during a rollout parse-version reindex", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));
    overwriteCacheBreakEvidence(fixture.config.monitorDbPath, fixture.rolloutPath, {
      evidenceJson: JSON.stringify({ stale: true }),
      parseVersion: BREAK_PARSE_VERSION
    });
    insertSyntheticCacheBreakRow(fixture.config.monitorDbPath, fixture.rolloutPath, 99);
    markRolloutParseVersionStale(fixture.config.monitorDbPath, fixture.rolloutPath);

    const result = collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    expect(result.stats.updatedRollouts).toBe(1);
    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events.map((event) => event.turn_index)).toEqual([1]);
    expect(JSON.parse(events[0]!.evidence_json)).toMatchObject({
      prevCachedInputTokens: 900,
      currCachedInputTokens: 100
    });
  });

  it("resets cache break comparison after a 24-hour idle gap", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexIdleGapCacheDropRollout(fixture.rolloutPath, fixture.rootDir, "2026-03-15T10:00:02.000Z");

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    expect(readCacheBreakRows(fixture.config.monitorDbPath)).toEqual([]);
  });

  it("keeps legitimate TTL cache breaks across a 4-hour idle gap", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexIdleGapCacheDropRollout(fixture.rolloutPath, fixture.rootDir, "2026-03-14T14:00:02.000Z");

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turn_index: 1,
      primary_cause: "ttl_expired"
    });
  });

  it("resets cache break comparison after a 25-hour idle gap", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexIdleGapCacheDropRollout(fixture.rolloutPath, fixture.rootDir, "2026-03-15T11:00:02.000Z");

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    expect(readCacheBreakRows(fixture.config.monitorDbPath)).toEqual([]);
  });

  it("removes stale cache break rows when rollout turns are deleted", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexAlternatingCacheBreakRollout(fixture.rolloutPath, fixture.rootDir, 5);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));
    expect(readCacheBreakRows(fixture.config.monitorDbPath).map((event) => event.turn_index)).toEqual([1, 3, 5, 7, 9]);

    writeCodexAlternatingCacheBreakRollout(fixture.rolloutPath, fixture.rootDir, 2);
    const result = collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    expect(result.stats.updatedRollouts).toBe(1);
    expect(readCacheBreakRows(fixture.config.monitorDbPath).map((event) => event.turn_index)).toEqual([1, 3]);
  });

  it("reprocesses a zero-event rollout when only the break parse state is stale", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    writeCodexNoCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));
    expect(readCacheBreakRows(fixture.config.monitorDbPath)).toEqual([]);

    writeCodexCacheBreakRollout(fixture.rolloutPath, fixture.rootDir);
    markBreakParseVersionStaleWithoutChangingRolloutState(fixture.config.monitorDbPath, fixture.rolloutPath);

    const result = collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    expect(result.stats.updatedRollouts).toBe(0);
    const events = readCacheBreakRows(fixture.config.monitorDbPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rollout_path: fixture.rolloutPath,
      turn_index: 1,
      parse_version: BREAK_PARSE_VERSION
    });
  });

  it("aggregates token_count events in rollout logs into daily and hourly usage", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T19:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(140);
    expect(tokens.daily[0]?.inputTokens).toBe(100);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(120);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(80);
    expect(tokens.daily[0]?.outputTokens).toBe(40);
    expect(tokens.dailyProviderTokens[0]).toEqual({
      day: "2026-03-14",
      codexTokens: 140,
      claudeCodeTokens: 0
    });
    expect(tokens.currentHourTokens.totalTokens).toBe(140);
    expect(tokens.currentHourTokens.cachedInputTokens).toBe(20);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(120);
    expect(tokens.hourly[0]?.totalTokens).toBe(140);
    expect(tokens.hourly[0]?.uncachedInputTokens).toBe(80);
    expect(tokens.hourly[0]?.requestCount).toBe(1);
    expect(tokens.daily[0]?.totalTokens).toBe(tokens.hourly.reduce((sum, row) => sum + row.totalTokens, 0));
    expect(tokens.daily[0]?.estimatedCost).toBeCloseTo(0.000805, 8);
    expect(tokens.hourly[0]?.estimatedCost).toBeCloseTo(0.000805, 8);
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 140
      }
    ]);
  });

  it("deduplicates consecutive token_count events that repeat the same cumulative totals", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-14T10:00:00.000Z",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-14T10:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        },
        {
          timestamp: "2026-03-14T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              }
            }
          }
        },
        {
          timestamp: "2026-03-14T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              }
            }
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      totalTokens: 140,
      inputTokens: 100,
      cachedInputTokens: 20,
      uncachedInputTokens: 80,
      outputTokens: 40
    });
    expect(tokens.hourly[0]).toMatchObject({
      totalTokens: 140,
      uncachedInputTokens: 80,
      requestCount: 1
    });
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 140
      }
    ]);
  });

  it("skips token_count events when cumulative totals stay flat even if last_token_usage changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-14T10:00:00.000Z",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-14T10:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        },
        {
          timestamp: "2026-03-14T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              }
            }
          }
        },
        {
          timestamp: "2026-03-14T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              },
              last_token_usage: {
                output_tokens: 10,
                total_tokens: 10
              }
            }
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      totalTokens: 140,
      inputTokens: 100,
      cachedInputTokens: 20,
      uncachedInputTokens: 80,
      outputTokens: 40
    });
    expect(tokens.hourly[0]).toMatchObject({
      totalTokens: 140,
      inputTokens: 100,
      cachedInputTokens: 20,
      uncachedInputTokens: 80,
      outputTokens: 40,
      requestCount: 1
    });
  });

  it("keeps token_count events when only some cumulative metrics increase and computes per-metric deltas", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-14T10:00:00.000Z",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-14T10:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        },
        {
          timestamp: "2026-03-14T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 40,
                total_tokens: 140
              }
            }
          }
        },
        {
          timestamp: "2026-03-14T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 30,
                output_tokens: 50,
                total_tokens: 150
              },
              last_token_usage: {
                cached_input_tokens: 10,
                output_tokens: 10,
                total_tokens: 10
              }
            }
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      totalTokens: 150,
      inputTokens: 100,
      cachedInputTokens: 30,
      uncachedInputTokens: 80,
      outputTokens: 50
    });
    expect(tokens.hourly[0]).toMatchObject({
      totalTokens: 150,
      inputTokens: 100,
      cachedInputTokens: 30,
      uncachedInputTokens: 80,
      outputTokens: 50,
      requestCount: 2
    });
  });

  it("attributes later token_count events to the model after turn_context changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-14T10:00:00.000Z",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-14T10:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        },
        {
          timestamp: "2026-03-14T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                total_tokens: 100
              },
              last_token_usage: {
                total_tokens: 100
              }
            }
          }
        },
        {
          timestamp: "2026-03-14T10:05:00.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.3-codex",
            collaboration_mode: {
              mode: "default",
              settings: {
                model: "gpt-5.3-codex"
              }
            }
          }
        },
        {
          timestamp: "2026-03-14T10:06:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                total_tokens: 160
              },
              last_token_usage: {
                total_tokens: 60
              }
            }
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 100
      },
      {
        modelName: "gpt-5.3-codex",
        modelProvider: "openai",
        totalTokens: 60
      }
    ]);
  });

  it("groups older logs without a model name under provider-specific Unknown Model", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    writeTokenRollout(codex.getSessionRoot(), "legacy-model", null, 44, "2026-03-14T12:00:00.000Z", null);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.modelUsage.some((entry) => (
      entry.modelName === "Unknown Model"
      && entry.modelProvider === "openai"
      && entry.totalTokens === 44
    ))).toBe(true);
  });

  it("groups many models into top 6 plus Other", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    for (let index = 0; index < 7; index += 1) {
      writeTokenRollout(
        codex.getSessionRoot(),
        `model-${index + 1}`,
        null,
        90 - (index * 10),
        `2026-03-14T1${index}:00:00.000Z`,
        `gpt-5.${index}`
      );
    }

    collector.captureSnapshot(new Date("2026-03-14T23:30:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T23:30:00+09:00"));
    expect(tokens.modelUsage).toHaveLength(7);
    expect(tokens.modelUsage.at(-1)).toEqual({
      modelName: "Other",
      modelProvider: null,
      totalTokens: 30
    });
  });

  it("re-indexes a rollout on the next sync when the file changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    fs.appendFileSync(
      fixture.rolloutPath,
      `\n${JSON.stringify({
        timestamp: "2026-03-14T11:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 240,
              cached_input_tokens: 20,
              output_tokens: 100,
              reasoning_output_tokens: 20,
              total_tokens: 340
            },
            last_token_usage: {
              input_tokens: 140,
              output_tokens: 60,
              reasoning_output_tokens: 10,
              total_tokens: 200
            }
          }
        }
      })}`,
      "utf8"
    );

    const staleTokens = collector.getTokens(1, new Date("2026-03-14T20:10:00+09:00"));
    expect(staleTokens.daily[0]?.totalTokens).toBe(140);

    collector.captureSnapshot(new Date("2026-03-14T20:10:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(340);
    expect(tokens.daily[0]?.inputTokens).toBe(240);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(320);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(220);
    expect(tokens.daily[0]?.outputTokens).toBe(100);
    expect(tokens.currentHourTokens.totalTokens).toBe(200);
    expect(tokens.currentHourTokens.cachedInputTokens).toBe(0);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(200);
    expect(tokens.hourly).toHaveLength(2);
    expect(tokens.hourly[1]?.totalTokens).toBe(200);
  });

  it("falls back to total_token_usage deltas when last_token_usage is missing in older events", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    fs.appendFileSync(
      fixture.rolloutPath,
      `\n${JSON.stringify({
        timestamp: "2026-03-14T12:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 20,
              output_tokens: 80,
              reasoning_output_tokens: 10,
              total_tokens: 300
            }
          }
        }
      })}`,
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T21:10:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T21:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(300);
    expect(tokens.daily[0]?.inputTokens).toBe(200);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(280);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(180);
    expect(tokens.daily[0]?.outputTokens).toBe(80);
    expect(tokens.currentHourTokens.totalTokens).toBe(160);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(160);
    expect(tokens.hourly[1]?.totalTokens).toBe(160);
  });

  it("aggregates daily project usage by project", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    const sessionRoot = codex.getSessionRoot();
    const sharedProjectRoot = path.join(fixture.rootDir, "workspace", "demo-project");
    const otherProjectRoot = path.join(fixture.rootDir, "workspace", "bubble-project");

    fs.mkdirSync(path.join(otherProjectRoot, ".git"), { recursive: true });
    writeTokenRollout(sessionRoot, "same-project-extra", path.join(sharedProjectRoot, "packages", "server"), 30, "2026-03-14T12:00:00.000Z");
    writeTokenRollout(sessionRoot, "other-project", path.join(otherProjectRoot, "src"), 60, "2026-03-14T13:00:00.000Z");

    collector.captureSnapshot(new Date("2026-03-14T23:30:00+09:00"));

    const projectUsage = collector.getProjectTokenUsage("day", "2026-03-14", new Date("2026-03-14T23:30:00+09:00"));
    expect(projectUsage.totalTokens).toBe(230);
    expect(projectUsage.projects[0]).toMatchObject({
      projectName: "demo-project",
      totalTokens: 170
    });
    expect(projectUsage.projects[1]).toMatchObject({
      projectName: "bubble-project",
      totalTokens: 60
    });
  });

  it("recovers the project from thread cwd even when session_meta is missing", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    const recoveredProjectRoot = path.join(fixture.rootDir, "workspace", "recovered-project");
    const recoveredRolloutPath = path.join(codex.getSessionRoot(), "rollout-recovered-project.jsonl");

    fs.mkdirSync(path.join(recoveredProjectRoot, ".git"), { recursive: true });
    writeTokenRollout(codex.getSessionRoot(), "recovered-project", null, 55, "2026-03-15T01:00:00.000Z");
    insertThreadRow(fixture, {
      id: "thread-recovered",
      rolloutPath: recoveredRolloutPath,
      cwd: path.join(recoveredProjectRoot, "src")
    });

    collector.captureSnapshot(new Date("2026-03-15T10:00:00+09:00"));

    const projectUsage = collector.getProjectTokenUsage("day", "2026-03-15", new Date("2026-03-15T10:00:00+09:00"));
    expect(projectUsage.projects[0]).toMatchObject({
      projectName: "recovered-project",
      totalTokens: 55
    });
  });

  it("uses Unknown only when both rollout and thread cwd are missing", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    writeTokenRollout(codex.getSessionRoot(), "unknown-project", null, 55, "2026-03-15T01:00:00.000Z");

    collector.captureSnapshot(new Date("2026-03-15T10:00:00+09:00"));

    const projectUsage = collector.getProjectTokenUsage("day", "2026-03-15", new Date("2026-03-15T10:00:00+09:00"));
    expect(projectUsage.projects[0]).toMatchObject({
      projectId: "__unknown__",
      projectName: "Unknown",
      totalTokens: 55
    });
  });

  it("normalizes weekly aggregation to Monday starts and exposes only the top 12 projects", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    const sessionRoot = codex.getSessionRoot();
    const workspaceRoot = path.join(fixture.rootDir, "workspace");

    for (let index = 0; index < 13; index += 1) {
      const projectName = `week-project-${String(index + 1).padStart(2, "0")}`;
      const projectRoot = path.join(workspaceRoot, projectName);
      fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
      writeTokenRollout(
        sessionRoot,
        projectName,
        path.join(projectRoot, "app"),
        100 - index,
        "2026-03-18T03:00:00.000Z"
      );
    }

    collector.captureSnapshot(new Date("2026-03-18T12:00:00+09:00"));

    const projectUsage = collector.getProjectTokenUsage("week", "2026-03-18", new Date("2026-03-18T12:00:00+09:00"));
    expect(projectUsage.anchorDay).toBe("2026-03-16");
    expect(projectUsage.projects).toHaveLength(13);
    expect(projectUsage.projects.at(-1)).toMatchObject({
      projectId: "__other__",
      projectName: "Other",
      totalTokens: 88
    });
  });

  it("parses Claude Code transcript assistant usage into token aggregates", () => {
    const fixture = createClaudeCodeTestFixture();
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);

    collector.captureSnapshot(new Date("2026-03-18T10:05:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-18T10:05:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(21135);
    expect(tokens.daily[0]?.inputTokens).toBe(21124);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(8945);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(12179);
    expect(tokens.daily[0]?.outputTokens).toBe(11);
    expect(tokens.dailyProviderTokens[0]).toEqual({
      day: "2026-03-18",
      codexTokens: 0,
      claudeCodeTokens: 21135
    });
    expect(tokens.daily[0]?.estimatedCost).toBeCloseTo(0.0808625, 8);
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "claude-opus-4-6",
        modelProvider: "anthropic",
        totalTokens: 21135
      }
    ]);
  });

  it("splits daily provider totals when Codex and Claude Code both contribute on the same day", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex, claude]);
    const claudeProjectDir = path.join(fixture.config.providers.claudeCode.home, "projects", "provider-split");

    writeTokenRollout(
      codex.getSessionRoot(),
      "codex-provider-split",
      path.join(fixture.rootDir, "workspace", "provider-split", "app"),
      140,
      "2026-03-18T02:00:00.000Z"
    );
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(path.join(claudeProjectDir, "session-mixed.jsonl"), [
      {
        type: "user",
        timestamp: "2026-03-18T02:01:00.000Z",
        cwd: path.join(fixture.rootDir, "workspace", "provider-split", "app"),
        message: {
          role: "user",
          content: "Split provider usage"
        }
      },
      {
        type: "assistant",
        timestamp: "2026-03-18T02:01:05.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 25,
            output_tokens: 10
          }
        }
      }
    ].map((line) => JSON.stringify(line)).join("\n"), "utf8");

    collector.captureSnapshot(new Date("2026-03-18T10:05:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-18T10:05:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(200);
    expect(tokens.dailyProviderTokens[0]).toEqual({
      day: "2026-03-18",
      codexTokens: 140,
      claudeCodeTokens: 60
    });
  });

  it("indexes Codex and Claude Code tool usage from rollout fixtures", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex, claude]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-18T01:00:00+09:00",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-18T01:00:01+09:00",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "nl file | sed -n '1,10p'" }),
            call_id: "call-exec-1"
          }
        },
        {
          timestamp: "2026-03-18T01:00:02+09:00",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "write_stdin",
            arguments: JSON.stringify({ session_id: 1, chars: "ignored" }),
            call_id: "call-stdin-1"
          }
        },
        {
          timestamp: "2026-03-18T01:00:03+09:00",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "mcp__obsidian__read_file",
            arguments: JSON.stringify({ path: "ignored" }),
            call_id: "call-mcp-1"
          }
        },
        {
          timestamp: "2026-03-18T01:00:04+09:00",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                total_tokens: 25
              },
              last_token_usage: {
                total_tokens: 25
              }
            }
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    const claudeProjectDir = path.join(fixture.config.providers.claudeCode.home, "projects", "tool-project");
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(path.join(claudeProjectDir, "session-tools.jsonl"), [
      {
        type: "assistant",
        timestamp: "2026-03-18T01:01:00+09:00",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 2
          },
          content: [
            {
              type: "tool_use",
              id: "toolu_read",
              name: "Read",
              input: {
                file_path: "README.md"
              }
            },
            {
              type: "tool_use",
              id: "toolu_mcp",
              name: "mcp__obsidian__read_file",
              input: {
                path: "note.md"
              }
            }
          ]
        }
      }
    ].map((line) => JSON.stringify(line)).join("\n"), "utf8");

    collector.captureSnapshot(new Date("2026-03-18T10:05:00+09:00"));

    expect(collector.getToolUsage(1, new Date("2026-03-18T10:05:00+09:00"))).toEqual([
      {
        provider: "claude-code",
        toolName: "Read",
        callCount: 1
      },
      {
        provider: "claude-code",
        toolName: "mcp:obsidian",
        callCount: 1
      },
      {
        provider: "codex",
        toolName: "nl",
        callCount: 1
      },
      {
        provider: "codex",
        toolName: "sed",
        callCount: 1
      }
    ]);

    const tokens = collector.getTokens(1, new Date("2026-03-18T10:05:00+09:00"));
    expect(tokens.toolUsage).toEqual(collector.getToolUsage(1, new Date("2026-03-18T10:05:00+09:00")));
  });

  it("preserves tool usage when unchanged rollouts coexist with stats-cache rows", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    const statsCachePath = path.join(fixture.claudeHome, "stats-cache.json");

    writeStatsCache(statsCachePath, {
      version: 2,
      lastComputedDate: "2026-03-18",
      dailyModelTokens: [
        {
          date: "2026-03-18",
          tokensByModel: {
            "claude-opus-4-6": 42
          }
        }
      ],
      modelUsage: {}
    });

    collector.importStatsCacheUsage(statsCachePath);
    collector.captureSnapshot(new Date("2026-03-18T10:05:00+09:00"));

    const firstRows = readToolAttributionRows(fixture.config.monitorDbPath);
    expect(firstRows).toEqual([
      {
        rollout_path: fixture.primaryRolloutPath,
        provider: "claude-code",
        tool_name: "Bash",
        call_count: 1
      }
    ]);
    expect(collector.getToolUsage(1, new Date("2026-03-18T10:05:00+09:00"))).toEqual([
      {
        provider: "claude-code",
        toolName: "Bash",
        callCount: 1
      }
    ]);

    const indexDatabase = new DatabaseSync(fixture.config.monitorDbPath);
    const statsIndex = indexDatabase.prepare(`
      SELECT parse_version
      FROM rollout_index_state
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { parse_version: string } | undefined;
    indexDatabase.close();
    expect(statsIndex?.parse_version).toBe("claude-stats-v4");

    collector.captureSnapshot(new Date("2026-03-18T10:06:00+09:00"));

    expect(readToolAttributionRows(fixture.config.monitorDbPath)).toEqual(firstRows);
  });

  it("truncates and rebuilds tool usage when the tool parse version changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    fs.writeFileSync(
      fixture.rolloutPath,
      [
        {
          timestamp: "2026-03-14T10:00:00+09:00",
          type: "session_meta",
          payload: {
            cwd: path.join(fixture.rootDir, "workspace", "demo-project", "packages", "client"),
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-03-14T10:00:01+09:00",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "rg toolUsage" }),
            call_id: "call-exec-1"
          }
        }
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    database.prepare(`
      INSERT INTO tool_token_attribution (
        rollout_path,
        hour_bucket,
        provider,
        tool_name,
        call_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "/stale/tool-rollout.jsonl",
      "2026-03-14T10:00:00",
      "codex",
      "stale-tool",
      99
    );
    database.prepare(`
      UPDATE rollout_index_state
      SET parse_version = ?
      WHERE rollout_path != ?
    `).run("9:tool-0", "__claude-code-stats__");
    database.close();

    collector.captureSnapshot(new Date("2026-03-14T20:01:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:01:00+09:00"));
    expect(tokens.toolUsage).toEqual([
      {
        provider: "codex",
        toolName: "rg",
        callCount: 1
      }
    ]);
  });

  it("builds session duration buckets from rollout line timestamps split by 30-minute gaps", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    writeTokenTimeline(fixture.rolloutPath, [
      ["2026-03-14T09:00:00+09:00", 10],
      ["2026-03-14T09:05:00+09:00", 20],
      ["2026-03-14T09:35:00+09:00", 30],
      ["2026-03-14T10:00:00+09:00", 40],
      ["2026-03-14T10:25:00+09:00", 50],
      ["2026-03-14T10:55:00+09:00", 60],
      ["2026-03-14T11:20:00+09:00", 70],
      ["2026-03-14T11:45:00+09:00", 80],
      ["2026-03-14T12:00:00+09:00", 90]
    ]);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.patterns.sessionDuration.startHistogram).toEqual([
      { hour: 9, count: 2 },
      { hour: 10, count: 1 }
    ]);
    expect(tokens.patterns.sessionDuration.durationBuckets).toEqual([
      { bucketMin: 0, bucketMax: 30, count: 1 },
      { bucketMin: 30, bucketMax: 60, count: 1 },
      { bucketMin: 60, bucketMax: 120, count: 1 },
      { bucketMin: 120, bucketMax: 240, count: 0 },
      { bucketMin: 240, bucketMax: 480, count: 0 },
      { bucketMin: 480, bucketMax: 1440, count: 0 },
      { bucketMin: 1440, bucketMax: 10080, count: 0 },
      { bucketMin: 10080, bucketMax: 525600, count: 0 }
    ]);
  });

  it("keeps the true start for sessions that begin before the selected range", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    writeTokenTimeline(fixture.rolloutPath, [
      ["2026-03-14T23:55:00+09:00", 10],
      ["2026-03-15T00:10:00+09:00", 20]
    ]);

    collector.captureSnapshot(new Date("2026-03-15T01:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-15T01:00:00+09:00"));
    expect(tokens.patterns.sessionDuration.startHistogram).toEqual([
      { hour: 23, count: 1 }
    ]);
    expect(tokens.patterns.sessionDuration.durationBuckets[0]).toEqual({
      bucketMin: 0,
      bucketMax: 30,
      count: 1
    });
  });

  it("uses floored session minutes for duration bucket boundaries", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);

    writeTokenTimeline(fixture.rolloutPath, [
      ["2026-03-14T09:00:00+09:00", 10],
      ["2026-03-14T09:29:59+09:00", 20],
      ["2026-03-14T10:00:00+09:00", 30],
      ["2026-03-14T10:15:00+09:00", 40],
      ["2026-03-14T10:30:00+09:00", 50],
      ["2026-03-14T11:00:00+09:00", 60],
      ["2026-03-14T11:20:00+09:00", 70],
      ["2026-03-14T11:40:00+09:00", 80],
      ["2026-03-14T12:00:00+09:00", 90]
    ]);

    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:00:00+09:00"));
    expect(tokens.patterns.sessionDuration.durationBuckets.find((bucket) => bucket.bucketMin === 0)).toMatchObject({
      bucketMin: 0,
      bucketMax: 30,
      count: 1
    });
    expect(tokens.patterns.sessionDuration.durationBuckets.find((bucket) => bucket.bucketMin === 30)).toMatchObject({
      bucketMin: 30,
      bucketMax: 60,
      count: 1
    });
    expect(tokens.patterns.sessionDuration.durationBuckets.find((bucket) => bucket.bucketMin === 60)).toMatchObject({
      bucketMin: 60,
      bucketMax: 120,
      count: 1
    });
  });

  it("skips unreadable rollout paths when building patterns", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [codex]);
    collector.captureSnapshot(new Date("2026-03-14T20:00:00+09:00"));

    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
      if (filePath === fixture.rolloutPath) {
        throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
      }

      return originalReadFileSync(filePath, options as never);
    }) as typeof fs.readFileSync);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const patterns = collector.getPatterns(1, new Date("2026-03-14T20:00:00+09:00"));

    expect(patterns.dowHourHeatmap).toEqual([
      {
        dow: 6,
        hour: 19,
        totalTokens: 140,
        requestCount: 1
      }
    ]);
    expect(patterns.sessionDuration).toEqual({
      startHistogram: [],
      durationBuckets: []
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(`[token-collector] Skipping rollout file ${fixture.rolloutPath}: EACCES`);
  });

  it("computes pattern hours from naked-local hour buckets without SQLite strftime", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const collector = new TokenCollectorService(fixture.config, [new CodexDataService(fixture.config)]);
    collector.ensureSchema();
    const database = new DatabaseSync(fixture.config.monitorDbPath);
    insertHourlyUsage(database, {
      rolloutPath: "/missing/saturday.jsonl",
      hourBucket: "2026-04-25T00:00:00",
      totalTokens: 10,
      inputTokens: 10
    });
    insertHourlyUsage(database, {
      rolloutPath: "/missing/sunday-night.jsonl",
      hourBucket: "2026-04-26T23:00:00",
      totalTokens: 20,
      inputTokens: 20
    });
    insertHourlyUsage(database, {
      rolloutPath: "/missing/monday-midnight.jsonl",
      hourBucket: "2026-04-27T00:00:00",
      totalTokens: 30,
      inputTokens: 30
    });
    database.close();

    const patterns = collector.getPatterns(3, new Date("2026-04-27T12:00:00+09:00"));
    expect(patterns.dowHourHeatmap).toEqual([
      { dow: 0, hour: 23, totalTokens: 20, requestCount: 1 },
      { dow: 1, hour: 0, totalTokens: 30, requestCount: 1 },
      { dow: 6, hour: 0, totalTokens: 10, requestCount: 1 }
    ]);
  });

  it("uses active days for hourly averages and input_tokens for cache hit denominator", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const collector = new TokenCollectorService(fixture.config, [new CodexDataService(fixture.config)]);
    collector.ensureSchema();
    const database = new DatabaseSync(fixture.config.monitorDbPath);
    insertHourlyUsage(database, {
      rolloutPath: "/missing/day-one.jsonl",
      hourBucket: "2026-04-25T09:00:00",
      totalTokens: 100,
      inputTokens: 50,
      cachedInputTokens: 25,
      cacheCreationInputTokens: 20,
      uncachedInputTokens: 25
    });
    insertHourlyUsage(database, {
      rolloutPath: "/missing/day-two.jsonl",
      hourBucket: "2026-04-26T09:00:00",
      totalTokens: 300,
      inputTokens: 300
    });
    insertHourlyUsage(database, {
      rolloutPath: "/missing/other-hour.jsonl",
      hourBucket: "2026-04-26T10:00:00",
      totalTokens: 900,
      inputTokens: 900
    });
    database.close();

    const patterns = collector.getPatterns(2, new Date("2026-04-26T20:00:00+09:00"));
    expect(patterns.hourOfDayAverages.find((entry) => entry.hour === 9)).toEqual({
      hour: 9,
      avgTokens: 200,
      avgRequests: 1,
      sampleDays: 2
    });
    expect(patterns.hourOfDayAverages.find((entry) => entry.hour === 10)).toEqual({
      hour: 10,
      avgTokens: 900,
      avgRequests: 1,
      sampleDays: 1
    });
    expect(patterns.hourOfDayCacheHit.find((entry) => entry.hour === 9)?.hitRate).toBeCloseTo(25 / 350, 6);
  });

  it("imports Claude Code stats-cache daily usage into token queries", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    const statsCachePath = path.join(fixture.claudeHome, "stats-cache.json");

    writeStatsCache(statsCachePath, {
      version: 2,
      lastComputedDate: "2026-01-07",
      dailyModelTokens: [
        {
          date: "2026-01-07",
          tokensByModel: {
            "claude-sonnet-4-5-20250929": 2_079,
            "claude-opus-4-5-20250514": 150_000
          }
        }
      ],
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 11_084,
          outputTokens: 116_306,
          cacheReadInputTokens: 27_682_934,
          cacheCreationInputTokens: 1_983_512
        }
      }
    });

    collector.importStatsCacheUsage(statsCachePath);
    collector.captureSnapshot(new Date("2026-01-07T23:30:00+09:00"));

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    const aggregateRow = database.prepare(`
      SELECT
        total_tokens,
        input_tokens,
        cached_input_tokens,
        cache_creation_input_tokens,
        uncached_input_tokens,
        output_tokens
      FROM rollout_hourly_usage
      WHERE rollout_path = '__claude-code-stats__'
        AND hour_bucket = '2026-01-07T00:00:00'
    `).get() as {
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_creation_input_tokens: number;
      uncached_input_tokens: number;
      output_tokens: number;
    } | undefined;
    const sonnetRow = database.prepare(`
      SELECT
        total_tokens,
        input_tokens,
        cached_input_tokens,
        cache_creation_input_tokens,
        uncached_input_tokens,
        output_tokens
      FROM rollout_hourly_model_usage
      WHERE rollout_path = '__claude-code-stats__'
        AND hour_bucket = '2026-01-07T00:00:00'
        AND model_name = 'claude-sonnet-4-5-20250929'
    `).get() as {
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_creation_input_tokens: number;
      uncached_input_tokens: number;
      output_tokens: number;
    } | undefined;
    const opusRow = database.prepare(`
      SELECT
        total_tokens,
        input_tokens,
        cached_input_tokens,
        cache_creation_input_tokens,
        uncached_input_tokens,
        output_tokens
      FROM rollout_hourly_model_usage
      WHERE rollout_path = '__claude-code-stats__'
        AND hour_bucket = '2026-01-07T00:00:00'
        AND model_name = 'claude-opus-4-5-20250514'
    `).get() as {
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_creation_input_tokens: number;
      uncached_input_tokens: number;
      output_tokens: number;
    } | undefined;
    database.close();

    expect(aggregateRow).toEqual({
      total_tokens: 152_079,
      input_tokens: 152_071,
      cached_input_tokens: 1_932,
      cache_creation_input_tokens: 138,
      uncached_input_tokens: 150_139,
      output_tokens: 8
    });
    expect(aggregateRow!.input_tokens + aggregateRow!.output_tokens).toBe(aggregateRow!.total_tokens);
    expect(sonnetRow).toEqual({
      total_tokens: 2_079,
      input_tokens: 2_071,
      cached_input_tokens: 1_932,
      cache_creation_input_tokens: 138,
      uncached_input_tokens: 1,
      output_tokens: 8
    });
    expect(sonnetRow!.input_tokens + sonnetRow!.output_tokens).toBe(sonnetRow!.total_tokens);
    expect(opusRow).toEqual({
      total_tokens: 150_000,
      input_tokens: 150_000,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      uncached_input_tokens: 150_000,
      output_tokens: 0
    });

    const tokens = collector.getTokens(1, new Date("2026-01-07T23:30:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      day: "2026-01-07",
      totalTokens: 152_079,
      inputTokens: 152_071,
      cachedInputTokens: 1_932,
      uncachedInputTokens: 150_139,
      outputTokens: 8
    });
    expect(tokens.daily[0]!.inputTokens + tokens.daily[0]!.outputTokens).toBe(tokens.daily[0]!.totalTokens);
    expect(tokens.dailyProviderTokens[0]).toEqual({
      day: "2026-01-07",
      codexTokens: 0,
      claudeCodeTokens: 152_079
    });
    const statsHour = tokens.hourly.find((entry) => entry.hourBucket === "2026-01-07T00:00:00");
    expect(statsHour).toMatchObject({
      hourBucket: "2026-01-07T00:00:00",
      totalTokens: 152_079,
      inputTokens: 152_071,
      cachedInputTokens: 1_932,
      uncachedInputTokens: 150_139,
      outputTokens: 8,
      reasoningOutputTokens: 0,
      requestCount: 0
    });
    expect(statsHour?.estimatedCost).toBeCloseTo(0.7512201, 8);
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "claude-opus-4-5-20250514",
        modelProvider: "anthropic",
        totalTokens: 150_000
      },
      {
        modelName: "claude-sonnet-4-5-20250929",
        modelProvider: "anthropic",
        totalTokens: 2_079
      }
    ]);

    const projectUsage = collector.getProjectTokenUsage("day", "2026-01-07", new Date("2026-01-07T23:30:00+09:00"));
    expect(projectUsage.projects[0]).toMatchObject({
      projectId: "__claude-code__",
      projectName: "Claude Code",
      projectPath: "",
      totalTokens: 152_079,
      requestCount: 0
    });
  });

  it("treats stats-cache totals as input-only when modelUsage is missing", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    const statsCachePath = path.join(fixture.claudeHome, "stats-cache.json");

    writeStatsCache(statsCachePath, {
      version: 2,
      lastComputedDate: "2026-01-07",
      dailyModelTokens: [
        {
          date: "2026-01-07",
          tokensByModel: {
            "claude-opus-4-5-20250514": 70
          }
        }
      ]
    });

    collector.importStatsCacheUsage(statsCachePath);
    collector.captureSnapshot(new Date("2026-01-07T23:30:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-01-07T23:30:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      day: "2026-01-07",
      totalTokens: 70,
      inputTokens: 70,
      cachedInputTokens: 0,
      uncachedInputTokens: 70,
      outputTokens: 0
    });

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    const row = database.prepare(`
      SELECT
        total_tokens,
        input_tokens,
        cached_input_tokens,
        cache_creation_input_tokens,
        uncached_input_tokens,
        output_tokens
      FROM rollout_hourly_model_usage
      WHERE rollout_path = '__claude-code-stats__'
        AND hour_bucket = '2026-01-07T00:00:00'
        AND model_name = 'claude-opus-4-5-20250514'
    `).get() as {
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_creation_input_tokens: number;
      uncached_input_tokens: number;
      output_tokens: number;
    } | undefined;
    database.close();

    expect(row).toEqual({
      total_tokens: 70,
      input_tokens: 70,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      uncached_input_tokens: 70,
      output_tokens: 0
    });
  });

  it("ignores a missing Claude Code stats-cache file", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    const missingPath = path.join(fixture.claudeHome, "missing-stats-cache.json");

    expect(() => collector.importStatsCacheUsage(missingPath)).not.toThrow();

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    const usageCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_usage
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    const indexCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_index_state
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    database.close();

    expect(usageCount.count).toBe(0);
    expect(indexCount.count).toBe(0);
  });

  it("removes stale synthetic stats-cache rows when the synthetic parse version changes", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);

    collector.ensureSchema();

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    database.prepare(`
      INSERT INTO rollout_hourly_usage (
        rollout_path,
        hour_bucket,
        project_id,
        project_name,
        project_path,
        total_tokens,
        input_tokens,
        cached_input_tokens,
        uncached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        request_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "__claude-code-stats__",
      "2026-01-07T00:00:00",
      "__claude-code__",
      "Claude Code",
      "",
      99,
      0,
      0,
      0,
      0,
      0,
      0
    );
    database.prepare(`
      INSERT INTO rollout_index_state (
        rollout_path,
        file_size,
        mtime_ms,
        indexed_at,
        parse_version
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "__claude-code-stats__",
      123,
      456,
      "2026-01-07T00:00:00",
      "claude-stats-v1"
    );
    database.close();

    collector.captureSnapshot(new Date("2026-01-08T09:00:00+09:00"));

    const verifyDatabase = new DatabaseSync(fixture.config.monitorDbPath);
    const usageCount = verifyDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_usage
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    const indexCount = verifyDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_index_state
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    verifyDatabase.close();

    expect(usageCount.count).toBe(0);
    expect(indexCount.count).toBe(0);
  });

  it("re-imports Claude Code stats-cache data without duplicating rows", () => {
    const fixture = createClaudeCodeTestFixture({ includeAssistantUsage: false });
    fixtures.push(fixture);

    const claude = new ClaudeCodeDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, [claude]);
    const statsCachePath = path.join(fixture.claudeHome, "stats-cache.json");

    writeStatsCache(statsCachePath, {
      version: 2,
      lastComputedDate: "2026-01-07",
      dailyModelTokens: [
        {
          date: "2026-01-07",
          tokensByModel: {
            "claude-sonnet-4-5-20250929": 10,
            "claude-opus-4-5-20250514": 20
          }
        }
      ],
      modelUsage: {}
    });
    collector.importStatsCacheUsage(statsCachePath);

    writeStatsCache(statsCachePath, {
      version: 2,
      lastComputedDate: "2026-01-07",
      dailyModelTokens: [
        {
          date: "2026-01-07",
          tokensByModel: {
            "claude-opus-4-5-20250514": 70
          }
        }
      ],
      modelUsage: {}
    });
    collector.importStatsCacheUsage(statsCachePath);
    collector.captureSnapshot(new Date("2026-01-07T23:30:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-01-07T23:30:00+09:00"));
    expect(tokens.daily[0]).toMatchObject({
      totalTokens: 70,
      inputTokens: 70,
      cachedInputTokens: 0,
      uncachedInputTokens: 70,
      outputTokens: 0
    });
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(70);
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "claude-opus-4-5-20250514",
        modelProvider: "anthropic",
        totalTokens: 70
      }
    ]);

    const database = new DatabaseSync(fixture.config.monitorDbPath);
    const usageCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_usage
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    const modelCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_hourly_model_usage
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    const indexCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rollout_index_state
      WHERE rollout_path = '__claude-code-stats__'
    `).get() as { count: number };
    database.close();

    expect(usageCount.count).toBe(1);
    expect(modelCount.count).toBe(1);
    expect(indexCount.count).toBe(1);
  });
});

function writeTokenRollout(
  sessionRoot: string,
  slug: string,
  cwd: string | null,
  totalTokens: number,
  timestamp: string,
  modelName: string | null = "gpt-5.4"
): void {
  const lines: Array<Record<string, unknown>> = [];

  if (cwd) {
    fs.mkdirSync(cwd, { recursive: true });
  }

  lines.push({
    timestamp,
    type: "session_meta",
    payload: {
      ...(cwd ? { cwd } : {}),
      cli_version: "0.114.0",
      model_provider: "openai"
    }
  });

  if (modelName) {
    lines.push({
      timestamp,
      type: "turn_context",
      payload: {
        ...(cwd ? { cwd } : {}),
        model: modelName,
        collaboration_mode: {
          mode: "default",
          settings: {
            model: modelName
          }
        }
      }
    });
  }

  lines.push({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: totalTokens
        },
        last_token_usage: {
          total_tokens: totalTokens
        }
      }
    }
  });

  fs.writeFileSync(path.join(sessionRoot, `rollout-${slug}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

function writeTokenTimeline(rolloutPath: string, events: Array<[timestamp: string, totalTokens: number]>): void {
  const lines: Array<Record<string, unknown>> = [
    {
      timestamp: events[0]?.[0] ?? "2026-03-14T09:00:00+09:00",
      type: "session_meta",
      payload: {
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: events[0]?.[0] ?? "2026-03-14T09:00:00+09:00",
      type: "turn_context",
      payload: {
        model: "gpt-5.4"
      }
    }
  ];

  let previousTotal = 0;
  for (const [timestamp, totalTokens] of events) {
    lines.push({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: totalTokens
          },
          last_token_usage: {
            total_tokens: totalTokens - previousTotal
          }
        }
      }
    });
    previousTotal = totalTokens;
  }

  fs.writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

function writeCodexCacheBreakRollout(rolloutPath: string, rootDir: string): void {
  writeCodexTwoTurnRollout(rolloutPath, rootDir, {
    firstTimestamp: "2026-03-14T10:00:02.000Z",
    secondTimestamp: "2026-03-14T10:01:00.000Z",
    secondCachedInputTokens: 100
  });
}

function writeCodexNoCacheBreakRollout(rolloutPath: string, rootDir: string): void {
  writeCodexTwoTurnRollout(rolloutPath, rootDir, {
    firstTimestamp: "2026-03-14T10:00:02.000Z",
    secondTimestamp: "2026-03-14T10:01:00.000Z",
    secondCachedInputTokens: 850
  });
}

function writeCodexIdleGapCacheDropRollout(rolloutPath: string, rootDir: string, secondTimestamp: string): void {
  writeCodexTwoTurnRollout(rolloutPath, rootDir, {
    firstTimestamp: "2026-03-14T10:00:02.000Z",
    secondTimestamp,
    secondCachedInputTokens: 100
  });
}

function writeCodexAlternatingCacheBreakRollout(rolloutPath: string, rootDir: string, eventCount: number): void {
  const cwd = path.join(rootDir, "workspace", "demo-project", "packages", "client");
  const lines: Array<Record<string, unknown>> = [
    {
      timestamp: "2026-03-14T10:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd,
        cli_version: "0.114.0",
        model_provider: "openai",
        base_instructions: "Stable system prompt"
      }
    },
    {
      timestamp: "2026-03-14T10:00:01.000Z",
      type: "turn_context",
      payload: {
        cwd,
        model: "gpt-5.4"
      }
    }
  ];
  let cumulativeInputTokens = 0;
  let cumulativeCachedInputTokens = 0;
  let cumulativeOutputTokens = 0;
  const turnCount = eventCount * 2;

  for (let turn = 0; turn < turnCount; turn += 1) {
    const cachedInputTokens = turn % 2 === 0 ? 900 : 100;
    cumulativeInputTokens += 1000;
    cumulativeCachedInputTokens += cachedInputTokens;
    cumulativeOutputTokens += 50;
    lines.push({
      timestamp: `2026-03-14T10:${String(turn + 1).padStart(2, "0")}:02.000Z`,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: cumulativeInputTokens,
            cached_input_tokens: cumulativeCachedInputTokens,
            output_tokens: cumulativeOutputTokens,
            total_tokens: cumulativeInputTokens + cumulativeOutputTokens
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: cachedInputTokens,
            output_tokens: 50,
            total_tokens: 1050
          }
        }
      }
    });
  }

  fs.writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

function writeCodexTwoTurnRollout(
  rolloutPath: string,
  rootDir: string,
  input: {
    firstTimestamp: string;
    secondTimestamp: string;
    secondCachedInputTokens: number;
  }
): void {
  const cwd = path.join(rootDir, "workspace", "demo-project", "packages", "client");
  const lines: Array<Record<string, unknown>> = [
    {
      timestamp: "2026-03-14T10:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd,
        cli_version: "0.114.0",
        model_provider: "openai",
        base_instructions: "Stable system prompt"
      }
    },
    {
      timestamp: "2026-03-14T10:00:01.000Z",
      type: "turn_context",
      payload: {
        cwd,
        model: "gpt-5.4"
      }
    },
    {
      timestamp: input.firstTimestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 900,
            output_tokens: 50,
            total_tokens: 1050
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 900,
            output_tokens: 50,
            total_tokens: 1050
          }
        }
      }
    },
    {
      timestamp: input.secondTimestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1000,
            output_tokens: 100,
            total_tokens: 2100
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: input.secondCachedInputTokens,
            output_tokens: 50,
            total_tokens: 1050
          }
        }
      }
    }
  ];

  fs.writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

function writeClaudeCodeCacheBreakTranscript(rolloutPath: string): void {
  const lines: Array<Record<string, unknown>> = [
    {
      type: "session_meta",
      timestamp: "2026-03-18T01:00:00.000Z",
      base_instructions: "Stable Claude system prompt"
    },
    {
      type: "assistant",
      timestamp: "2026-03-18T01:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 900,
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
          output_tokens: 10
        }
      }
    },
    {
      type: "assistant",
      timestamp: "2026-03-18T01:01:05.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 900,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
          output_tokens: 10
        }
      }
    }
  ];

  fs.writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

function insertHourlyUsage(
  database: DatabaseSync,
  input: {
    rolloutPath: string;
    hourBucket: string;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    uncachedInputTokens?: number;
    outputTokens?: number;
    requestCount?: number;
  }
): void {
  const cachedInputTokens = input.cachedInputTokens ?? 0;
  const cacheCreationInputTokens = input.cacheCreationInputTokens ?? 0;
  const uncachedInputTokens = input.uncachedInputTokens ?? Math.max(0, input.inputTokens - cachedInputTokens);
  const outputTokens = input.outputTokens ?? Math.max(0, input.totalTokens - input.inputTokens);

  database.prepare(`
    INSERT INTO rollout_hourly_usage (
      rollout_path,
      hour_bucket,
      project_id,
      project_name,
      project_path,
      total_tokens,
      input_tokens,
      cached_input_tokens,
      cache_creation_input_tokens,
      uncached_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      request_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rolloutPath,
    input.hourBucket,
    "__test__",
    "Test",
    "",
    input.totalTokens,
    input.inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    outputTokens,
    0,
    input.requestCount ?? 1
  );
}

interface CacheBreakEventRow {
  rollout_path: string;
  turn_index: number;
  ts: number;
  local_date: string;
  provider: string;
  model: string;
  prev_hit_rate: number;
  curr_hit_rate: number;
  dropped_pp: number;
  primary_cause: string;
  confidence: string;
  evidence_json: string;
  parse_version: string;
}

function readCacheBreakRows(monitorDbPath: string): CacheBreakEventRow[] {
  const database = new DatabaseSync(monitorDbPath);
  const rows = database.prepare(`
    SELECT
      rollout_path,
      turn_index,
      ts,
      local_date,
      provider,
      model,
      prev_hit_rate,
      curr_hit_rate,
      dropped_pp,
      primary_cause,
      confidence,
      evidence_json,
      parse_version
    FROM cache_break_event
    ORDER BY rollout_path ASC, turn_index ASC
  `).all() as unknown as CacheBreakEventRow[];
  database.close();
  return rows;
}

function overwriteCacheBreakEvidence(
  monitorDbPath: string,
  rolloutPath: string,
  input: {
    evidenceJson: string;
    parseVersion: string;
  }
): void {
  const database = new DatabaseSync(monitorDbPath);
  database.prepare(`
    UPDATE cache_break_event
    SET evidence_json = ?,
        parse_version = ?
    WHERE rollout_path = ?
  `).run(input.evidenceJson, input.parseVersion, rolloutPath);
  database.close();
}

function insertSyntheticCacheBreakRow(monitorDbPath: string, rolloutPath: string, turnIndex: number): void {
  const database = new DatabaseSync(monitorDbPath);
  database.prepare(`
    INSERT INTO cache_break_event (
      rollout_path,
      turn_index,
      ts,
      local_date,
      provider,
      model,
      prev_hit_rate,
      curr_hit_rate,
      dropped_pp,
      primary_cause,
      confidence,
      evidence_json,
      parse_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rolloutPath,
    turnIndex,
    new Date("2026-03-14T10:02:00.000Z").getTime(),
    "2026-03-14",
    "codex",
    "gpt-5.4",
    0.9,
    0.1,
    0.8,
    "unknown",
    "low",
    JSON.stringify({ sentinel: true }),
    BREAK_PARSE_VERSION
  );
  database.close();
}

function markRolloutParseVersionStale(monitorDbPath: string, rolloutPath: string): void {
  const database = new DatabaseSync(monitorDbPath);
  database.prepare(`
    UPDATE rollout_index_state
    SET parse_version = ?
    WHERE rollout_path = ?
  `).run("rollout-parse-v0", rolloutPath);
  database.close();
}

function markBreakParseVersionStaleWithoutChangingRolloutState(monitorDbPath: string, rolloutPath: string): void {
  const stats = fs.statSync(rolloutPath);
  const database = new DatabaseSync(monitorDbPath);
  database.prepare(`
    UPDATE rollout_index_state
    SET file_size = ?,
        mtime_ms = ?,
        break_parse_version = ?
    WHERE rollout_path = ?
  `).run(stats.size, Math.trunc(stats.mtimeMs), "break-parse-v0", rolloutPath);
  database.close();
}

function readRolloutUsageSummary(monitorDbPath: string, rolloutPath: string): {
  rowCount: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
} {
  const database = new DatabaseSync(monitorDbPath);
  const row = database.prepare(`
    SELECT
      COUNT(*) AS rowCount,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens
    FROM rollout_hourly_usage
    WHERE rollout_path = ?
  `).get(rolloutPath) as {
    rowCount: number;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
  };
  database.close();
  return row;
}

function readToolAttributionRows(monitorDbPath: string): Array<{
  rollout_path: string;
  provider: string;
  tool_name: string;
  call_count: number;
}> {
  const database = new DatabaseSync(monitorDbPath);
  const rows = database.prepare(`
    SELECT
      rollout_path,
      provider,
      tool_name,
      SUM(call_count) AS call_count
    FROM tool_token_attribution
    GROUP BY rollout_path, provider, tool_name
    ORDER BY rollout_path, provider, tool_name
  `).all() as Array<{
    rollout_path: string;
    provider: string;
    tool_name: string;
    call_count: number;
  }>;
  database.close();
  return rows;
}

function insertThreadRow(
  fixture: ReturnType<typeof createTestFixture>,
  input: {
    id: string;
    rolloutPath: string;
    cwd: string;
  }
): void {
  const stateDbPath = path.join(fixture.config.providers.codex.codexHome, "state_1.sqlite");
  const database = new DatabaseSync(stateDbPath);
  database.prepare(`
    INSERT INTO threads (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.rolloutPath,
    1_710_470_400,
    1_710_470_400,
    "cli",
    "openai",
    input.cwd,
    "Recovered session",
    "danger-full-access",
    "never",
    55,
    "Recovery test",
    null,
    null,
    "enabled"
  );
  database.close();
}

function writeStatsCache(filePath: string, input: Record<string, unknown>): void {
  fs.writeFileSync(filePath, JSON.stringify(input, null, 2), "utf8");
}
