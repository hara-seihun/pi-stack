import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { rewriteAnthropicImages, type AnthropicFilesFetch, type AnthropicImagesOptions } from "../src/anthropic-files.js";

const NOW = Date.parse("2029-01-01T00:00:00.000Z");
const EXPIRES_AT = "2029-02-01T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "anthropic-files-"));
  roots.push(root);
  return root;
}

function image(data: Buffer, mimeType = "image/png") {
  return { type: "image", source: { type: "base64", media_type: mimeType, data: data.toString("base64") } };
}

function payload(...blocks: unknown[]) {
  return { model: "claude-test", messages: [{ role: "user", content: blocks }] };
}

function options<T>(value: T, root: string, fetcher: AnthropicFilesFetch, extra: Partial<AnthropicImagesOptions<T>> = {}): AnthropicImagesOptions<T> {
  return {
    payload: value,
    cacheRoot: root,
    scope: "anthropic-2",
    baseUrl: "https://api.anthropic.com",
    headers: {
      authorization: "Bearer oauth-token",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    signal: new AbortController().signal,
    fetch: fetcher,
    expiresInSeconds: 3_600,
    now: () => NOW,
    ...extra,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("uploads each byte-identical image once and rewrites only Anthropic content blocks", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  const source = image(bytes);
  const original = payload(
    source,
    { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "preview" }, source] },
    { type: "tool_use", id: "tool-2", name: "inspect", input: { source: source.source } },
  );
  const before = structuredClone(original);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.anthropic.com/v1/files");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.has("content-type")).toBe(false);
    const form = init?.body as FormData;
    expect(form.get("expires_in_seconds")).toBe("3600");
    const file = form.get("file") as File;
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    return response({ id: "file_01", expires_at: EXPIRES_AT });
  });

  const result = await rewriteAnthropicImages(options(original, cacheRoot(), fetcher));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.uploaded).toBe(1);
  expect(result.reused).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(original).toEqual(before);
  expect(result.value.messages[0]!.content).toEqual([
    { type: "image", source: { type: "file", file_id: "file_01" } },
    {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [
        { type: "text", text: "preview" },
        { type: "image", source: { type: "file", file_id: "file_01" } },
      ],
    },
    { type: "tool_use", id: "tool-2", name: "inspect", input: { source: source.source } },
  ]);
});

test("validates and uploads a multi-megabyte base64 image without regex recursion", async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0xa5);
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const file = (init?.body as FormData).get("file") as File;
    expect(file.size).toBe(bytes.byteLength);
    return response({ id: "file_large", expires_at: EXPIRES_AT });
  });

  const result = await rewriteAnthropicImages(options(payload(image(bytes)), cacheRoot(), fetcher));

  expect(result.ok && result.uploaded).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("reuses a durable mapping after direct metadata validation", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("same image")));
  const upload = vi.fn(async () => response({ id: "file_durable", expires_at: EXPIRES_AT }));
  const first = await rewriteAnthropicImages(options(value, root, upload));
  expect(first.ok && first.uploaded).toBe(1);

  const metadata = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.anthropic.com/v1/files/file_durable");
    expect(init?.method).toBe("GET");
    return response({ id: "file_durable", expires_at: EXPIRES_AT });
  });
  const second = await rewriteAnthropicImages(options(value, root, metadata));

  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.uploaded).toBe(0);
  expect(second.reused).toBe(1);
  expect((second.value.messages[0]!.content[0] as any).source).toEqual({ type: "file", file_id: "file_durable" });
  expect(metadata).toHaveBeenCalledTimes(1);
});

test("reuploads a remotely missing file and replaces its durable mapping", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("replace me")));
  await rewriteAnthropicImages(options(
    value,
    root,
    vi.fn(async () => response({ id: "file_deleted", expires_at: EXPIRES_AT })),
  ));
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return response({ type: "error", error: { type: "not_found_error", message: "File not found" } }, 404);
    return response({ id: "file_replacement", expires_at: EXPIRES_AT });
  });

  const result = await rewriteAnthropicImages(options(value, root, fetcher));

  expect(result.ok && result.uploaded).toBe(1);
  if (!result.ok) return;
  expect((result.value.messages[0]!.content[0] as any).source.file_id).toBe("file_replacement");
  expect(fetcher.mock.calls.map((call: any[]) => call[1]?.method)).toEqual(["GET", "POST"]);
  const stored = JSON.parse(readFileSync(join(root, readdirSync(root).find(name => name.endsWith(".json"))!), "utf8"));
  expect(Object.values(stored.files)).toEqual([
    expect.objectContaining({ fileId: "file_replacement" }),
  ]);
});

