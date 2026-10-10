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

The root-owned broker configuration declares each principal's permitted account aliases, exact canonical models and request limit. Account/model grant changes reach admission through the retained ledger. A queued request is admitted on current terms, while exact replay retrieves its original receipt without submitting another request. Shared account eligibility also respects enabled state, calling-account exclusions, entitlement, quotas, cooldowns and explicit stops.

The existing routing extension uses the explicitly configured broker endpoint before opening shared account state. Canonical provider/model selections route through that endpoint; numbered account selections resolve to their canonical provider family. Local account-transfer commands are operations for the actual credential custodian, not a grant to ordinary callers.

## Existing callers and accepted work

Existing UID-bound loopback broker listeners retain their original grants during finite adoption. They do not become broader administrative transports. Before switching a completion caller, core binds every original public ID and stored ID to the verified principal and original ledger owner. The retained ledger's detached-owner receipt binds its path and inode, and its lifetime lock prevents a second admission owner.

No adoption step copies databases, replaces run IDs, reinitializes an unavailable partition, resets provider claims or retries uncertain effects. Core serves the same attempt receipts and native session history. [Completion custody](completions.md) defines the trusted alias registry and historical-settings replay contract.

Broker cache keys and affinity headers are namespaced by the verified principal. Account labels are replaced by aliases in caller usage projections. Personal spending is aggregated once across declared retained ledgers at their original frozen rates. Response headers never expose provider authentication or cookies.
