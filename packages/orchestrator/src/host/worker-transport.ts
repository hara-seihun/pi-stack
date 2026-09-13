// Workers outlive daemon deployments. Replay only reads and receipts whose
// server handlers are idempotent; dispatches retain their unknown-outcome fence.
export function workerTransport(base: string, fetcher: (...args: Parameters<typeof fetch>) => Promise<Response> = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => number = Date.now) {
  return async (path: string, init?: RequestInit): Promise<any> => {
    const method = init?.method ?? "GET";
    const replayable = method === "GET" || method === "POST" && /^\/internal\/runs\/[^/]+\/(heartbeat|state|usage)$/.test(path);
    const deadline = now() + 120_000;
    for (;;) {
      let response: Response, value: any;
      try {
        response = await fetcher(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json", ...init?.headers } });
        value = await response.json();
      } catch (error) {
        if (!replayable || now() >= deadline || !(error instanceof TypeError || error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
        await wait(500);
        continue;
      }
      if (!response.ok) throw new Error(value.error ?? `orchestrator ${response.status}`);
      return value;
    }
  };
}
