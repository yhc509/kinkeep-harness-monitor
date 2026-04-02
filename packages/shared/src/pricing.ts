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

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
    cacheReadPerMillionTokens: 0.3,
    cacheCreationPerMillionTokens: 3.75
  },
  "claude-opus-4-6": {
    inputPerMillionTokens: 15,
    outputPerMillionTokens: 75,
    cacheReadPerMillionTokens: 1.5,
    cacheCreationPerMillionTokens: 18.75
  },
  "claude-haiku-4-5": {
    inputPerMillionTokens: 0.8,
    outputPerMillionTokens: 4,
    cacheReadPerMillionTokens: 0.08,
    cacheCreationPerMillionTokens: 1
  },
  "o4-mini": {
    inputPerMillionTokens: 1.1,
    outputPerMillionTokens: 4.4,
    cacheReadPerMillionTokens: 0.275,
    cacheCreationPerMillionTokens: 1.1
  },
  o3: {
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
    cacheReadPerMillionTokens: 0.5,
    cacheCreationPerMillionTokens: 2
  },
  "codex-mini": {
    inputPerMillionTokens: 1.5,
    outputPerMillionTokens: 6,
    cacheReadPerMillionTokens: 0.375,
    cacheCreationPerMillionTokens: 1.5
  },
  "gpt-4.1": {
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
    cacheReadPerMillionTokens: 0.5,
    cacheCreationPerMillionTokens: 2
  },
  "gpt-4.1-mini": {
    inputPerMillionTokens: 0.4,
    outputPerMillionTokens: 1.6,
    cacheReadPerMillionTokens: 0.1,
    cacheCreationPerMillionTokens: 0.4
  },
  "gpt-4.1-nano": {
    inputPerMillionTokens: 0.1,
    outputPerMillionTokens: 0.4,
    cacheReadPerMillionTokens: 0.025,
    cacheCreationPerMillionTokens: 0.1
  }
};

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

function normalizeUsageCostInput(usage: UsageCostInput) {
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
