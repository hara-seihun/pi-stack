// The Android shell loads the client from http://localhost and calls the API
// across origins, so every API response and every preflight carries these.
// One definition for the front door and the supervisor, so a header one of
// them learns about is a header the other allows.
export const API_CORS_HEADERS = {
  "access-control-allow-origin": "http://localhost",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "accept, content-type, if-none-match, range, x-chunk-sha256, x-pi-remote-user, x-pi-remote-session",
  "access-control-expose-headers": "accept-ranges, content-disposition, content-length, content-range, etag",
} as const;

export function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(API_CORS_HEADERS)) response.headers.set(name, value);
  return response;
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...API_CORS_HEADERS, "access-control-max-age": "86400" },
  });
}
