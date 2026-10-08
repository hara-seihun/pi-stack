export type FixtureRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  reply: (request: Request) => Response | Promise<Response>;
} & ({ path: string; match?: never } | { match(url: URL): boolean; path?: never });

const bootstrapRoutes: readonly FixtureRoute[] = [
  { method: "GET", path: "/v1/environment", reply: () => Response.json({ environment: { persons: [{ user: "ui-fixture", displayName: "Synthetic person", requiresUnlock: false }], custody: null } }) },
  { method: "GET", path: "/v1/auth/session", reply: () => Response.json({ ok: true, user: "ui-fixture", session: "synthetic-ui-session" }) },
  { method: "GET", path: "/v1/environments", reply: () => Response.json({ environments: [{ id: "synthetic", name: "Synthetic local environment", baseUrl: "" }] }) },
  { method: "GET", path: "/v1/health", reply: () => Response.json({ environmentId: "synthetic" }) },
  { method: "POST", path: "/v1/diagnostics/requests", reply: () => Response.json({ ok: true }) },
];
let routes: readonly FixtureRoute[] = [];
export const fixtureRequests: { method: string; path: string; matched: boolean }[] = [];

export function configureFixtureTransport(next: readonly FixtureRoute[]) {
  routes = next;
  fixtureRequests.length = 0;
}

export function installFixtureTransport() {
  const assetFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin === location.origin && method === "GET" && !url.pathname.startsWith("/v1/")) {
      return assetFetch(input, init);
    }
    const route = url.origin === location.origin
      ? [...routes, ...bootstrapRoutes].find(route => route.method === method && (route.match ? route.match(url) : route.path === `${url.pathname}${url.search}`))
      : undefined;
    fixtureRequests.push({ method, path: `${url.pathname}${url.search}`, matched: route !== undefined });
    if (route) return route.reply(new Request(input, init));
    return Response.json({ error: "ui_fixture_request_unconfigured", message: `No synthetic fixture for ${method} ${url.pathname}${url.search}` }, { status: 501 });
  };
  globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
    construct() { throw new Error("UI catalogue forbids live WebSocket transport"); },
  });
}
