import { extractClaudeToolName } from "./cmd-normalize";

export interface ToolTokenAttribution {
  toolName: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CodexToolTokenAttribution extends ToolTokenAttribution {
  estimated: true;
}

const CODEX_ORIGINAL_TOKEN_COUNT_PATTERN = /^\s*Original\s+token\s+count:\s*(\d+)/im;

export function computeClaudeAttribution(prevTurn: unknown, currTurn: unknown): ToolTokenAttribution[] {
  const prevRecord = isRecord(prevTurn) ? prevTurn : {};
  const currRecord = isRecord(currTurn) ? currTurn : {};
  const prevMessage = isRecord(prevRecord.message) ? prevRecord.message : {};
  const currMessage = isRecord(currRecord.message) ? currRecord.message : {};
  const toolUses = readToolUseBlocks(prevMessage);
  const toolResults = readToolResultIds(currMessage);

  if (toolUses.length === 0 || toolResults.size === 0) {
    return [];
  }

  const matchedUses = toolUses.filter((toolUse) => toolResults.has(toolUse.id));
  if (matchedUses.length === 0) {
    return [];
  }

  const inputDelta = Math.max(0, readClaudeInputTokens(currMessage.usage) - readClaudeInputTokens(prevMessage.usage));
  const outputTokens = readUsageNumber(currMessage.usage, "output_tokens");
  const inputShares = splitEvenly(inputDelta, matchedUses.length);
  const outputShares = splitEvenly(outputTokens, matchedUses.length);

  return matchedUses.map((toolUse, index) => ({
    toolName: extractClaudeToolName(toolUse.name),
    inputTokens: inputShares[index] ?? 0,
    outputTokens: outputShares[index] ?? 0
  }));
}

export function parseCodexOriginalTokenCount(functionCallOutputText: string): number | null {
  const match = CODEX_ORIGINAL_TOKEN_COUNT_PATTERN.exec(functionCallOutputText);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function computeCodexAttribution(
  turn: unknown,
  functionCallOutput: unknown
): CodexToolTokenAttribution | null {
  const turnRecord = isRecord(turn) ? turn : {};
  const outputRecord = isRecord(functionCallOutput) ? functionCallOutput : {};
  const turnPayload = isRecord(turnRecord.payload) ? turnRecord.payload : turnRecord;
  const outputPayload = isRecord(outputRecord.payload) ? outputRecord.payload : outputRecord;
  const output = typeof outputPayload.output === "string" ? outputPayload.output : null;
  const rawToolName = typeof turnPayload.name === "string" ? turnPayload.name.trim() : "";

  if (!rawToolName || !output) {
    return null;
  }

  return {
    toolName: rawToolName,
    inputTokens: parseCodexOriginalTokenCount(output) ?? 0,
    outputTokens: estimateTextTokens(stripCodexTokenCountHeader(output)),
    estimated: true
  };
}

function readToolUseBlocks(message: Record<string, unknown>): Array<{ id: string; name: string }> {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
      return [];
    }

    return [{ id: block.id, name: block.name }];
  });
}

function readToolResultIds(message: Record<string, unknown>): Set<string> {
  const content = Array.isArray(message.content) ? message.content : [];
  return new Set(content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return [];
    }

    return [block.tool_use_id];
  }));
}

function readClaudeInputTokens(usage: unknown): number {
  return (
    readUsageNumber(usage, "input_tokens")
    + readUsageNumber(usage, "cache_creation_input_tokens")
    + readUsageNumber(usage, "cache_read_input_tokens")
  );
}

function readUsageNumber(usage: unknown, key: string): number {
  if (!isRecord(usage)) {
    return 0;
  }

  const value = usage[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) {
    return [];
  }

  const normalizedTotal = Math.max(0, Math.trunc(total));
  const base = Math.floor(normalizedTotal / parts);
  const remainder = normalizedTotal % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function stripCodexTokenCountHeader(value: string): string {
  return value.replace(CODEX_ORIGINAL_TOKEN_COUNT_PATTERN, "").trim();
}

function estimateTextTokens(value: string): number {
  const trimmed = value.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
