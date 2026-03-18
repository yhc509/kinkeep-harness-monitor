import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config";

const LABEL = "com.codex-monitor.webui";
const require = createRequire(import.meta.url);

const config = loadConfig();
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = path.join(path.dirname(config.monitorDbPath), "logs");
const tsxCliPath = require.resolve("tsx/cli");
const programPath = path.join(config.repoRoot, "apps", "api", "src", "index.ts");

fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(tsxCliPath)}</string>
    <string>${escapeXml(programPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.repoRoot)}</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>${escapeXml(config.host)}</string>
    <key>PORT</key>
    <string>${escapeXml(String(config.port))}</string>
    <key>CODEX_HOME</key>
    <string>${escapeXml(config.providers.codex.codexHome)}</string>
    <key>AGENTS_HOME</key>
    <string>${escapeXml(config.providers.codex.agentsHome)}</string>
    <key>CLAUDE_CODE_HOME</key>
    <string>${escapeXml(config.providers.claudeCode.home)}</string>
    <key>MONITOR_PROVIDER</key>
    <string>${escapeXml(config.activeProviderId)}</string>
    <key>MONITOR_DB</key>
    <string>${escapeXml(config.monitorDbPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "server.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "server.err.log"))}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist, "utf8");
console.log(`launchd plist 생성 완료: ${plistPath}`);
console.log("로드 명령:");
console.log(`launchctl bootstrap gui/$(id -u) ${plistPath}`);

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
