import pricingData from "./model-pricing.json";

export interface ModelPricing {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheReadPerMillionTokens: number;
  cacheCreationPerMillionTokens: number;
}

export interface UsageCostInput {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  uncachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  outputTokens?: number | null;
}

export const DEFAULT_MODEL_PRICING_KEY = "claude-sonnet-4-6";

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = pricingData;

const modelPricingEntries = Object.entries(MODEL_PRICING_TABLE)
  .sort((left, right) => right[0].length - left[0].length);

export function resolveModelPricing(modelName: string | null | undefined): ModelPricing {
  const normalized = normalizeModelName(modelName);
  if (!normalized) {
    return MODEL_PRICING_TABLE[DEFAULT_MODEL_PRICING_KEY];
  }

  const exactMatch = MODEL_PRICING_TABLE[normalized];
  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatch = modelPricingEntries.find(([key]) => normalized.startsWith(`${key}-`) || normalized.includes(`/${key}`));
  return prefixMatch?.[1] ?? MODEL_PRICING_TABLE[DEFAULT_MODEL_PRICING_KEY];
}

export function estimateUsageCost(usage: UsageCostInput, modelName: string | null | undefined): number {
  const pricing = resolveModelPricing(modelName);
  const normalized = normalizeUsageCostInput(usage);
  return (
    (normalized.directInputTokens * pricing.inputPerMillionTokens)
    + (normalized.cacheCreationInputTokens * pricing.cacheCreationPerMillionTokens)
    + (normalized.cachedInputTokens * pricing.cacheReadPerMillionTokens)
    + (normalized.outputTokens * pricing.outputPerMillionTokens)
  ) / 1_000_000;
}

export function estimateUsageCostWithoutCache(usage: UsageCostInput, modelName: string | null | undefined): number {
  const pricing = resolveModelPricing(modelName);
  const normalized = normalizeUsageCostInput(usage);
  return (
    (normalized.totalInputTokens * pricing.inputPerMillionTokens)
    + (normalized.outputTokens * pricing.outputPerMillionTokens)
  ) / 1_000_000;
}

export function calculateCacheHitRate(usage: UsageCostInput): number {
  const normalized = normalizeUsageCostInput(usage);
  return normalized.totalInputTokens > 0
    ? normalized.cachedInputTokens / normalized.totalInputTokens
    : 0;
}

export function normalizeUsageCostInput(usage: UsageCostInput) {
  const cachedInputTokens = normalizeTokenCount(usage.cachedInputTokens);
  const inputTokens = usage.inputTokens == null
    ? null
    : normalizeTokenCount(usage.inputTokens);
  const cacheCreationInputTokens = normalizeTokenCount(usage.cacheCreationInputTokens);
  const uncachedInputTokens = usage.uncachedInputTokens == null
    ? Math.max(0, (inputTokens ?? 0) - cachedInputTokens - cacheCreationInputTokens)
    : normalizeTokenCount(usage.uncachedInputTokens);
  const totalInputTokens = inputTokens ?? (uncachedInputTokens + cacheCreationInputTokens + cachedInputTokens);
  const directInputTokens = inputTokens === null
    ? uncachedInputTokens
    : Math.max(0, totalInputTokens - cachedInputTokens - cacheCreationInputTokens);

  return {
    totalInputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    directInputTokens,
    outputTokens: normalizeTokenCount(usage.outputTokens)
  };
}

function normalizeModelName(modelName: string | null | undefined): string {
  return typeof modelName === "string" ? modelName.trim().toLowerCase() : "";
}

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
