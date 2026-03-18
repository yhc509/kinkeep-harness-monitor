import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CodexDataService } from "./codex-service";
import { TokenCollectorService } from "./token-collector";
import { createTestFixture } from "../test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("TokenCollectorService", () => {
  it("aggregates token_count events in rollout logs into daily and hourly usage", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, codex);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T19:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(140);
    expect(tokens.daily[0]?.inputTokens).toBe(100);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(120);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(80);
    expect(tokens.daily[0]?.outputTokens).toBe(40);
    expect(tokens.currentHourTokens.totalTokens).toBe(140);
    expect(tokens.currentHourTokens.cachedInputTokens).toBe(20);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(120);
    expect(tokens.hourly[0]?.totalTokens).toBe(140);
    expect(tokens.hourly[0]?.requestCount).toBe(1);
    expect(tokens.modelUsage).toEqual([
      {
        modelName: "gpt-5.4",
        modelProvider: "openai",
        totalTokens: 140
      }
    ]);
  });

  it("attributes later token_count events to the model after turn_context changes", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);
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
    const collector = new TokenCollectorService(fixture.config, codex);
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
    const collector = new TokenCollectorService(fixture.config, codex);

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
    const collector = new TokenCollectorService(fixture.config, codex);
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
