# Guarded write and exact append

`patch-file-write.mjs` owns the installed SDK, agent-core harness and bundled CLI file-tool contract. `deploy/runtime` hashes its guard and retained adopter into the immutable dependency closure and applies the patch before sealing. Source anchors are pinned and all transforms are prepared before any dependency bytes are written. Running the patch twice is idempotent. Never patch an installed closure.

## Write contract

`write` still creates missing files/parents and performs ordinary UTF-8 full rewrites in place. Inside the existing file-mutation queue, before truncation, it inspects the destination byte length. It returns `WRITE_DESTRUCTIVE_OVERWRITE_REFUSED` if an existing nonempty file would become blank (empty or whitespace-only) or lose **at least 4096 bytes and at least half its bytes**. Refusal leaves original bytes intact. New empty files and smaller ordinary rewrites remain valid.

A deliberate full rewrite supplies `overwrite: { expectedBytes: number, reason: string }`. The reason must be nonblank and the current destination length must equal `expectedBytes`; otherwise `WRITE_INVALID_OVERRIDE` or `WRITE_OVERRIDE_CONFLICT`. This binds explicit intent to the observed length, not a content hash or cross-process compare-and-swap. Independent writers remain independent; the existing per-process path queue is not an interprocess overwrite lock.

Custom SDK `WriteOperations` must supply `fileSize(path): Promise<Result<number | null, {code,message}>>`; `null` means missing. Missing inspection yields `WRITE_INSPECTION_UNSUPPORTED`, failed inspection yields `WRITE_INSPECTION_FAILED`, and neither calls `writeFile`. Harness tools inspect through their owning environment, including symlink targets. This guard protects the write tool, not shell commands or exact edit operations.

## Append contract

`append {path,content}` appends exactly the UTF-8 encoding of `content`; it never reads or replaces the prefix and never inserts a separator or newline. It creates missing files and parents. SDK default tools and exported factories, harness export and CLI default tool definitions expose append. Isolated contexts can explicitly opt into the available tool without expanding their grants. Dispatch-only managers remain dispatch-only.

SDK local append uses `fs.appendFile`/`O_APPEND`; harness append uses the existing environment `appendFile`. Custom SDK append operations must explicitly supply `appendFile`, or receive `APPEND_UNSUPPORTED`. Same-process same-path writes/edits/appends share the owning mutation queue; append calls complete in queue order. Separate processes append at the kernel-selected end without overwriting the prefix; very large or short-write-retried requests may interleave between individual kernel writes, so append is not a transactional cross-process record store.

Cancellation checks occur before effects and after each awaited inspection/directory/mutation operation. The queue remains held until an in-flight operation settles; no abort listener releases it early. As with existing write, cancellation/error after effect entry is not proof that bytes were unchanged and does not authorize blind retry.

## Retained local write tools

Disk publication protects newly loaded SDKs, not captured live tools. `resident-write-adoption.mjs` exports `adoptResidentLocalWrites({ protocol: "resident-local-write-v1", entries })`. Each entry is `{ kind:"local-write", id, operations, expectedWriteSha256 }`. The operator obtains the **actual lexical `ops` object** from captured `createWriteToolDefinition` execute closures, not reconstructed tools, and supplies an approved SHA256 of `Function.prototype.toString.call(ops.writeFile)`. Only exact verified local filesystem predecessor functions are admitted. Unsupported/custom/harness predecessors are an explicit operator refusal, not inferred local targets.

The adopter preflights every entry (plain nonproxy operation identity, own writable function, exact predecessor hash, unique target), checks all descriptors again, then replaces every method synchronously. A mismatch changes no target. It preserves the original function/receiver, queue, parent handling and old execute closure. Repeated adoption with the same predecessor is an explicit already-installed result. New tools sharing the same ops object inherit the guard. An operation already inside its original filesystem method retains that method; operator acceptance must distinguish that from future-call protection.

The old execute shape is `execute(toolCallId, {path,content}, signal?, onUpdate?, {cwd}?)`. To prove adoption, invoke the **captured old execute** with an absolute operator-created synthetic temporary path containing nonempty bytes, then `content:""` and a substantially smaller string. Both must reject with code `WRITE_DESTRUCTIVE_OVERWRITE_REFUSED`; read back only that synthetic file and compare its exact original bytes. Do not invoke a personal destination. Whole-owner census and cross-owner inspector custody are deployment-coordinator responsibilities. The adopter itself accesses no sessions, histories or personal contents.

Retained old schemas cannot expose `overwrite` or `append`. Guard adoption and supported tool-definition refresh are separate coverage claims. Old write calls stay protected, and deliberate truncation must use a refreshed tool. Never report retained append/override availability from a disk selector change alone.

## Focused proof

```
FILE_WRITE_NODE_MODULES=/absolute/frozen/node_modules node --test packages/runtime/file-write.test.mjs
node packages/runtime/file-write-probe.mjs /absolute/selected/node_modules
```

Tests copy only frozen public dependency packages into a disposable writable synthetic fixture; they do not mutate installed modules or production state. The selected-SDK probe imports actual tool definitions and exercises refusal/unchanged bytes, deliberate overwrite, ordinary/new files, newline-free and concurrent append, and pre-abort behavior exclusively in temporary synthetic files. Operators run it against each actual sealed and selected dependency directory. Captured old-tool acceptance remains separately required on owners retaining native sessions.
