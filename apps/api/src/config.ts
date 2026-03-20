import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderId = "codex" | "claude-code";
export const ALL_PROVIDER_IDS = ["codex", "claude-code"] as const satisfies readonly ProviderId[];

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
  activeProviderIds: ProviderId[];
  readonly activeProviderId: ProviderId;
  providers: {
    codex: CodexProviderConfig;
    claudeCode: ClaudeCodeProviderConfig;
  };
}

export function resolveActiveProviderIds(rawValue: string | undefined): ProviderId[] {
  switch (rawValue ?? "all") {
    case "all":
      return [...ALL_PROVIDER_IDS];
    case "codex":
      return ["codex"];
    case "claude-code":
      return ["claude-code"];
    default:
      return ["codex"];
  }
}

export function serializeMonitorProvider(activeProviderIds: readonly ProviderId[]): "all" | ProviderId {
  if (ALL_PROVIDER_IDS.every((providerId) => activeProviderIds.includes(providerId))) {
    return "all";
  }

  return activeProviderIds[0] ?? "codex";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const agentsHome = env.AGENTS_HOME ?? path.join(os.homedir(), ".agents");
  const claudeCodeHome = env.CLAUDE_CODE_HOME ?? path.join(os.homedir(), ".claude");
  const monitorDbPath = env.MONITOR_DB ?? path.join(repoRoot, "data", "monitor.sqlite");
  const activeProviderIds = resolveActiveProviderIds(env.MONITOR_PROVIDER);

  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "4318"),
    repoRoot,
    monitorDbPath,
    webDistPath: path.join(repoRoot, "apps", "web", "dist"),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    activeProviderIds,
    get activeProviderId() {
      return activeProviderIds[0] ?? "codex";
    },
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
