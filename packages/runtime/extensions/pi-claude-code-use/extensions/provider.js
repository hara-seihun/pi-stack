export const CLAUDE_CODE_VERSION = "2.1.257";
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION}`;

export function isAnthropicProvider(provider) {
  return provider === "anthropic" || /^anthropic-\d+$/.test(provider ?? "");
}

export function applyClaudeCodeHeaders(headers) {
  for (const name of Object.keys(headers)) {
    if (name !== "user-agent" && name.toLowerCase() === "user-agent") {
      headers[name] = null;
    }
  }
  headers["user-agent"] = CLAUDE_CODE_USER_AGENT;
}
