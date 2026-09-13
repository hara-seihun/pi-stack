import { expect, it, vi } from "vitest";
import { workerTransport } from "../src/host/worker-transport.js";

it("keeps receipt identity across daemon loss without replaying ambiguous commands", async () => {
  for (const path of ["/internal/runs/r/control", "/internal/runs/r/state", "/internal/runs/r/usage", "/internal/runs/r/heartbeat"]) {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(new Response('{"ok":true}'));
    const request = workerTransport("http://daemon", fetcher, async () => {});
    const init = path.endsWith("control") ? undefined : { method: "POST", body: '{"receiptId":"same"}' };
    expect(await request(path, init)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body).toBe(init?.body);
  }
  const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  const request = workerTransport("http://daemon", fetcher, async () => {});
  await expect(request("/internal/runs/r/dispatch", { method: "POST" })).rejects.toThrow("fetch failed");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("bounds recovery and preserves application errors", async () => {
  let clock = 0;
  const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  await expect(workerTransport("http://daemon", fetcher, async () => { clock += 120_000; }, () => clock)("/internal/runs/r")).rejects.toThrow("fetch failed");
  expect(fetcher).toHaveBeenCalledTimes(2);
  const rejected = vi.fn().mockResolvedValue(new Response('{"error":"rejected"}', { status: 409 }));
  await expect(workerTransport("http://daemon", rejected)("/internal/runs/r")).rejects.toThrow("rejected");
  expect(rejected).toHaveBeenCalledOnce();
});
