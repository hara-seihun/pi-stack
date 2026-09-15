import type { Provider } from "@earendil-works/pi-ai";

/**
 * Pi Stack serves OpenAI and Anthropic entirely from the shared account pool.
 * Nobody on the machine holds a personal subscription or an API key, and the
 * upstream family providers do not know that: their auth resolves ambient
 * sources, so `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or
 * a stray credential in a person's `~/.pi/agent/auth.json` would quietly carry
 * a session's traffic outside the pool, off the subscriptions, and onto
 * metered billing nobody asked for.
 *
 * Registering the family id with this auth removes that route. The only way to
 * reach the provider is a numbered pooled alias from `sharedOAuthProvider`, and
 * a session that never bound one says so instead of reporting a missing API
 * key. It mirrors what the model broker already does for people who reach the
 * pool over the Unix-user socket, where the family ids carry broker auth and
 * nothing else.
 */
export function pooledOnlyProvider(family: Provider): Provider {
  const refusal = `${family.id} is served from the shared account pool. `
    + `Pi Stack does not use API keys or per-person credentials, so this session needs a pooled account `
    + `(see \`pi-orchestrator account list\`).`;
  return {
    ...family,
    auth: {
      apiKey: {
        name: `${family.name} shared account pool`,
        async check() { return undefined; },
        async resolve() { throw new Error(refusal); },
      },
    },
  };
}
