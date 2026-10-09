import { abortable } from "./abortable";

export const CONTROLLER_REPLACEMENT_TIMEOUT_MS = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestIdentity(path: string, init: RequestInit): string | undefined {
  if (init.method !== "POST" || typeof init.body !== "string"
    || !(path === "/v1/sessions" || /^\/v1\/sessions\/[^/]+\/prompt$/.test(path))) return undefined;
  try {
    const body = JSON.parse(init.body);
    return body && typeof body === "object" && !Array.isArray(body) && typeof body.requestId === "string" && uuid.test(body.requestId)
      ? body.requestId : undefined;
  } catch { return undefined; }
}

export class ControllerReplacementError extends Error {
  readonly code = "acceptance-unconfirmed";
  constructor(readonly requestId: string, cause: unknown) {
    super(`Acceptance is unconfirmed for request ${requestId}; retry this same saved request, not a new instruction. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The committed owner receipt, not a successful HTTP write, determines acceptance. */
export async function controllerReplacementFetch(path: string, init: RequestInit,
  send: (signal?: AbortSignal) => Promise<Response>, assertOwner: () => void): Promise<Response> {
  const requestId = requestIdentity(path, init);
  if (!requestId) return send(init.signal ?? undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Controller replacement acknowledgement timed out")), CONTROLLER_REPLACEMENT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let attempt = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      assertOwner();
      try {
        const response = await abortable(send(signal), signal);
        assertOwner();
        if (![502, 503, 504].includes(response.status)) {
          const body = await abortable(response.arrayBuffer(), signal);
          signal.throwIfAborted();
          assertOwner();
          return new Response([204, 205, 304].includes(response.status) ? null : body,
            { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        await response.body?.cancel();
      } catch (error) {
        signal.throwIfAborted();
        assertOwner();
        if (!(error instanceof TypeError)) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(wait); reject(signal.reason); };
        const wait = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); },
          Math.min(100 * 2 ** Math.min(attempt++, 4), 1_000));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  } catch (error) {
    if (controller.signal.aborted) throw new ControllerReplacementError(requestId, error);
    throw error;
  } finally { clearTimeout(timer); }
}
