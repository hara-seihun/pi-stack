# JSON reconciliation

`reconcile.ts` is the state protocol shared by Remote's server and browser. It has no transport or domain dependency. Publish the complete JSON value for a resource whenever it changes. A client sends its known revision through a validated `have` map; the publisher returns either nothing, a full value, or a patch against that exact revision.

```ts
const revision = publisher.publish("thread/123", threadState);
const have = readReconcileHave(request.have);
if (!have) throw new Error("Invalid have map");
const frame = publisher.reconcile("thread/123", have["thread/123"] ?? null);
if (frame) send(frame);

const result = replica.apply(frame);
if (!result.ok) requestFullFrame(frame.resource); // reconcile(resource, null)
```

A full frame has `{resource, revision, base: null, kind: "full", value}`. A patch has `{resource, revision, base: string, kind: "patch", patch}`. The replica applies patches only when its stored revision equals `base`. It checks the resulting canonical JSON against `revision` before changing its state. A full frame can repair a missing or divergent replica. `get()` and successful `apply()` return separate JSON copies; mutating one cannot change a cached snapshot. `seed()` accepts a previously persisted snapshot only when its value matches its revision.

The patch tree handles replacements, string splices, object field additions/removals/edits, and array changes. Arrays of objects with unique stable `seq` or `id` fields use keyed order and selective item updates. This handles a rolling transcript window or directory reorder without retransmitting unchanged rows. Other arrays use positional edits and splices. A publisher sends a full frame when it is smaller than the patch or the requested base has left its history. Revisions are SHA-256 hashes of JSON normalized by `JSON.stringify` with sorted object keys; identical JSON content gets the same revision regardless of property order. Values must be JSON-serializable. The hash checks state consistency, not authentication.

`ReconcilePublisher` and `ReconcileReplica` accept `{maxEntries, maxBytes, maxValueBytes, maxHistoryPerResource}`. Defaults are 256 retained snapshots, 128 MiB total, 32 MiB per value, and four historical revisions per resource. Counts and bytes include retained publisher history; the cache evicts least recently used resources under pressure. Bytes count two per UTF-16 code unit, matching the stored JavaScript strings. `publish` and `seed` reject oversized or invalid values. The protocol validator rejects more than 256 resources, empty or excessive keys/revisions, and maps over 32 KiB. It creates a null-prototype map so resource names such as `__proto__` stay ordinary data.

`resource-cache.ts` owns the bounded access-ordered cache for this protocol and the browser's loaded resources. Its optional weighted entry count lets one publisher resource account for its current and historical snapshots without a second eviction implementation.

Shared modules also enter Orchestrator's NodeNext typecheck through the server protocol, so relative imports use `.js` extensions. `deploy/remote` ships the `shared` directory beside `server`; `scripts/deploy-remote.test.mjs` checks direct and transitive shared imports, including missing files on an unchanged redeploy.
