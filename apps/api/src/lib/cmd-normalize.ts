const DROP_SEGMENT_KEYWORDS = new Set(["for", "while", "if", "case", "done", "fi", "esac"]);
const SKIP_LEADING_KEYWORDS = new Set(["do", "then", "else"]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CLAUDE_MCP_PATTERN = /^mcp__([^_]+(?:_[^_]+)*?)__/;

export function extractCodexToolNames(cmd: string): string[] {
  return splitOutsideQuotes(stripHeredocBody(unwrapSubshell(cmd)))
    .flatMap((segment) => {
      const toolName = extractCodexSegmentToolName(segment);
      return toolName ? [toolName] : [];
    });
}

export function extractClaudeToolName(name: string): string {
  const trimmed = name.trim();
  const mcpMatch = CLAUDE_MCP_PATTERN.exec(trimmed);
  return mcpMatch ? `mcp:${mcpMatch[1]}` : trimmed;
}

function extractCodexSegmentToolName(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let tokenIndex = 0;

  while (tokenIndex < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[tokenIndex]!)) {
    tokenIndex += 1;
  }

  if (tokenIndex >= tokens.length) {
    return null;
  }

  while (tokenIndex < tokens.length && SKIP_LEADING_KEYWORDS.has(tokens[tokenIndex]!)) {
    tokenIndex += 1;
  }

  if (tokenIndex >= tokens.length) {
    return null;
  }

  const token = stripTokenQuotes(tokens[tokenIndex]!);
  if (
    !token
    || token.includes("'")
    || token.includes("\"")
    || DROP_SEGMENT_KEYWORDS.has(token)
    || token.startsWith("$")
    || token.startsWith("(")
  ) {
    return null;
  }

  return token;
}

function splitOutsideQuotes(s: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  const pushSegment = () => {
    const trimmed = segment.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    segment = "";
  };

  for (let index = 0; index < s.length; index += 1) {
    const char = s[index]!;
    const nextChar = s[index + 1];

    if (quote !== "'" && char === "\\" && !escaped) {
      escaped = true;
      segment += char;
      continue;
    }

    if (escaped) {
      escaped = false;
      segment += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      segment += char;
      continue;
    }

    if (isQuote(char)) {
      quote = char;
      segment += char;
      continue;
    }

    if ((char === "|" && nextChar === "|") || (char === "&" && nextChar === "&")) {
      pushSegment();
      index += 1;
      continue;
    }

    if (char === "|" || char === ";") {
      pushSegment();
      continue;
    }

    segment += char;
  }

  pushSegment();
  return segments;
}

function stripTokenQuotes(token: string): string {
  let stripped = token;
  while (
    stripped.length >= 2
    && isQuote(stripped[0]!)
    && stripped[0] === stripped[stripped.length - 1]
  ) {
    stripped = stripped.slice(1, -1);
  }
  return stripped;
}

function isQuote(value: string): value is "'" | "\"" {
  return value === "'" || value === "\"";
}

function unwrapSubshell(cmd: string): string {
  const trimmed = cmd.trim();
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  if (!firstToken.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed;
  }

  return trimmed.slice(1, -1).trim();
}

function stripHeredocBody(cmd: string): string {
  const heredocIndex = cmd.search(/<<-?/);
  return heredocIndex >= 0 ? cmd.slice(0, heredocIndex) : cmd;
}
