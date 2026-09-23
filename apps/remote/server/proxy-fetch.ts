type ProxyRequestInit = RequestInit & { decompress?: boolean };

// A proxy must forward the encoded bytes that match the upstream
// Content-Encoding header. Bun fetch otherwise transparently decompresses the
// body while retaining that header, causing downstream clients to decode an
// already-decoded response.
export function proxyFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, decompress: false } as ProxyRequestInit);
}
