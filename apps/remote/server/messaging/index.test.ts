import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "../api";
import { createMessagingService, messagingRoot } from "./index";

const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

test("new encrypted accounts have no implicit profile and only accepted tool routes emit operation names", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-endpoint-"));
  const data = join(root, "data");
  mkdirSync(data);
  const operations: string[] = [];
  const endpoint = createMessagingService(data, root, true, operation => operations.push(operation));
  try {
    expect(JSON.parse(readFileSync(join(data, "messaging", "profiles.json"), "utf8"))).toEqual({ version: 1, profiles: [] });
    expect(endpoint.snapshot()).toMatchObject({ ok: true, value: { backends: [], conversations: [] } });
    expect(operations).toEqual([]);
    expect((await endpoint.handle(request(API.messaging.path())))?.status).toBe(200);
    expect(operations).toEqual(["messaging"]);
    expect((await endpoint.handle(request(API.messagingOpen.path(), "POST", {})))?.ok).toBe(false);
    expect(await endpoint.handle(request("/v1/messaging"))).toBeNull();
    expect(operations).toEqual(["messaging"]);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable Signal endpoints return typed failure and HTTP 503 instead of fake backend success", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-endpoint-"));
  const endpoint = createMessagingService(root, root, false);
  try {
    expect(endpoint.snapshot()).toMatchObject({ ok: false, error: { code: "signal_unavailable" } });
    for (const [path, method] of [[API.messaging.path(), "GET"], [API.messagingOpen.path(), "POST"]]) {
      const response = await endpoint.handle(request(path!, method));
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ code: "signal_unavailable" });
    }
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("action journal cannot escape the encrypted account through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-endpoint-"));
  const outside = mkdtempSync(join(tmpdir(), "signal-journal-outside-"));
  try {
    const data = join(root, "data");
    mkdirSync(data);
    const messaging = messagingRoot(data, root, true);
    symlinkSync(outside, join(messaging, "action-journal"));
    expect(() => messagingRoot(data, root, true)).toThrow("action-journal cannot point outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
