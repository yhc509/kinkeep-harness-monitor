export type Provider = "claude_code" | "codex";

export type BreakCause =
  | "ttl_expired"
  | "system_prompt_change"
  | "model_switch"
  | "context_rebuild"
  | "compression"
  | "unknown";

export type Confidence = "high" | "low";

export interface TurnSnapshot {
  ts: number;
  model: string;
  provider: Provider;
  totalInputTokens: number;
  cachedInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  ephemeral5mInputTokens: number | null;
  ephemeral1hInputTokens: number | null;
  baseInstructionsHash: string | null;
  hitRate: number;
}

export interface BreakDetectionInput {
  provider: Provider;
  prevTurn: TurnSnapshot;
  currTurn: TurnSnapshot;
}

export interface BreakDetectionResult {
  droppedPp: number;
  primaryCause: BreakCause;
  confidence: Confidence;
  evidence: Record<string, unknown>;
}
