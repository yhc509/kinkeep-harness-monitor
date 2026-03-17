import type { DailyTokenPoint, HourlyTokenUsage, TokenBreakdown } from "@codex-monitor/shared";
import { useEffect, useState } from "react";

export type TokenMetricMode = "uncached" | "total";

const STORAGE_KEY = "codex-monitor.token-metric-mode";

export function useTokenMetricMode() {
  const [mode, setMode] = useState<TokenMetricMode>(() => {
    if (typeof window === "undefined") {
      return "uncached";
    }

    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "total" ? "total" : "uncached";
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return {
    mode,
    setMode,
    dataKey: mode === "total" ? "totalTokens" : "uncachedTokens",
    label: mode === "total" ? "캐시 포함" : "캐시 제외"
  };
}

export function readTokenMetric(value: TokenBreakdown, mode: TokenMetricMode): number {
  return mode === "total" ? value.totalTokens : value.uncachedTokens;
}

export function readDailyTokenMetric(value: DailyTokenPoint, mode: TokenMetricMode): number {
  return mode === "total" ? value.totalTokens : value.uncachedTokens;
}

export function readDailyInputMetric(value: DailyTokenPoint, mode: TokenMetricMode): number {
  return mode === "total" ? value.inputTokens : value.uncachedInputTokens;
}

export function extendHourlyTokenMetric(value: HourlyTokenUsage) {
  return {
    ...value,
    uncachedTokens: Math.max(0, value.totalTokens - value.cachedInputTokens),
    uncachedInputTokens: Math.max(0, value.inputTokens - value.cachedInputTokens)
  };
}
