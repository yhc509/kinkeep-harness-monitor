import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  host: string;
  port: number;
  repoRoot: string;
  codexHome: string;
  agentsHome: string;
  monitorDbPath: string;
  webDistPath: string;
  timezone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const agentsHome = env.AGENTS_HOME ?? path.join(os.homedir(), ".agents");
  const monitorDbPath = env.MONITOR_DB ?? path.join(repoRoot, "data", "monitor.sqlite");

  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "4318"),
    repoRoot,
    codexHome,
    agentsHome,
    monitorDbPath,
    webDistPath: path.join(repoRoot, "apps", "web", "dist"),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
