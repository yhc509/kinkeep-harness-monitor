import { describe, expect, it } from "vitest";
import claudeMultiToolTurn from "./__fixtures__/tool-attribution/claude-multi-tool-turn.json";
import claudeToolUsePair from "./__fixtures__/tool-attribution/claude-tool-use-pair.json";
import codexNoLabel from "./__fixtures__/tool-attribution/codex-no-label.json";
import codexOriginalTokenCount from "./__fixtures__/tool-attribution/codex-original-token-count.json";
import {
  computeClaudeAttribution,
  computeCodexAttribution,
  parseCodexOriginalTokenCount
} from "./tool-attribution-collector";

describe("tool attribution collector", () => {
  it("attributes a Claude tool result to the input delta and output tokens", () => {
    const attribution = computeClaudeAttribution(claudeToolUsePair.prevTurn, claudeToolUsePair.currTurn);

    expect(attribution).toEqual([
      {
        toolName: "ToolSearch",
        inputTokens: 260,
        outputTokens: 40
      }
    ]);
  });

  it("splits a Claude multi-tool turn evenly across matching tool results", () => {
    const attribution = computeClaudeAttribution(claudeMultiToolTurn.prevTurn, claudeMultiToolTurn.currTurn);

    expect(attribution).toEqual([
      {
        toolName: "Bash",
        inputTokens: 150,
        outputTokens: 30
      },
      {
        toolName: "Bash",
        inputTokens: 150,
        outputTokens: 30
      }
    ]);
  });

  it("parses a Codex Original token count label", () => {
    const output = codexOriginalTokenCount.functionCallOutput.payload.output;

    expect(parseCodexOriginalTokenCount(output)).toBe(30);
    expect(computeCodexAttribution(
      codexOriginalTokenCount.turn,
      codexOriginalTokenCount.functionCallOutput
    )).toMatchObject({
      toolName: "exec_command",
      inputTokens: 30,
      estimated: true
    });
  });

  it("returns null when a Codex function output has no Original token count label", () => {
    expect(parseCodexOriginalTokenCount(codexNoLabel.functionCallOutput.payload.output)).toBeNull();
  });
});
