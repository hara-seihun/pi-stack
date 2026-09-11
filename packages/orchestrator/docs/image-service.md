# Shared image generation API

`pi-orchestrator/api` exports `createSharedImageGenerationService` for long-running callers such as the Pi Remote supervisor. It uses the same account selection, shared OAuth lock, input loader, interactive leases and provider request as the [native image tool](image-generation.md). It does not load personal credentials, create image files, store jobs or retry requests.

```ts
import { createSharedImageGenerationService } from "pi-orchestrator/api";

const images = createSharedImageGenerationService();
const result = await images.generateImageWithSharedAccount({
  prompt: "A blue circle",
  inputPaths: [],
  model: "gpt-image-2.5-flare",
}, { signal, cwd });

if (result.ok) {
  // Persist every image before marking the caller's job complete.
  for (const image of result.images) await persist(image.id, image.bytes);
  await complete(result.model, result.responseId, result.usage);
} else {
  await fail(result.error.kind, result.error.message);
}

await images.close();
```

The factory is synchronous and opens its own ledger connection. Options are `configPath`, `ledgerPath` and `authPath`; omitted paths use the existing `PI_ORCHESTRATOR_*` environment and config defaults. An explicit ledger path also supplies the default sibling auth path when neither environment nor config specifies authentication. No new credential store is created for the service. Invalid configuration or an incompatible ledger prevents construction.

Use one service per supervisor. `close()` refuses new calls, aborts active requests, waits for their lease cleanup, then closes the owned ledger. It is idempotent. The caller must also await its own artifact-publication and job-state work before closing its database. The service owns only generation, not consumers of its returned promises. It starts no timers while idle.

The extension borrows its existing `{ store, shared }` through the same factory. Closing a borrowed service leaves that store open. Its shutdown handler runs before routing closes the store. Callers already owning these dependencies can also call exported `generateImageWithSharedAccount(input, { store, shared, signal?, cwd? })` directly, provided they drain calls before closing the store.

## Input and result

`SharedImageInput` accepts `prompt`, `inputPaths`, `model`, `quality` and `size`. The supported values are exported as `IMAGE_MODELS`, `IMAGE_QUALITIES` and `IMAGE_SIZES`. Defaults and limits match the native tool. Empty `inputPaths` means generation; nonempty paths mean editing. Relative paths resolve against `cwd`, defaulting to `process.cwd()`. PNG, JPEG and WebP inputs share the 32 MiB limit.

`SharedImageResult` is a discriminated union:

- Success has `ok: true`, `images: Array<{ id: string; bytes: Buffer }>`, `model`, `responseId` and `usage: unknown`. Images retain provider order and call IDs. The last image is the final preview. Usage is the provider's unmodified report.
- Failure has `ok: false` and `error` with `kind` and `message`. Kinds are `invalid-input`, `unavailable`, `authentication`, `storage`, `closed`, `http`, `protocol`, `cancelled` and `transport`. HTTP failures retain `status` and optional `retryAfterMs`.

Each request has a five-minute deadline spanning input loading, authentication and generation, combined with caller cancellation and service shutdown. Selection and lease creation are transactional. The service heartbeats the lease every 30 seconds and aborts if that heartbeat fails. HTTP 429 cools the selected account. Provider failures never trigger another request or account switch.

Remote owns durable job acceptance, dependencies, recovery, artifact publication and state transitions. A process loss can leave an expired lease and an interrupted provider request. It cannot recover image bytes from the response ID because requests use `store: false`; recovery must not silently submit another paid generation.

## Checks

```sh
npm test --workspace=pi-orchestrator -- --run tests/image-service.test.ts tests/image-generation.test.ts tests/routing-runtime.test.ts
npm run typecheck --workspace=pi-orchestrator
```

These checks use local fixtures and mocked provider responses. They cover public API imports, configured shared authentication, edit input loading, raw output ownership, concurrent shutdown, credential cancellation, heartbeat failure, personal authentication and tool publication.
