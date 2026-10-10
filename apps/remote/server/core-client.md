# Remote's core gateway

Remote owns UI projections, media transport and private resource custody. The shared core owns ThreadService, native execution, accepted messages, manager identity, manager notice routing and generated images. Remote never opens or reinitializes `threads.sqlite3`; existing native JSONL and owner-scoped state stay authoritative.

The host supplies all configuration together:

- `PI_CORE_URL`: the logical HTTP origin used by the canonical API.
- `PI_CORE_SCOPE_ID` and `PI_CORE_PRINCIPAL_ID`: the exact registered owner scope and principal.
- `PI_CORE_GATEWAY_ID`: the registered forward binding, selecting `/run/pi-stack/gateways/ID.sock`.
- `PI_CORE_CALLBACK_UID`: the explicit core Unix UID. It is the expected server peer for forward requests and the admitted client peer for callbacks.
- `PI_CORE_CALLBACK_SOCKET`: exactly `/run/pi-stack/gateways/remote-SCOPE/callback.sock`.

The core verifies Remote's Unix peer against the configured gateway principal, scopes and operation ceiling. Remote verifies the core server's kernel peer before sending bytes. Native `x-pi-thread-token` capabilities remain narrower than the gateway; actor headers and bearer credentials do not supply authority.

The host prepares the root-owned `0755` gateway parent and the Remote-UID-owned `0755` scoped callback directory. Remote owns a `0600` callback socket and its exclusive owner lock. Recovery removes only an affirmatively refused, unchanged socket under the same custody. Shutdown drains accepted callback work before releasing the lock or closing presentation storage.

Callbacks are limited to POST message preparation and six account-bound manager relay operations: notification policy, work summary, send, question origin, question custody and manager replies. Public HTTP cannot invoke callbacks. The exact message/receipt envelope survives relay and restart; an unavailable callback does not authorize a second controller or a fresh action identity.

Projection recovery installs the core's atomic cursor/live snapshot, preserves selected archived entries and discards buffered events already included in that cursor. Native history is never replaced by the disposable projection. Image ingress and phone reply display retain durable adapter outboxes; execution and generation continue in core while Remote is offline.
