import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config";

export interface ClaudeCodeTestFixture {
  rootDir: string;
  claudeHome: string;
  primarySessionId: string;
  fallbackSessionId: string;
  primaryRolloutPath: string;
  config: AppConfig;
  cleanup: () => void;
}

export function createClaudeCodeTestFixture(options: { includeAssistantUsage?: boolean } = {}): ClaudeCodeTestFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudecodefixture"));
  const claudeHome = path.join(rootDir, ".claude");
  const codexHome = path.join(rootDir, ".codex");
  const agentsHome = path.join(rootDir, ".agents");
  const projectRoot = path.join(rootDir, "workspace", "claudeproject");
  const projectApp = path.join(projectRoot, "app");
  const notesRoot = path.join(rootDir, "notes");
  const primarySessionId = "session-alpha";
  const secondarySessionId = "session-beta";
  const fallbackSessionId = "session-fallback";
  const primaryProjectDir = path.join(claudeHome, "projects", encodeClaudePath(projectRoot));
  const secondaryProjectDir = path.join(claudeHome, "projects", encodeClaudePath(notesRoot));
  const transcriptsDir = path.join(claudeHome, "transcripts");
  const sessionsDir = path.join(claudeHome, "sessions");
  const skillsDir = path.join(claudeHome, "skills");

  fs.mkdirSync(projectApp, { recursive: true });
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.mkdirSync(primaryProjectDir, { recursive: true });
  fs.mkdirSync(path.join(primaryProjectDir, "memory"), { recursive: true });
  fs.mkdirSync(secondaryProjectDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "debugger"), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "planner"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(agentsHome, { recursive: true });

  fs.writeFileSync(path.join(primaryProjectDir, "CLAUDE.md"), "# Project instructions\n", "utf8");
  fs.writeFileSync(path.join(primaryProjectDir, "memory", "notes.md"), "Remember this later\n", "utf8");
  fs.writeFileSync(path.join(primaryProjectDir, "memory", "coding-style.md"), `---
name: Coding Style
description: Preferred coding conventions
---

Use TypeScript strict mode
`, "utf8");

  const includeAssistantUsage = options.includeAssistantUsage ?? true;

  const primaryRolloutPath = writeJsonl(path.join(primaryProjectDir, `${primarySessionId}.jsonl`), [
    {
      type: "user",
      message: {
        role: "user",
        content: "Investigate failing tests"
      },
      timestamp: "2026-03-18T01:00:00.000Z",
      sessionId: primarySessionId,
      cwd: projectApp,
      version: "1.0.0",
      entrypoint: "tui"
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        ...(includeAssistantUsage ? {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 12176,
            cache_read_input_tokens: 8945,
            output_tokens: 11
          }
        } : {}),
        content: [
          {
            type: "text",
            text: "I'll inspect the failing test output."
          },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: {
              command: "pnpm test"
            }
          },
          {
            type: "text",
            text: "I found one failing assertion."
          }
        ]
      },
      timestamp: "2026-03-18T01:00:05.000Z"
    },
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "1 failed assertion",
      timestamp: "2026-03-18T01:00:07.000Z"
    },
    {
      type: "progress",
      content: "Collecting more logs",
      timestamp: "2026-03-18T01:00:08.000Z"
    }
  ]);

  writeJsonl(path.join(secondaryProjectDir, `${secondarySessionId}.jsonl`), [
    {
      type: "user",
      message: {
        role: "user",
        content: "Summarize design notes"
      },
      timestamp: "2026-03-17T09:00:00.000Z",
      sessionId: secondarySessionId,
      cwd: notesRoot,
      version: "1.0.0"
    },
    {
      type: "system",
      message: {
        role: "system",
        content: "Design notes indexed"
      },
      timestamp: "2026-03-17T09:02:00.000Z"
    }
  ]);

  writeJsonl(path.join(transcriptsDir, `ses_${fallbackSessionId}.jsonl`), [
    {
      type: "user",
      message: {
        role: "user",
        content: "Fallback transcript title"
      },
      timestamp: "2026-03-16T08:00:00.000Z",
      sessionId: fallbackSessionId,
      cwd: projectApp,
      version: "1.0.0"
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Only transcript fallback is available."
          }
        ]
      },
      timestamp: "2026-03-16T08:00:05.000Z"
    }
  ]);

  fs.writeFileSync(path.join(claudeHome, "history.jsonl"), [
    {
      display: "Investigate failing tests",
      pastedContents: {},
      timestamp: 1_773_998_810_000,
      project: projectApp,
      sessionId: primarySessionId
    },
    {
      display: "Summarize design notes",
      pastedContents: {},
      timestamp: 1_773_910_800_000,
      project: notesRoot,
      sessionId: secondarySessionId
    },
    {
      display: "Fallback transcript title",
      pastedContents: {},
      timestamp: 1_773_820_800_000,
      project: projectApp,
      sessionId: fallbackSessionId
    }
  ].map((line) => JSON.stringify(line)).join("\n"), "utf8");

  fs.writeFileSync(path.join(sessionsDir, "12857.json"), JSON.stringify({
    pid: 12857,
    sessionId: fallbackSessionId,
    cwd: projectApp,
    startedAt: 1_773_820_800_000
  }), "utf8");

  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({
    permissions: {
      allow: ["Bash(git:*)", "Read"],
      defaultMode: "default"
    },
    mcpServers: {
      docs: {
        command: "npx",
        args: ["-y", "@docs/server"]
      },
      localtools: {
        command: "node",
        args: ["server.js"]
      }
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "echo pre-tool"
            },
            {
              type: "command",
              command: "echo audit"
            }
          ]
        }
      ]
    }
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(claudeHome, "stats-cache.json"), JSON.stringify({
    totalSessions: 99,
    totalMessages: 12
  }, null, 2), "utf8");

  fs.writeFileSync(path.join(skillsDir, "debugger", "SKILL.md"), `
---
name: debugger
description: Debugging workflow for Claude Code
---
  `.trim(), "utf8");
  fs.writeFileSync(path.join(skillsDir, "planner", "planner.md"), `
# planner

Planning workflow for Claude Code
  `.trim(), "utf8");

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4318,
    repoRoot: rootDir,
    monitorDbPath: path.join(rootDir, "data", "monitor.sqlite"),
    webDistPath: path.join(rootDir, "apps", "web", "dist"),
    timezone: "Asia/Seoul",
    activeProviderIds: ["claude-code"],
    get activeProviderId() {
      return this.activeProviderIds[0] ?? "codex";
    },
    providers: {
      codex: {
        codexHome,
        agentsHome
      },
      claudeCode: {
        home: claudeHome
      }
    }
  };

  return {
    rootDir,
    claudeHome,
    primarySessionId,
    fallbackSessionId,
    primaryRolloutPath,
    config,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true })
  };
}

function writeJsonl(filePath: string, entries: unknown[]): string {
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return filePath;
}

function encodeClaudePath(value: string): string {
  return value.replace(/\//g, "-");
}
