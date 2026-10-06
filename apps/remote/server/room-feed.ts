export function roomFeed(signal: AbortSignal, subscribe: (send: (value: unknown) => void) => () => void): Response {
  const encoder = new TextEncoder();
  let cleanup = (_cancelled: boolean) => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => finish(false);
      const finish = (cancelled: boolean) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal.removeEventListener("abort", close);
        unsubscribe();
        if (!cancelled) controller.close();
      };
      const send = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
      const unsubscribe = subscribe(send);
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": alive\n\n")); }, 25_000);
      cleanup = finish;
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
    },
    cancel() { cleanup(true); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
