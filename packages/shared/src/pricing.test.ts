import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PRICING_KEY,
  MODEL_PRICING_TABLE,
  estimateUsageCost,
  normalizeUsageCostInput,
  resolveModelPricing
} from "./pricing";

describe("resolveModelPricing", () => {
  it("returns the exact pricing entry when the key matches", () => {
    expect(resolveModelPricing("claude-sonnet-4-6")).toEqual(MODEL_PRICING_TABLE["claude-sonnet-4-6"]);
  });

  it("matches model aliases with dated suffixes", () => {
    expect(resolveModelPricing("claude-sonnet-4-5-20250929")).toEqual(MODEL_PRICING_TABLE["claude-sonnet-4-5"]);
    expect(resolveModelPricing("anthropic/claude-opus-4-5-20251101")).toEqual(MODEL_PRICING_TABLE["claude-opus-4-5"]);
  });

  it("keeps o3-mini distinct from o3 during prefix matching", () => {
    expect(resolveModelPricing("o3-mini-2025-01-31")).toEqual(MODEL_PRICING_TABLE["o3-mini"]);
    expect(resolveModelPricing("o3-2025-04-16")).toEqual(MODEL_PRICING_TABLE.o3);
  });

  it("falls back to the default pricing for unknown models", () => {
    expect(resolveModelPricing("unknown-model")).toEqual(MODEL_PRICING_TABLE[DEFAULT_MODEL_PRICING_KEY]);
    expect(resolveModelPricing(null)).toEqual(MODEL_PRICING_TABLE[DEFAULT_MODEL_PRICING_KEY]);
  });
});

describe("estimateUsageCost", () => {
  it("applies each token bucket to the matching rate", () => {
    const cost = estimateUsageCost({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 30,
      outputTokens: 40
    }, "claude-sonnet-4-6");

    expect(cost).toBeCloseTo(0.0008685, 10);
  });
});

describe("normalizeUsageCostInput", () => {
  it("normalizes missing and null values to zero", () => {
    expect(normalizeUsageCostInput({
      inputTokens: null,
      cachedInputTokens: undefined,
      cacheCreationInputTokens: null,
      outputTokens: undefined
    })).toEqual({
      totalInputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      directInputTokens: 0,
      outputTokens: 0
    });
  });

  it("derives missing totals from partial usage fields", () => {
    expect(normalizeUsageCostInput({
      cachedInputTokens: 20,
      cacheCreationInputTokens: 30,
      outputTokens: 5
    })).toEqual({
      totalInputTokens: 50,
      cachedInputTokens: 20,
      uncachedInputTokens: 0,
      cacheCreationInputTokens: 30,
      directInputTokens: 0,
      outputTokens: 5
    });
  });
});
