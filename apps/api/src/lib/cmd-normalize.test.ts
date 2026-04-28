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

    it("extracts commands split by shell boolean operators", () => {
      expect(extractCodexToolNames("cd foo && rg bar")).toEqual(["cd", "rg"]);
      expect(extractCodexToolNames("cmd1 || cmd2")).toEqual(["cmd1", "cmd2"]);
    });

    it("ignores command separators inside quoted arguments", () => {
      expect(extractCodexToolNames("rg 'foo|bar' README.md")).toEqual(["rg"]);
      expect(extractCodexToolNames('python -c "print(1);print(2)"')).toEqual(["python"]);
      expect(extractCodexToolNames('python -c "print(\\"a;b\\")"')).toEqual(["python"]);
      expect(extractCodexToolNames("awk '/foo|bar/' file.txt")).toEqual(["awk"]);
      expect(extractCodexToolNames("sh -c 'cd foo && rg bar'")).toEqual(["sh"]);
    });

    it("drops command tokens with unbalanced quotes", () => {
      expect(extractCodexToolNames("echo ok | bar' baz")).toEqual(["echo"]);
    });

    it("skips leading env assignments", () => {
      expect(extractCodexToolNames("VAR=1 cmd")).toEqual(["cmd"]);
    });

    it("drops shell control segments while keeping commands after do", () => {
      expect(extractCodexToolNames("for f in *; do nl $f; done")).toEqual(["nl"]);
    });

    it("drops leading command-substitution assignments", () => {
      expect(extractCodexToolNames("tmpdir=$(mktemp); cd $tmpdir")).toEqual(["cd"]);
      expect(extractCodexToolNames("tmpdir=$(mktemp) && cd \"$tmpdir\"")).toEqual(["cd"]);
    });

    it("unwraps one shell subshell before extracting commands", () => {
      expect(extractCodexToolNames("(cd /tmp && ls)")).toEqual(["cd", "ls"]);
      expect(extractCodexToolNames("(cd /tmp; ls)")).toEqual(["cd", "ls"]);
    });

    it("ignores heredoc bodies when splitting commands", () => {
      expect(extractCodexToolNames("cat <<EOF\nrm -rf /\nEOF")).toEqual(["cat"]);
    });

    it("strips nested quote pairs from command tokens", () => {
      expect(extractCodexToolNames("'\"git\"' status")).toEqual(["git"]);
      expect(extractCodexToolNames("\"'rg'\" foo")).toEqual(["rg"]);
    });
  });

  describe("extractClaudeToolName", () => {
    it("normalizes Claude MCP names to the server bucket", () => {
      expect(extractClaudeToolName("mcp__obsidian__read_file")).toBe("mcp:obsidian");
    });
  });
});
