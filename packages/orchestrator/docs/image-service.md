# Shared image generation API

`pi-orchestrator/image-service` exports `createSharedImageGenerationService` for long-running callers such as AI Animation and the Pi Remote supervisor. The existing `pi-orchestrator/api` export remains available. The service uses the same shared OAuth lock, input loader, interactive leases and provider request as the [native image tool](image-generation.md). It does not load personal credentials, create image files, store jobs or retry requests.

```ts
import { createSharedImageGenerationService } from "pi-orchestrator/image-service";

const images = createSharedImageGenerationService();
const result = await images.generateImageWithSharedAccount({
  prompt: "A blue circle",
  inputPaths: [],
  model: "gpt-image-2.5-flare",
}, { signal, cwd, accountSelection: "spread" });

if (result.ok) {
  // Persist every image before marking the caller's job complete.
  for (const image of result.images) await persist(image.id, image.bytes);
  await complete(result.accountId, result.model, result.responseId, result.usage);
} else {
  await fail(result.error.kind, result.error.message);
}

await images.close();
```

The factory is synchronous and opens its own ledger connection. Options are `configPath`, `ledgerPath` and `authPath`; omitted paths use the existing `PI_ORCHESTRATOR_*` environment and config defaults. An explicit ledger path also supplies the default sibling auth path when neither environment nor config specifies authentication. No new credential store is created for the service. Invalid configuration or an incompatible ledger prevents construction.

Use one service per supervisor. `close()` refuses new calls, aborts active requests, waits for their lease cleanup, then closes the owned ledger. It is idempotent. The caller must also await its own artifact-publication and job-state work before closing its database. The service owns only generation, not consumers of its returned promises. It starts no timers while idle.

The extension borrows its existing `{ store, shared }` through the same factory. Closing a borrowed service leaves that store open. Its shutdown handler runs before routing closes the store. Callers already owning these dependencies can also call exported `generateImageWithSharedAccount(input, { store, shared, signal?, cwd?, accountSelection? })` directly, provided they drain calls before closing the store.

## Account selection

Per-call `ImageGenerationOptions` is `{ signal?: AbortSignal; cwd?: string; accountSelection?: "spread" }`. Omit `accountSelection` to retain spent-first interactive selection. The native tool and other existing callers do not opt in automatically.

`"spread"` selects the eligible account with the fewest active image leases, including images started by callers using the default selection. Equal loads rotate by account ID after the previous spread selection, wrapping at the end. The cursor lives in the shared ledger's `control` table under `image-account-spread-cursor`, so separate service instances and processes share rotation. Selection, lease creation and cursor advancement commit in one immediate transaction. An admitted attempt advances rotation even if authentication or generation later fails.

Eligibility is unchanged: an enabled shared OpenAI Codex account with shared OAuth credentials, no active cooldown and no reservation. Spread does not rank by quota spent or non-image workload. It counts only `interactive:image:` interactive leases that are unended and heartbeated within the existing two-minute lease window. It does not add a concurrency cap or combine pools from different host ledgers.

## Input and result

`SharedImageInput` accepts `prompt`, `inputPaths`, `model`, `quality` and `size`. The supported values are exported as `IMAGE_MODELS`, `IMAGE_QUALITIES` and `IMAGE_SIZES`. Defaults and limits match the native tool. Empty `inputPaths` means generation; nonempty paths mean editing. Relative paths resolve against `cwd`, defaulting to `process.cwd()`. PNG, JPEG and WebP inputs share the 32 MiB limit.

`SharedImageResult` is a discriminated union:

- Success has `ok: true`, `accountId: string`, `images: Array<{ id: string; bytes: Buffer }>`, `model`, `responseId` and `usage: unknown`. `accountId` is the nonsecret ledger alias, not an OAuth token, email or provider account header. It is returned for both selection policies so callers can retain it in receipts. Images retain provider order and call IDs. The last image is the final preview. Usage is the provider's unmodified report.
- Failure has `ok: false` and `error` with `kind` and `message`. Kinds are `invalid-input`, `unavailable`, `authentication`, `storage`, `closed`, `http`, `protocol`, `cancelled` and `transport`. HTTP failures retain `status` and optional `retryAfterMs`.

Each request has a five-minute deadline spanning input loading, authentication and generation, combined with caller cancellation and service shutdown. Selection and lease creation are transactional. The service heartbeats the lease every 30 seconds and aborts if that heartbeat fails. HTTP 429 cools the selected account. Provider failures never trigger another request or account switch.

Remote owns durable job acceptance, dependencies, recovery, artifact publication and state transitions. A process loss can leave an expired lease and an interrupted provider request. It cannot recover image bytes from the response ID because requests use `store: false`; recovery must not silently submit another paid generation.

## Checks

```sh
npm test --workspace=pi-orchestrator -- --run tests/image-service.test.ts tests/image-generation.test.ts tests/routing-runtime.test.ts
npm run typecheck --workspace=pi-orchestrator
```

These checks use local fixtures and mocked provider responses, with no paid provider calls. The focused `tests/image-service.test.ts` suite covers spreading, eligibility, shared rotation, unchanged default selection, account receipts, configured authentication, edit input loading and lease cleanup. The other suites cover personal authentication and tool publication.
