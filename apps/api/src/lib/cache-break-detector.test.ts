import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectCacheBreak } from "./cache-break-detector";
import type { BreakCause, BreakDetectionInput, Confidence, TurnSnapshot } from "./cache-break-types";

interface CacheBreakFixture extends BreakDetectionInput {
  expected: {
    isBreak: boolean;
    primaryCause: BreakCause;
    confidence: Confidence;
    droppedPp: number;
  };
  notes?: string;
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "cache-break");
const fixtures = fs.readdirSync(fixtureDir)
  .filter((filename) => filename.endsWith(".json"))
  .sort()
  .map((filename) => ({
    filename,
    fixture: JSON.parse(fs.readFileSync(path.join(fixtureDir, filename), "utf8")) as CacheBreakFixture
  }));

describe("detectCacheBreak", () => {
  it.each(fixtures)("matches fixture $filename", ({ fixture }) => {
    const result = detectCacheBreak(fixture);
    const computedDroppedPp = fixture.prevTurn.hitRate - fixture.currTurn.hitRate;

    expect(Math.abs(computedDroppedPp - fixture.expected.droppedPp)).toBeLessThanOrEqual(0.001);

    if (fixture.expected.isBreak) {
      expect(result).not.toBeNull();

      if (result === null) {
        return;
      }

      expect(result.primaryCause).toBe(fixture.expected.primaryCause);
      expect(result.confidence).toBe(fixture.expected.confidence);
      expect(Math.abs(result.droppedPp - fixture.expected.droppedPp)).toBeLessThanOrEqual(0.001);
      return;
    }

    expect(result === null || result.droppedPp < 0.2).toBe(true);
  });

  it("treats 0.20 droppedPp as a break and 0.199 as below threshold", () => {
    const prevTurn = createTurn({ hitRate: 0.9 });

    const hit = detectCacheBreak({
      provider: "codex",
      prevTurn,
      currTurn: createTurn({ hitRate: 0.7 })
    });
    const miss = detectCacheBreak({
      provider: "codex",
      prevTurn,
      currTurn: createTurn({ hitRate: 0.701 })
    });

    expect(hit).not.toBeNull();
    expect(hit?.primaryCause).toBe("unknown");
    expect(hit?.droppedPp).toBeCloseTo(0.2, 3);
    expect(miss).toBeNull();
  });

  it("chooses model_switch when model and system prompt both change", () => {
    const result = detectCacheBreak({
      provider: "claude_code",
      prevTurn: createTurn({
        provider: "claude_code",
        model: "claude-opus-4-7",
        baseInstructionsHash: "sha256:base-a",
        hitRate: 0.9
      }),
      currTurn: createTurn({
        provider: "claude_code",
        model: "claude-sonnet-4-7",
        baseInstructionsHash: "sha256:base-b",
        hitRate: 0.1
      })
    });

    expect(result?.primaryCause).toBe("model_switch");
    expect(result?.confidence).toBe("high");
  });

  it("does not classify unknown-to-known model names as a model switch", () => {
    for (const unknownModel of ["", "<unknown>", "unknown", "Unknown Model"]) {
      const result = detectCacheBreak({
        provider: "codex",
        prevTurn: createTurn({
          model: unknownModel,
          hitRate: 0.9
        }),
        currTurn: createTurn({
          model: "gpt-5.4",
          hitRate: 0.1
        })
      });

      expect(result).not.toBeNull();
      expect(result?.primaryCause).not.toBe("model_switch");
    }
  });

  it("skips compression detection for Codex", () => {
    const result = detectCacheBreak({
      provider: "codex",
      prevTurn: createTurn({
        provider: "codex",
        totalInputTokens: 100_000,
        cachedInputTokens: null,
        cacheReadInputTokens: null,
        hitRate: 0.9
      }),
      currTurn: createTurn({
        provider: "codex",
        totalInputTokens: 10_000,
        cachedInputTokens: 0,
        cacheReadInputTokens: null,
        hitRate: 0
      })
    });

    expect(result).not.toBeNull();
    expect(result?.primaryCause).not.toBe("compression");
    expect(result?.primaryCause).toBe("unknown");
  });

  it("does not detect a system prompt change when either baseInstructionsHash is null", () => {
    const result = detectCacheBreak({
      provider: "claude_code",
      prevTurn: createTurn({
        provider: "claude_code",
        baseInstructionsHash: null,
        cachedInputTokens: null,
        cacheReadInputTokens: null,
        hitRate: 0.9
      }),
      currTurn: createTurn({
        provider: "claude_code",
        baseInstructionsHash: "sha256:base-b",
        cachedInputTokens: null,
        cacheReadInputTokens: null,
        hitRate: 0.1
      })
    });

    expect(result).not.toBeNull();
    expect(result?.primaryCause).not.toBe("system_prompt_change");
    expect(result?.primaryCause).toBe("unknown");
  });
});

function createTurn(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  const provider = overrides.provider ?? "codex";

  return {
    ts: 1_776_686_400_000,
    model: "gpt-5.4",
    provider,
    totalInputTokens: 50_000,
    cachedInputTokens: provider === "codex" ? null : 40_000,
    cacheReadInputTokens: provider === "codex" ? null : 40_000,
    cacheCreationInputTokens: provider === "codex" ? null : 5_000,
    ephemeral5mInputTokens: provider === "codex" ? null : 0,
    ephemeral1hInputTokens: provider === "codex" ? null : 0,
    baseInstructionsHash: "sha256:base-a",
    hitRate: 0.9,
    ...overrides
  };
}