test("reuploads when direct metadata reports an expired file", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("metadata expired")));
  await rewriteAnthropicImages(options(
    value,
    root,
    vi.fn(async () => response({ id: "file_expired", expires_at: EXPIRES_AT })),
  ));
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") {
      return response({ id: "file_expired", expires_at: new Date(NOW - 86_400_000).toISOString() });
    }
    return response({ id: "file_fresh", expires_at: EXPIRES_AT });
  });

  const result = await rewriteAnthropicImages(options(value, root, fetcher));

  expect(result.ok && result.uploaded).toBe(1);
  if (!result.ok) return;
  expect((result.value.messages[0]!.content[0] as any).source.file_id).toBe("file_fresh");
  expect(fetcher.mock.calls.map((call: any[]) => call[1]?.method)).toEqual(["GET", "POST"]);
});

test("removes a near-expiry local mapping before metadata validation", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("expires soon")));
  await rewriteAnthropicImages(options(
    value,
    root,
    vi.fn(async () => response({ id: "file_expiring", expires_at: EXPIRES_AT })),
  ));
  const cachePath = join(root, readdirSync(root).find(name => name.endsWith(".json"))!);
  const stored = JSON.parse(readFileSync(cachePath, "utf8"));
  Object.values(stored.files).forEach((entry: any) => { entry.expiresAt = NOW + 4 * 60_000; });
  writeFileSync(cachePath, JSON.stringify(stored));
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    return response({ id: "file_fresh", expires_at: EXPIRES_AT });
  });

  const result = await rewriteAnthropicImages(options(value, root, fetcher));

  expect(result.ok && result.uploaded).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
  const updated = JSON.parse(readFileSync(cachePath, "utf8"));
  expect(Object.values(updated.files)).toEqual([
    expect.objectContaining({ fileId: "file_fresh" }),
  ]);
});

test("reads the expiry clock after waiting for the cache lock", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("lock wait")));
  await rewriteAnthropicImages(options(
    value,
    root,
    vi.fn(async () => response({ id: "file_waiting", expires_at: new Date(NOW + 10 * 60_000).toISOString() })),
  ));
  const cachePath = join(root, readdirSync(root).find(name => name.endsWith(".json"))!);
  mkdirSync(`${cachePath}.lock`);
  let clock = NOW;
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    return response({ id: "file_after_wait", expires_at: EXPIRES_AT });
  });

  const pending = rewriteAnthropicImages(options(value, root, fetcher, { now: () => clock }));
  await new Promise<void>(resolve => setImmediate(resolve));
  clock = NOW + 6 * 60_000;
  rmSync(`${cachePath}.lock`, { recursive: true });
  const result = await pending;

  expect(result.ok && result.uploaded).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("serializes concurrent callers so one upload owns a byte digest", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("concurrent")));
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  let uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      uploadStarted();
      await uploadGate;
      return response({ id: "file_shared", expires_at: EXPIRES_AT });
    }
    return response({ id: "file_shared", expires_at: EXPIRES_AT });
  });

  const firstPromise = rewriteAnthropicImages(options(value, root, fetcher));
  await started;
  const secondPromise = rewriteAnthropicImages(options(value, root, fetcher));
  releaseUpload();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  expect(first.ok && first.uploaded).toBe(1);
  expect(second.ok && second.reused).toBe(1);
  expect(fetcher.mock.calls.filter((call: any[]) => call[1]?.method === "POST")).toHaveLength(1);
  expect(fetcher.mock.calls.filter((call: any[]) => call[1]?.method === "GET")).toHaveLength(1);
});

