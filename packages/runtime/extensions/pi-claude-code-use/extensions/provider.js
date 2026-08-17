export function isAnthropicProvider(provider) {
  return provider === "anthropic" || /^anthropic-\d+$/.test(provider ?? "");
}
