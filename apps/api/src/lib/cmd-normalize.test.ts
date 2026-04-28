import { describe, expect, it } from "vitest";
import { extractClaudeToolName, extractCodexToolNames } from "./cmd-normalize";

describe("cmd-normalize", () => {
  describe("extractCodexToolNames", () => {
    it("extracts the first command token", () => {
      expect(extractCodexToolNames("git status --short --branch")).toEqual(["git"]);
    });

    it("extracts pipe-separated command tokens", () => {
      expect(extractCodexToolNames("nl file | sed -n '1,10p'")).toEqual(["nl", "sed"]);
    });

    it("extracts semicolon-separated command tokens", () => {
      expect(extractCodexToolNames("mkdir tmp; cd tmp; ls")).toEqual(["mkdir", "cd", "ls"]);
    });

    it("skips leading env assignments", () => {
      expect(extractCodexToolNames("VAR=1 cmd")).toEqual(["cmd"]);
    });

    it("drops shell control segments while keeping commands after do", () => {
      expect(extractCodexToolNames("for f in *; do nl $f; done")).toEqual(["nl"]);
    });

    it("drops leading command-substitution assignments", () => {
      expect(extractCodexToolNames("tmpdir=$(mktemp); cd $tmpdir")).toEqual(["cd"]);
    });
  });

  describe("extractClaudeToolName", () => {
    it("normalizes Claude MCP names to the server bucket", () => {
      expect(extractClaudeToolName("mcp__obsidian__read_file")).toBe("mcp:obsidian");
    });
  });
});
