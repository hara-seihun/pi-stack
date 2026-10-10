# Principal-separated shared core

One core process on each host owns provider custody and the registered thread partitions. A person receives a credential bound to one registered principal, explicit resource grants and explicit scopes. A broker grant permits inference; it never grants provider administration or another person's transcripts.

## Caller configuration

```text
PI_CORE_URL=http://127.0.0.1:PORT
PI_CORE_TOKEN_FILE=/absolute/private/token-file
PI_CORE_SCOPE_ID=registered-scope-id
```

Clients read the token file into `Authorization: Bearer …`. Credentials never travel in command arguments. Core verifies a root-owned digest binding, not a caller-supplied identity. Each resource operation then passes the shared permission policy.

- Tool-free inference: `/v1/model-broker/v1/completions/REQUEST_ID`, including `/cancel`, `/retry` and `/attempts`.
- Streaming Codex inference: `/v1/model-broker/backend-api/codex/responses`.
- Streaming Anthropic inference: `/v1/model-broker/v1/messages`.
- Principal-local account/meter/spending projection: `/v1/model-broker/v1/usage`.
- Registered thread owner: `/v1/scopes/SCOPE_ID/thread-owner`.
- Operator account/meter projections and controls: `/v1/providers`; separate read/write authorization is required.

Native threads receive their scoped callback URL and capability from their admitted owner. UID, mount namespace, exact session file, credential custody and explicit permissions remain bound to that scope. Root and the host administrator retain their actual administrative access; an ordinary principal's core credential does not convey it.

## Provider grants

Each original root-owned broker configuration declares its principal's permitted account aliases, exact canonical models and request limit. Core retains each configuration's original grant owner and exact per-ledger publication footprint; it does not publish every listener to every ledger. Account/model grant changes reach admission through the retained ledger. A queued request is admitted on current terms, while exact replay retrieves its original receipt without submitting another request. Shared account eligibility also respects enabled state, calling-account exclusions, entitlement, quotas, cooldowns and explicit stops.

The existing routing extension uses the explicitly configured broker endpoint before opening shared account state. Canonical provider/model selections route through that endpoint; numbered account selections resolve to their canonical provider family. Local account-transfer commands are operations for the actual credential custodian, not a grant to ordinary callers.

## Existing callers and accepted work

Existing UID-bound loopback broker listeners retain their original grants during finite adoption in the same core process. Native callers explicitly select `PI_MODEL_BROKER_URL=http://127.0.0.1:PORT`, validated against the original principal/port/UID binding. A root-owned receipt proves old accepted streams drained before ports move. Live nft output UID and input loopback gates plus unified use policy are checked before each request. Proof follows the exact terminal port rejects and their preceding paths: prior rules must reject without mutation or have a guard proved disjoint from forbidden traffic before any effect. Later Converge confinement accepts, marks, conntrack and socket rules cannot bypass an earlier terminal reject. An earlier relevant accept/jump/return, mutation or unknown path is refused. They do not become broader administrative transports. Before switching a completion caller, core binds every original public ID and stored ID to the verified principal and original ledger owner. The retained ledger's detached-owner receipt binds its path and inode, and its lifetime lock prevents a second admission owner. When an alias cannot be proved, explicitly granted original callers retain owner-indexed stored-ID routes instead; ordinary broker users cannot select arbitrary owners.

No adoption step copies databases, replaces run IDs, reinitializes an unavailable partition, resets provider claims or retries uncertain effects. Core serves the same attempt receipts and native session history. [Completion custody](completions.md) defines the trusted alias registry and historical-settings replay contract.

## Fresh personal listeners

A new OIDC person receives their own principal, distinct loopback port and original enrollment account/model ceiling. Core owns the listener alongside the existing shared provider Store/controller; enrollment does not create a per-person engine or borrow an existing person's endpoint.

Configured provider `freshListeners` is explicit (empty before any new admission). Each entry is `{configPath, admissionReceiptPath, binding}`; its config path must also appear in `configPaths` with `grantFootprints` exactly `ledgerOwnerIds: ["current"]`. The source has one personal listener and an explicit original publication owner. No other source may contain the fresh principal, and all ports remain unique.

[`FreshBrokerAdmissionReceipt`](../src/core/fresh-broker-transports.ts) records `version: 1`, `kind: "fresh-listener"`, `priorOwner: {kind: "none"}`, exact config path/raw-byte SHA256, full binding, full grant footprint and the root-owned registration provenance below. The immutable enrollment template has `nativeModelAdmission.kind: "fresh"`, exact personal principal/UID/port/config-path placeholders, full shared-ledger `brokerConfig`, full host `binding` and exact publication footprint. Its concrete account aliases/models/request limit are original company enrollment policy, not selected from another person's grant. The rendered registration plan must match every field, and the admitted source's bytes and parsed configuration must agree.

Fresh admission is separate from old-stream drain evidence. Registration proof precedes Store adoption/publication; current nft UID/input proof precedes listener startup and every request, and unified model use permission remains required. A conflicting live port is an error, not authority to kill its owner. Updating the source later requires its explicit owning admission evidence; startup does not reinterpret a changed source as the original birth configuration.

## Enrollment evidence

A UID-bound transport declares `admissionDeltaPaths: []` when no later account has been admitted. Later enrollment appends a finite ordered chain of root-owned delta paths; it never replaces the original drained-stream receipt. [`BrokerAdmissionDelta`](../src/core/broker-transports.ts) defines the record:

```text
version: 1
priorBindingsSha256, nextBindingsSha256, nextBindings
registration: {templatePath, templateSha256, registrationId, requestId,
               principalId, uid, admittedAt, planPath}
```

Binding hashes are SHA256 of `completionCanonical(bindings)` (object keys sorted, array order retained). The delta's template digest hashes exact file bytes; its root-owned registration plan also binds the semantic template hash, issuer/subject identity hash, stable registration/request IDs, exact person/UID and original native listener tuple. Evidence files must be bounded root-owned regular files without group/other write; final symlinks are refused. Keep referenced template bytes immutable when rotating the current enrollment template.

Each delta may add only the newly registered UID to the exact existing principal/owner-UID/port named by the template. It cannot remove UIDs, alter original transport identity, add a port or widen another listener. Prior/next links, unique registrations and ordered admission times are checked; configured bindings must exactly equal the chain tip. This proves host admission only: source listener ceilings, live nft identity and unified resource permission still apply on every request.

Broker cache keys and affinity headers are namespaced by the verified principal. Account labels are replaced by aliases in caller usage projections. Personal spending is aggregated once across declared retained ledgers at their original frozen rates. Response headers never expose provider authentication or cookies.
