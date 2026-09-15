import { expect, test } from "bun:test";
import { API } from "../server/api";
import { dismissServerError } from "./src/error-feedback";
import { DismissibleError } from "./src/dismissible-error";

test("dismissal posts the occurrence ID and reports transport failures instead of hiding them", async () => {
  const previous = new Map(["window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: Request[] = [];
  let fail = true;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { PiRemotePerson: { session: () => "person-session" } } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
      const request = new Request(`http://localhost${url}`, init);
      requests.push(request);
      return fail ? Response.json({ error: "Database unavailable" }, { status: 503 }) : Response.json({ ok: true });
    } });
    expect(await dismissServerError("occurrence/1")).toEqual({ ok: false, error: "Database unavailable" });
    fail = false;
    expect(await dismissServerError("occurrence/1")).toEqual({ ok: true });
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(API.dismissError.match(request.method, new URL(request.url).pathname)).toEqual({ errorId: "occurrence/1" });
    }
    const onDismiss = () => dismissServerError("occurrence/1");
    expect(DismissibleError({ message: "Offline", resetKey: "occurrence/1", onDismiss })!.props.onDismiss).toBe(onDismiss);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
