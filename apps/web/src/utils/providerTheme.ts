import type { ModelTokenUsageItem, SessionListItem } from "@codex-monitor/shared";

export type MonitorProvider = "codex" | "claude-code";
export type ProviderId = MonitorProvider;
export type SourceTheme = MonitorProvider | "agents";
export type ProviderTone = MonitorProvider | "neutral";

const providerLabels: Record<MonitorProvider, string> = {
  codex: "Codex",
  "claude-code": "Claude Code"
};

const sourceLabels: Record<SourceTheme, string> = {
  codex: "Codex",
  agents: "Agents",
  "claude-code": "Claude Code"
};

export function resolveProvider(provider?: SessionListItem["provider"] | null): MonitorProvider {
  return provider === "claude-code" ? "claude-code" : "codex";
}

export function getProviderClassName(provider?: SessionListItem["provider"] | null): `provider-${MonitorProvider}` {
  return `provider-${resolveProvider(provider)}`;
}

export function getProviderThemeClassName(provider?: SessionListItem["provider"] | null): `provider-${MonitorProvider}` {
  return getProviderClassName(provider);
}

export function getProviderLabel(provider?: SessionListItem["provider"] | null): string {
  return providerLabels[resolveProvider(provider)];
}

export function inferSourceTheme(source?: string | null): SourceTheme | null {
  const normalized = source?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "codex" || /[\\/]\.codex(?:[\\/]|$)/.test(normalized)) {
    return "codex";
  }

  if (normalized === "agents" || /[\\/]\.agents(?:[\\/]|$)/.test(normalized)) {
    return "agents";
  }

  if (normalized === "claude-code" || /[\\/]\.claude(?:[\\/]|$)/.test(normalized)) {
    return "claude-code";
  }

  return null;
}

export function getSourceLabel(source?: string | null): string | null {
  const theme = inferSourceTheme(source);
  return theme ? sourceLabels[theme] : null;
}

export function getSourceThemeClassName(source?: string | null): SourceTheme | null {
  return inferSourceTheme(source);
}

export function getSourceThemeLabel(source?: string | null): string | null {
  const theme = inferSourceTheme(source);
  return theme ? sourceLabels[theme] : null;
}

export function inferModelTheme(
  input: string | Pick<ModelTokenUsageItem, "modelName" | "modelProvider">,
  fallbackModelProvider?: string | null
): ProviderTone {
  const modelName = typeof input === "string" ? input.trim().toLowerCase() : input.modelName.trim().toLowerCase();
  const modelProvider = (
    typeof input === "string"
      ? fallbackModelProvider
      : input.modelProvider
  )?.trim().toLowerCase() ?? "";

  if (modelName === "other") {
    return "neutral";
  }

  if (modelName.startsWith("claude-")) {
    return "claude-code";
  }

  if (modelName.startsWith("gpt-") || /^o[13](?:-|$)/.test(modelName)) {
    return "codex";
  }

  if (modelName === "unknown model") {
    if (modelProvider === "openai") {
      return "codex";
    }

    if (modelProvider === "anthropic") {
      return "claude-code";
    }
  }

  return "neutral";
}

export const inferModelTone = inferModelTheme;
