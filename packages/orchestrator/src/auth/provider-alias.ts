import type { Provider } from "@earendil-works/pi-ai";

export function aliasProvider(
  family: Provider,
  aliasId: string,
  label?: string,
  auth: Provider["auth"] = family.auth,
): Provider {
  return {
    id: aliasId,
    name:
      label === undefined
        ? `${family.name} [${aliasId}]`
        : `${family.name} [${label}]`,
    baseUrl: family.baseUrl,
    headers: family.headers,
    auth,
    getModels: () =>
      family.getModels().map((model) => ({
        ...model,
        provider: aliasId,
        name: `${model.name} (${aliasId})`,
      })),
    filterModels: family.filterModels?.bind(family),
    stream: (model, context, options) =>
      family.stream(model as never, context, options),
    streamSimple: (model, context, options) =>
      family.streamSimple(model, context, options),
  };
}
