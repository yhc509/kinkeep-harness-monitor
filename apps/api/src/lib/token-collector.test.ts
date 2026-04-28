import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeDataService } from "./claude-code-service";
import { CodexDataService } from "./codex-service";
import { TokenCollectorService } from "./token-collector";
import { createClaudeCodeTestFixture } from "../test-support/claude-fixture";
import { createTestFixture } from "../test-support/fixture";

const fixtures: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  vi.restoreAllMocks();

  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("TokenCollectorService", () => {
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
