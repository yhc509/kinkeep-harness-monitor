import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config";

export interface TestFixture {
  rootDir: string;
  config: AppConfig;
  rolloutPath: string;
  cleanup: () => void;
}

export function createTestFixture(options: { stage1Mode?: "ready" | "empty" | "unsupported" } = {}): TestFixture {
  const stage1Mode = options.stage1Mode ?? "ready";
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-"));
  const codexHome = path.join(rootDir, ".codex");
  const agentsHome = path.join(rootDir, ".agents");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "03", "14");
  const codexSkillsDir = path.join(codexHome, "skills", "demo-skill");
  const agentSkillsDir = path.join(agentsHome, "skills", "review-skill");
  const gitProjectRoot = path.join(rootDir, "workspace", "demo-project");
  const gitProjectClient = path.join(gitProjectRoot, "packages", "client");
  const gitProjectTools = path.join(gitProjectRoot, "tools");
  const worktreeProjectRoot = path.join(rootDir, "workspace", "linked-project");
  const worktreeProjectApp = path.join(worktreeProjectRoot, "app");
  const standaloneProjectRoot = path.join(rootDir, "scratchpad");

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(codexSkillsDir, { recursive: true });
  fs.mkdirSync(agentSkillsDir, { recursive: true });
  fs.mkdirSync(path.join(gitProjectRoot, ".git"), { recursive: true });
  fs.mkdirSync(gitProjectClient, { recursive: true });
  fs.mkdirSync(gitProjectTools, { recursive: true });
  fs.mkdirSync(worktreeProjectApp, { recursive: true });
  fs.mkdirSync(standaloneProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreeProjectRoot, ".git"), "gitdir: /tmp/fake-linked-project.git", "utf8");

  fs.writeFileSync(path.join(codexHome, "config.toml"), `
notify = ["node", "/tmp/notify-hook.js"]

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
  `.trim(), "utf8");

  fs.writeFileSync(path.join(codexSkillsDir, "SKILL.md"), `
---
name: demo-skill
description: Demo skill from codex
---
  `.trim(), "utf8");

  fs.writeFileSync(path.join(agentSkillsDir, "SKILL.md"), `
---
name: review-skill
description: Review skill from agents
---
  `.trim(), "utf8");

  const rolloutPath = writeRollout(sessionsDir, "rollout-demo.jsonl", [
    {
      timestamp: "2026-03-14T10:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd: gitProjectClient,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "사용자 요청"
          }
        ]
      }
    },
    {
      timestamp: "2026-03-14T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "도와드릴게요."
          }
        ]
      }
    },
    {
      timestamp: "2026-03-14T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__openaiDeveloperDocs__search_openai_docs",
        arguments: "{\"query\":\"codex\"}"
      }
    },
    {
      timestamp: "2026-03-14T10:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 40,
            reasoning_output_tokens: 10,
            total_tokens: 140
          },
          last_token_usage: {
            total_tokens: 140
          }
        }
      }
    }
  ]);

  const sameProjectRollout = writeRollout(sessionsDir, "rollout-same-project.jsonl", [
    {
      timestamp: "2026-03-14T09:30:00.000Z",
      type: "session_meta",
      payload: {
        cwd: gitProjectTools,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T09:30:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "같은 프로젝트의 다른 세션" }]
      }
    }
  ]);

  const worktreeRollout = writeRollout(sessionsDir, "rollout-worktree.jsonl", [
    {
      timestamp: "2026-03-14T08:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd: worktreeProjectApp,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T08:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "워크트리 세션입니다." }]
      }
    }
  ]);

  const standaloneRollout = writeRollout(sessionsDir, "rollout-standalone.jsonl", [
    {
      timestamp: "2026-03-14T07:00:00.000Z",
      type: "session_meta",
      payload: {
        cwd: standaloneProjectRoot,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T07:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "비깃 프로젝트 세션" }]
      }
    }
  ]);

  const explorerRollout = writeRollout(sessionsDir, "rollout-explorer.jsonl", [
    {
      timestamp: "2026-03-14T10:10:00.000Z",
      type: "session_meta",
      payload: {
        cwd: gitProjectClient,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T10:10:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "탐색 결과를 정리합니다." }]
      }
    }
  ]);

  const workerRollout = writeRollout(sessionsDir, "rollout-worker.jsonl", [
    {
      timestamp: "2026-03-14T10:12:00.000Z",
      type: "session_meta",
      payload: {
        cwd: gitProjectClient,
        cli_version: "0.114.0",
        model_provider: "openai"
      }
    },
    {
      timestamp: "2026-03-14T10:12:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "구현 작업을 진행합니다." }]
      }
    }
  ]);

  const stateDbPath = path.join(codexHome, "state_1.sqlite");
  const stateDb = new DatabaseSync(stateDbPath);
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled'
    );
  `);
  if (stage1Mode !== "unsupported") {
    stateDb.exec(`
      CREATE TABLE stage1_outputs (
        thread_id TEXT PRIMARY KEY,
        source_updated_at INTEGER NOT NULL,
        raw_memory TEXT NOT NULL,
        rollout_summary TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        rollout_slug TEXT,
        usage_count INTEGER,
        last_usage INTEGER,
        selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
        selected_for_phase2_source_updated_at INTEGER
      );
    `);
  }

  insertThread(stateDb, {
    id: "thread-1",
    rolloutPath,
    createdAt: 1_710_384_000,
    updatedAt: 1_710_387_600,
    cwd: gitProjectClient,
    title: "데모 세션",
    tokensUsed: 140
  });
  insertThread(stateDb, {
    id: "thread-2",
    rolloutPath: sameProjectRollout,
    createdAt: 1_710_383_000,
    updatedAt: 1_710_385_000,
    cwd: gitProjectTools,
    title: "같은 프로젝트 세션",
    tokensUsed: 0
  });
  insertThread(stateDb, {
    id: "thread-3",
    rolloutPath: worktreeRollout,
    createdAt: 1_710_382_000,
    updatedAt: 1_710_382_600,
    cwd: worktreeProjectApp,
    title: "워크트리 세션",
    tokensUsed: 0
  });
  insertThread(stateDb, {
    id: "thread-4",
    rolloutPath: standaloneRollout,
    createdAt: 1_710_381_000,
    updatedAt: 1_710_381_600,
    cwd: standaloneProjectRoot,
    title: "비깃 세션",
    tokensUsed: 0
  });
  insertThread(stateDb, {
    id: "thread-5",
    rolloutPath: explorerRollout,
    createdAt: 1_710_387_800,
    updatedAt: 1_710_387_900,
    cwd: gitProjectClient,
    title: "데모 세션",
    tokensUsed: 0,
    source: JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: "thread-1",
          depth: 1,
          agent_nickname: "Noether",
          agent_role: "explorer"
        }
      }
    }),
    agentNickname: "Noether",
    agentRole: "explorer",
    firstUserMessage: "탐색만 맡아줘"
  });
  insertThread(stateDb, {
    id: "thread-6",
    rolloutPath: workerRollout,
    createdAt: 1_710_388_000,
    updatedAt: 1_710_388_100,
    cwd: gitProjectClient,
    title: "데모 세션",
    tokensUsed: 0,
    source: JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: "thread-1",
          depth: 1,
          agent_nickname: "Boyle",
          agent_role: "worker"
        }
      }
    }),
    agentNickname: "Boyle",
    agentRole: "worker",
    firstUserMessage: "구현만 맡아줘"
  });

  if (stage1Mode === "ready") {
    stateDb.prepare(`
      INSERT INTO stage1_outputs (
        thread_id,
        source_updated_at,
        raw_memory,
        rollout_summary,
        generated_at,
        usage_count,
        last_usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "thread-1",
      1_710_387_600,
      "기억된 메모리",
      "요약",
      1_710_387_600,
      2,
      1_710_387_600
    );
  }
  stateDb.close();

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4318,
    repoRoot: rootDir,
    codexHome,
    agentsHome,
    monitorDbPath: path.join(rootDir, "data", "monitor.sqlite"),
    webDistPath: path.join(rootDir, "apps", "web", "dist"),
    timezone: "Asia/Seoul"
  };

  return {
    rootDir,
    config,
    rolloutPath,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true })
  };
}

function writeRollout(directory: string, fileName: string, lines: unknown[]): string {
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return filePath;
}

function insertThread(
  database: DatabaseSync,
  thread: {
    id: string;
    rolloutPath: string;
    createdAt: number;
    updatedAt: number;
    cwd: string;
    title: string;
    tokensUsed: number;
    source?: string;
    agentNickname?: string | null;
    agentRole?: string | null;
    firstUserMessage?: string;
  }
) {
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
    thread.id,
    thread.rolloutPath,
    thread.createdAt,
    thread.updatedAt,
    thread.source ?? "cli",
    "openai",
    thread.cwd,
    thread.title,
    "danger-full-access",
    "never",
    thread.tokensUsed,
    thread.firstUserMessage ?? "사용자 요청",
    thread.agentNickname ?? null,
    thread.agentRole ?? null,
    "enabled"
  );
}
