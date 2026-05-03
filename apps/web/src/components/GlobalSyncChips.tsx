import { useEffect, useState } from "react";
import type { TokenPeriodUnit } from "@codex-monitor/shared";
import { RefreshCw } from "lucide-react";
import {
  apiResourceKeys,
  createSnapshot,
  getCacheBreaks,
  getCacheTrend,
  getHookDetail,
  getIntegrations,
  getMemory,
  getOverview,
  getProjectTokenUsage,
  getProjects,
  getSessionDetail,
  getSessions,
  getSkillDetail,
  getSubagentAttribution,
  getTokens,
  getToolAttribution,
  refreshIntegrations,
  type CacheTrendProvider,
  type CacheTrendRange,
  type TokenAttributionProvider,
  type TokenAttributionRange
} from "../api";
import {
  invalidateApiResource,
  listApiResourceCacheKeys,
  prefetchApiResource,
  refreshApiResource,
  useApiResource
} from "../hooks/useApiResource";

const TOKEN_SEED_KEYS = [
  apiResourceKeys.overview,
  apiResourceKeys.tokens(7)
];

const INTEGRATION_SEED_KEYS = [
  apiResourceKeys.integrations,
  apiResourceKeys.memory,
  apiResourceKeys.projects("")
];

const tokenAttributionRanges = new Set<TokenAttributionRange>([7, 30, 90]);
const tokenAttributionProviders = new Set<TokenAttributionProvider>(["all", "claude_code", "codex"]);
const cacheTrendRanges = new Set<CacheTrendRange>(["7d", "30d"]);
const cacheTrendProviders = new Set<CacheTrendProvider>(["all", "claude_code", "codex"]);
const tokenPeriodUnits = new Set<TokenPeriodUnit>(["day", "week", "month"]);

export function GlobalSyncChips() {
  const now = useSyncClock();
  const [tokensBusy, setTokensBusy] = useState(false);
  const [integrationsBusy, setIntegrationsBusy] = useState(false);
  const overview = useApiResource(() => getOverview(), {
    deps: [],
    cacheKey: apiResourceKeys.overview,
    staleTimeMs: 300_000
  });
  const tokens = useApiResource(() => getTokens(7), {
    deps: [],
    cacheKey: apiResourceKeys.tokens(7),
    staleTimeMs: 300_000
  });
  const integrations = useApiResource(() => getIntegrations(), {
    deps: [],
    cacheKey: apiResourceKeys.integrations,
    staleTimeMs: 0
  });

  const tokensLastSyncedAt = tokens.data?.lastSyncedAt
    ?? overview.data?.lastSyncedAt
    ?? overview.data?.collector?.finishedAt
    ?? null;
  const integrationsLastSyncedAt = integrations.data?.lastSyncedAt ?? null;
  const tokensRefreshing = tokensBusy || tokens.refreshing || overview.refreshing;
  const integrationsRefreshing = integrationsBusy || integrations.refreshing;
  const integrationsMeta = integrations.data?.isStale
    ? `${formatSyncAge(integrationsLastSyncedAt, now)} · pending`
    : formatSyncAge(integrationsLastSyncedAt, now);

  async function handleTokensRefresh() {
    if (tokensBusy) {
      return;
    }

    const cacheKeys = collectGroupCacheKeys(isTokenResourceKey, TOKEN_SEED_KEYS);
    setTokensBusy(true);

    try {
      await createSnapshot();
      await refreshResourceGroup(cacheKeys, getTokenResourceLoader);
    } finally {
      setTokensBusy(false);
    }
  }

  async function handleIntegrationsRefresh() {
    if (integrationsBusy) {
      return;
    }

    const cacheKeys = collectGroupCacheKeys(isIntegrationResourceKey, INTEGRATION_SEED_KEYS);
    setIntegrationsBusy(true);

    try {
      await refreshIntegrations();
      await refreshResourceGroup(cacheKeys, getIntegrationResourceLoader);
    } finally {
      setIntegrationsBusy(false);
    }
  }

  return (
    <div className="global-sync-strip" aria-label="Global sync controls">
      <SyncChip
        label="Tokens"
        meta={formatSyncAge(tokensLastSyncedAt, now)}
        refreshing={tokensRefreshing}
        onRefresh={handleTokensRefresh}
      />
      <SyncChip
        label="Integrations"
        meta={integrationsMeta}
        refreshing={integrationsRefreshing}
        onRefresh={handleIntegrationsRefresh}
      />
    </div>
  );
}

