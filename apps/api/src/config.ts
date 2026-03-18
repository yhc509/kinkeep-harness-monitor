import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderId = "codex" | "claude-code";

export interface CodexProviderConfig {
  codexHome: string;
  agentsHome: string;
}

export interface ClaudeCodeProviderConfig {
  home: string;
}

export interface AppConfig {
  host: string;
  port: number;
  repoRoot: string;
  monitorDbPath: string;
  webDistPath: string;
  timezone: string;
  activeProviderId: ProviderId;
  providers: {
    codex: CodexProviderConfig;
    claudeCode: ClaudeCodeProviderConfig;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const agentsHome = env.AGENTS_HOME ?? path.join(os.homedir(), ".agents");
  const claudeCodeHome = env.CLAUDE_CODE_HOME ?? path.join(os.homedir(), ".claude");
  const monitorDbPath = env.MONITOR_DB ?? path.join(repoRoot, "data", "monitor.sqlite");
  const activeProviderId: ProviderId = env.MONITOR_PROVIDER === "claude-code" ? "claude-code" : "codex";

  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "4318"),
    repoRoot,
    monitorDbPath,
    webDistPath: path.join(repoRoot, "apps", "web", "dist"),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    activeProviderId,
    providers: {
      codex: {
        codexHome,
        agentsHome
      },
      claudeCode: {
        home: claudeCodeHome
      }
    }
  };
}
