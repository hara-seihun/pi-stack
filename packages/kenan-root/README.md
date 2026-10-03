# Root Kenan runtime

`pi-kenan` is a separate nonadministrator execution account. Ordinary person supervisors, Unix identities and visible traces remain unchanged. Enable only through the [additive cutover owner](../../docs/one-kenan-deployment.md), never ordinary publication.

## Admission and outgoing replies

`POST /v1/ask` accepts only `{request:string}` and the minted person's `x-kenan-memory-session` capability. The memory service authenticates person/thread and, for rooms, the current full roster. Each consultation starts a fresh native session with host-owned model, prompt and exact toolset. Requests cannot select those resources or claim identity. `root_reply` chooses the sole outgoing text; exact disclosure accounting must acknowledge before `{reply}` returns. Native histories live outside every ordinary ThreadDirectory. [Separate admin admission](src/visibility.ts) protects list/transcript debugging.

Root configuration is `PI_KENAN_ROOT_CONFIG` (default `/etc/pi-stack/kenan-root.json`), root-owned and not group/world writable. Required fields are version/provider/model/thinkingLevel/cwd/agentDir/sessionsDir/promptFile/brokerUrl. Root HTTP is loopback `PI_KENAN_ROOT_PORT`, default 18821; memory is `PI_KENAN_MEMORY_URL`, default loopback18820. Provider traffic uses the explicit host model broker. Startup waits for the real encrypted `PI_KENAN_PRIVATE_DIR` gocryptfs mount; no plaintext fallback is opened.

Systemd credentials `kenan-memory-root`, `kenan-root-admin`, `kenan-root-consent` have distinct authority. Explicit file overrides are `PI_KENAN_MEMORY_ROOT_TOKEN_FILE`, `PI_KENAN_ROOT_ADMIN_CAPABILITY_FILE`, `PI_KENAN_ROOT_CONSENT_TOKEN_FILE`. Never pass their values as arguments or put them in transcript text.

## Async subject consent

`root_request_consent({subject,question})` creates a durable private exchange. It stamps the authenticated requester and full reply audience, logs the exact question, then calls the router's narrow `/v1/root-consent/question` bridge. The subject receives a new visible permission-inbox thread and the existing asynchronous question UI. Only its acknowledged receipt means **asked**. Unknown subjects and delivery failures return errors, not pretend progress.

The root-only router bridge authenticates `x-pi-kenan-consent`, dynamically reads the host flag and separate capability, and exposes only question delivery, exact correlated question-answer lookup, and chosen reply delivery. Browser credentials and admin-debug tokens confer none of this authority. The router calls each person's existing supervisor as the already-trusted router; no personal firewall gate is widened.

The foreground root daemon reconciles encrypted `PI_KENAN_ROOT_CONSENT_STORE` (default `private/root/consent.sqlite3`) every two seconds. Its outbox stores no memory token. Human answers are read from the owning ThreadService's durable `questionState` receipt, checked against the exact question, and logged to the private root channel—not to the requester. Root-only memory resumption retains the original authenticated person/thread/audience and supplies a fresh root memory capability. A fresh fixed root session judges the actual answer and its scope. Its chosen reply is logged before stable-id delivery into the original thread; no raw subject answer or root trace is relayed. Notifications honor a held thread rather than forcing it to resume.

All boundary operations have stable identities. Interrupted delivery and lost acknowledgements replay the same question/message, not new ones. Completed root decisions are persisted before delivery and never rerun. Pending exchanges survive root executor release and daemon restart. Disabling the flag stops reconciliation; rollback preserves encrypted pending state.

## Proofs

- `bun test packages/kenan-root/tests`: fixed resources, reply boundary/admin isolation, real memory + real subject ThreadService consent, restart, lost ACK, forged capability and failed-delivery honesty.
- `deploy/one-kenan-fuse-rehearse`: bounded privileged real FUSE fixture, not live mounts or real keys.
- Integrator native staging exercises actual host-catalog Sol/Opus sessions and the complete consent path.