interface SyncChipProps {
  label: string;
  meta: string;
  refreshing: boolean;
  onRefresh: () => void;
}

function SyncChip({ label, meta, refreshing, onRefresh }: SyncChipProps) {
  return (
    <div className="global-sync-chip">
      <span className="global-sync-label">{label}</span>
      <span className="global-sync-meta">last sync {meta}</span>
      <button
        type="button"
        className={refreshing ? "global-sync-refresh spinning" : "global-sync-refresh"}
        aria-label={`Refresh ${label} sync`}
        title={`Refresh ${label} sync`}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

function useSyncClock() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return now;
}

function formatSyncAge(value: string | null, now: number): string {
  if (!value) {
    return "never";
  }

  const syncedAt = Date.parse(value);
  if (!Number.isFinite(syncedAt)) {
    return value;
  }

  const seconds = Math.max(0, Math.floor((now - syncedAt) / 1000));
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function collectGroupCacheKeys(matcher: (cacheKey: string) => boolean, seedKeys: string[]) {
  const cacheKeys = new Set(seedKeys);

  for (const cacheKey of listApiResourceCacheKeys()) {
    if (matcher(cacheKey)) {
      cacheKeys.add(cacheKey);
    }
  }

  return Array.from(cacheKeys);
}

async function refreshResourceGroup(
  cacheKeys: string[],
  getLoader: (cacheKey: string) => (() => Promise<unknown>) | null
) {
  for (const cacheKey of cacheKeys) {
    invalidateApiResource(cacheKey);
  }

  await Promise.all(
    cacheKeys.map((cacheKey) => {
      const loader = getLoader(cacheKey);
      return loader ? prefetchApiResource(cacheKey, loader, { force: true }) : Promise.resolve();
    })
  );

  for (const cacheKey of cacheKeys) {
    refreshApiResource(cacheKey, { force: false });
  }
}

function isTokenResourceKey(cacheKey: string) {
  return (
    cacheKey === apiResourceKeys.overview
    || /^tokens:\d+$/.test(cacheKey)
    || cacheKey.startsWith("project-token-usage:")
    || cacheKey.startsWith("tool-attribution:")
    || cacheKey.startsWith("subagent-attribution:")
    || cacheKey.startsWith("tokens:cache-trend:")
    || cacheKey.startsWith("tokens:cache-breaks:")
  );
}

function isIntegrationResourceKey(cacheKey: string) {
  return (
    cacheKey === apiResourceKeys.integrations
    || cacheKey === apiResourceKeys.memory
    || cacheKey.startsWith("projects:")
    || cacheKey.startsWith("session:")
    || cacheKey.startsWith("hook:")
    || cacheKey.startsWith("skill:")
    || isSessionsCacheKey(cacheKey)
  );
}

function getTokenResourceLoader(cacheKey: string): (() => Promise<unknown>) | null {
  if (cacheKey === apiResourceKeys.overview) {
    return () => getOverview();
  }

  const tokensMatch = /^tokens:(\d+)$/.exec(cacheKey);
  if (tokensMatch) {
    return () => getTokens(Number(tokensMatch[1]));
  }

  const projectUsageMatch = /^project-token-usage:([^:]+):(.+)$/.exec(cacheKey);
  if (projectUsageMatch) {
    const unit = projectUsageMatch[1];
    const anchorDay = projectUsageMatch[2];
    if (isTokenPeriodUnit(unit)) {
      return () => getProjectTokenUsage(unit, anchorDay);
    }
  }

  const toolAttributionMatch = /^tool-attribution:(\d+):([^:]+)$/.exec(cacheKey);
  if (toolAttributionMatch) {
    const range = Number(toolAttributionMatch[1]);
    const provider = toolAttributionMatch[2];
    if (isTokenAttributionRange(range) && isTokenAttributionProvider(provider)) {
      return () => getToolAttribution(range, provider);
    }
  }

  const subagentAttributionMatch = /^subagent-attribution:(\d+):([^:]+)$/.exec(cacheKey);
  if (subagentAttributionMatch) {
    const range = Number(subagentAttributionMatch[1]);
    const provider = subagentAttributionMatch[2];
    if (isTokenAttributionRange(range) && isTokenAttributionProvider(provider)) {
      return () => getSubagentAttribution(range, provider);
    }
  }

  const cacheTrendMatch = /^tokens:cache-trend:([^:]+):([^:]+)$/.exec(cacheKey);
  if (cacheTrendMatch) {
    const range = cacheTrendMatch[1];
    const provider = cacheTrendMatch[2];
    if (isCacheTrendRange(range) && isCacheTrendProvider(provider)) {
      return () => getCacheTrend(range, provider);
    }
  }

  const cacheBreaksMatch = /^tokens:cache-breaks:([^:]+):([^:]+)$/.exec(cacheKey);
  if (cacheBreaksMatch) {
    const range = cacheBreaksMatch[1];
    const provider = cacheBreaksMatch[2];
    if (isCacheTrendRange(range) && isCacheTrendProvider(provider)) {
      return () => getCacheBreaks(range, provider);
    }
  }

  return null;
}

function getIntegrationResourceLoader(cacheKey: string): (() => Promise<unknown>) | null {
  if (cacheKey === apiResourceKeys.integrations) {
    return () => getIntegrations();
  }

  if (cacheKey === apiResourceKeys.memory) {
    return () => getMemory();
  }

  if (cacheKey.startsWith("projects:")) {
    return () => getProjects(cacheKey.slice("projects:".length));
  }

  if (isSessionsCacheKey(cacheKey)) {
    const options = parseSessionsCacheKey(cacheKey);
    return options ? () => getSessions(options) : null;
  }

  if (cacheKey.startsWith("session:")) {
    const id = cacheKey.slice("session:".length);
    return id ? () => getSessionDetail(id) : null;
  }

  if (cacheKey.startsWith("hook:")) {
    const id = cacheKey.slice("hook:".length);
    return id ? () => getHookDetail(id) : null;
  }

  if (cacheKey.startsWith("skill:")) {
    const id = cacheKey.slice("skill:".length);
    return id ? () => getSkillDetail(id) : null;
  }

  return null;
}

function isSessionsCacheKey(cacheKey: string) {
  return cacheKey.startsWith("{\"type\":\"sessions\"");
}

function parseSessionsCacheKey(cacheKey: string): { projectId?: string; query?: string; includeSubagents?: boolean } | null {
  try {
    const parsed = JSON.parse(cacheKey) as {
      type?: unknown;
      projectId?: unknown;
      query?: unknown;
      includeSubagents?: unknown;
    };

    if (parsed.type !== "sessions") {
      return null;
    }

    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
      query: typeof parsed.query === "string" ? parsed.query : undefined,
      includeSubagents: Boolean(parsed.includeSubagents)
    };
  } catch {
    return null;
  }
}

function isTokenPeriodUnit(value: string): value is TokenPeriodUnit {
  return tokenPeriodUnits.has(value as TokenPeriodUnit);
}

function isTokenAttributionRange(value: number): value is TokenAttributionRange {
  return tokenAttributionRanges.has(value as TokenAttributionRange);
}

function isTokenAttributionProvider(value: string): value is TokenAttributionProvider {
  return tokenAttributionProviders.has(value as TokenAttributionProvider);
}

function isCacheTrendRange(value: string): value is CacheTrendRange {
  return cacheTrendRanges.has(value as CacheTrendRange);
}

function isCacheTrendProvider(value: string): value is CacheTrendProvider {
  return cacheTrendProviders.has(value as CacheTrendProvider);
}
