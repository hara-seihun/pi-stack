const API_CORS_HEADERS = {
  "access-control-allow-origin": "http://localhost",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "accept, content-type, if-none-match, range, x-chunk-sha256, x-pi-remote-user",
  "access-control-expose-headers": "accept-ranges, content-disposition, content-length, content-range, etag, x-pi-state-version, x-pi-voice-account, x-pi-voice-lease",
} as const;

export function withRouterCors(response: Response): Response {
  for (const [name, value] of Object.entries(API_CORS_HEADERS)) response.headers.set(name, value);
  return response;
}

export function routerPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...API_CORS_HEADERS, "access-control-max-age": "86400" },
  });
}
