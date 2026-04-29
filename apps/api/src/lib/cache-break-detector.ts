import type {
  BreakCause,
  BreakDetectionInput,
  BreakDetectionResult,
  Confidence,
  Provider,
  TurnSnapshot
} from "./cache-break-types";

const MIN_BREAK_DROP_PP = 0.2;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const UNKNOWN_MODEL_NAMES = new Set(["", "<unknown>", "unknown", "unknown model"]);

type DetectionMatch = Omit<BreakDetectionResult, "droppedPp">;

export function detectCacheBreak(input: BreakDetectionInput): BreakDetectionResult | null {
  const droppedPp = input.prevTurn.hitRate - input.currTurn.hitRate;

  if (droppedPp < MIN_BREAK_DROP_PP) {
    return null;
  }

  const match =
    detectModelSwitch(input.prevTurn, input.currTurn) ??
    detectSystemPromptChange(input.prevTurn, input.currTurn) ??
    detectTtlExpired(input.provider, input.prevTurn, input.currTurn) ??
    detectCompression(input.provider, input.prevTurn, input.currTurn) ??
    detectContextRebuild(input.provider, input.prevTurn, input.currTurn) ??
    detectUnknown(input.provider, input.prevTurn, input.currTurn);

  return {
    droppedPp,
    ...match
  };
}

function detectModelSwitch(prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch | null {
  if (prev.model === curr.model || isUnknownModelName(prev.model) || isUnknownModelName(curr.model)) {
    return null;
  }

  return createMatch("model_switch", "high", {
    modelFrom: prev.model,
    modelTo: curr.model
  });
}

function detectSystemPromptChange(prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch | null {
  if (
    prev.baseInstructionsHash === null ||
    curr.baseInstructionsHash === null ||
    prev.baseInstructionsHash === curr.baseInstructionsHash
  ) {
    return null;
  }

  return createMatch("system_prompt_change", "high", {
    prevHash: prev.baseInstructionsHash,
    currHash: curr.baseInstructionsHash
  });
}

function detectTtlExpired(provider: Provider, prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch | null {
  const idleMs = curr.ts - prev.ts;
  const idleSec = idleMs / 1000;

  if (provider === "codex") {
    if (idleMs >= FIVE_MINUTES_MS) {
      return createMatch("ttl_expired", "low", { idleSec });
    }

    return null;
  }

  const evidence = {
    idleSec,
    prevEphemeral5mInputTokens: prev.ephemeral5mInputTokens,
    prevEphemeral1hInputTokens: prev.ephemeral1hInputTokens
  };

  if (idleMs >= FIVE_MINUTES_MS && tokenCountIsPositive(prev.ephemeral5mInputTokens)) {
    return createMatch("ttl_expired", "high", evidence);
  }

  if (idleMs >= ONE_HOUR_MS && tokenCountIsPositive(prev.ephemeral1hInputTokens)) {
    return createMatch("ttl_expired", "high", evidence);
  }

  if (idleMs >= FIVE_MINUTES_MS && prev.ephemeral5mInputTokens === null && prev.ephemeral1hInputTokens === null) {
    return createMatch("ttl_expired", "low", evidence);
  }

  return null;
}

function detectCompression(provider: Provider, prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch | null {
  if (provider === "codex") {
    return null;
  }

  if (curr.totalInputTokens < prev.totalInputTokens * 0.5 && curr.cachedInputTokens === 0) {
    return createMatch("compression", "high", {
      prevTotalInputTokens: prev.totalInputTokens,
      currTotalInputTokens: curr.totalInputTokens,
      currCachedInputTokens: curr.cachedInputTokens
    });
  }

  return null;
}

function detectContextRebuild(provider: Provider, prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch | null {
  if (provider === "claude_code") {
    if (
      prev.cacheReadInputTokens !== null &&
      curr.cacheReadInputTokens !== null &&
      curr.cacheReadInputTokens < prev.cacheReadInputTokens * 0.5
    ) {
      return createMatch("context_rebuild", "high", {
        prevCacheReadInputTokens: prev.cacheReadInputTokens,
        currCacheReadInputTokens: curr.cacheReadInputTokens
      });
    }

    return null;
  }

  if (
    prev.cachedInputTokens !== null &&
    curr.cachedInputTokens !== null &&
    curr.cachedInputTokens < prev.cachedInputTokens * 0.5
  ) {
    return createMatch("context_rebuild", "low", {
      prevCachedInputTokens: prev.cachedInputTokens,
      currCachedInputTokens: curr.cachedInputTokens
    });
  }

  return null;
}

function detectUnknown(provider: Provider, prev: TurnSnapshot, curr: TurnSnapshot): DetectionMatch {
  const evidence: Record<string, unknown> = {
    idleSec: (curr.ts - prev.ts) / 1000,
    modelFrom: prev.model,
    modelTo: curr.model,
    prevHash: prev.baseInstructionsHash,
    currHash: curr.baseInstructionsHash,
    prevTotalInputTokens: prev.totalInputTokens,
    currTotalInputTokens: curr.totalInputTokens
  };

  if (provider === "claude_code") {
    evidence.prevCacheReadInputTokens = prev.cacheReadInputTokens;
    evidence.currCacheReadInputTokens = curr.cacheReadInputTokens;
  } else {
    evidence.prevCachedInputTokens = prev.cachedInputTokens;
    evidence.currCachedInputTokens = curr.cachedInputTokens;
  }

  return createMatch("unknown", "low", evidence);
}

function createMatch(primaryCause: BreakCause, confidence: Confidence, evidence: Record<string, unknown>): DetectionMatch {
  return {
    primaryCause,
    confidence,
    evidence
  };
}

function tokenCountIsPositive(value: number | null): boolean {
  return value !== null && value > 0;
}

function isUnknownModelName(value: string | null | undefined): boolean {
  return UNKNOWN_MODEL_NAMES.has(value?.trim().toLowerCase() ?? "");
}