test("bounds concurrent image uploads", async () => {
  const value = payload(...Array.from({ length: 5 }, (_, index) => image(Buffer.from(`upload-${index}`))));
  let active = 0;
  let maximum = 0;
  let nextId = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fullBatch!: () => void;
  const full = new Promise<void>(resolve => { fullBatch = resolve; });
  const fetcher = vi.fn(async () => {
    const id = `file_${nextId++}`;
    active++;
    maximum = Math.max(maximum, active);
    if (active === 4) fullBatch();
    await gate;
    active--;
    return response({ id, expires_at: EXPIRES_AT });
  });

  const pending = rewriteAnthropicImages(options(value, cacheRoot(), fetcher));
  await full;
  release();
  const result = await pending;

  expect(result.ok && result.uploaded).toBe(5);
  expect(maximum).toBe(4);
});

test("bounds parallel direct metadata validation", async () => {
  const root = cacheRoot();
  const value = payload(...Array.from({ length: 9 }, (_, index) => image(Buffer.from(`image-${index}`))));
  let file = 0;
  await rewriteAnthropicImages(options(
    value,
    root,
    vi.fn(async () => response({ id: `file_${file++}`, expires_at: EXPIRES_AT })),
  ));

  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fullBatch!: () => void;
  const full = new Promise<void>(resolve => { fullBatch = resolve; });
  const metadata = vi.fn(async (input: string | URL | Request) => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 8) fullBatch();
    await gate;
    active--;
    const id = decodeURIComponent(String(input).split("/").at(-1)!);
    return response({ id, expires_at: EXPIRES_AT });
  });

  const pending = rewriteAnthropicImages(options(value, root, metadata));
  await full;
  release();
  const result = await pending;

  expect(result.ok && result.reused).toBe(9);
  expect(metadata).toHaveBeenCalledTimes(9);
  expect(maximum).toBe(8);
  expect(metadata.mock.calls.every((call: any[]) => !String(call[0]).includes("?"))).toBe(true);
});

test("scopes mappings by endpoint and account alias", async () => {
  const root = cacheRoot();
  const value = payload(image(Buffer.from("scoped")));
  let id = 0;
  const fetcher = vi.fn(async () => response({ id: `file_${++id}`, expires_at: EXPIRES_AT }));

  const first = await rewriteAnthropicImages(options(value, root, fetcher));
  const second = await rewriteAnthropicImages(options(value, root, fetcher, { scope: "anthropic-3" }));
  const third = await rewriteAnthropicImages(options(value, root, fetcher, { baseUrl: "https://proxy.example/anthropic" }));

  expect(first.ok && first.uploaded).toBe(1);
  expect(second.ok && second.uploaded).toBe(1);
  expect(third.ok && third.uploaded).toBe(1);
  expect(readdirSync(root).filter(name => name.endsWith(".json"))).toHaveLength(3);
});

test("returns typed provider and cancellation errors without a base64 fallback", async () => {
  const value = payload(image(Buffer.from("must upload")));
  const providerFailure = await rewriteAnthropicImages(options(
    value,
    cacheRoot(),
    vi.fn(async () => response({ error: { type: "request_too_large", message: "Payload too large" } }, 413)),
  ));
  expect(providerFailure).toEqual({
    ok: false,
    error: {
      kind: "provider",
      operation: "upload",
      status: 413,
      providerType: "request_too_large",
      message: "Payload too large",
    },
  });

  const controller = new AbortController();
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const pending = rewriteAnthropicImages(options(
    value,
    cacheRoot(),
    vi.fn(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      requestStarted();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })),
    { signal: controller.signal },
  ));
  await started;
  controller.abort();
  expect(await pending).toEqual({
    ok: false,
    error: { kind: "cancelled", operation: "upload", message: "Anthropic Files operation was cancelled" },
  });
});

test("rejects malformed image data before touching the provider", async () => {
  const fetcher = vi.fn();
  const value = payload({ type: "image", source: { type: "base64", media_type: "image/png", data: "not base64" } });
  const result = await rewriteAnthropicImages(options(value, cacheRoot(), fetcher));
  expect(result).toEqual({
    ok: false,
    error: { kind: "invalid-image", message: "Anthropic image source contains invalid base64 data" },
  });
  expect(fetcher).not.toHaveBeenCalled();
});
