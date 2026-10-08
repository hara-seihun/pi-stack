# Life model — slice 1

The life owner carries a person's goals, commitments, decisions and preferences. **Personal needs in Attention are a projection, not another task queue:** work Kenan can do stays with Kenan. Financial forecasting, automatic source learning and protected-skill/coaching options are later slices.

## Custody and authority

`packages/kenan-memory/src/life-contract.ts` owns the shared schemas; `life-store.ts` owns versioned aggregate storage and `life-client.ts` owns the authenticated transport. Life rows are stored in the existing encrypted memory SQLite database. Each subject has a separate authenticated/encrypted row namespace. Ordinary callers can access only their authenticated person, not a claimed identifier. Root's aggregate uses `root:kenan` and owns shared-resource work, not private copies of all people's lives. Privileged admitted root sessions can consult a subject's policy privately; ordinary room sessions have no direct life access. Root's chosen reply still passes the existing full-audience disclosure boundary.

The versioned encrypted policy is the **one authority owner** for delegation, financial discretion, steering visibility, excluded sources, disclosure, consent and review dates. Other people receive an explicitly established conservative initial policy on first authenticated access and can change it through their own agent. Root policy is provisioned separately by the host owner. No personal calibration belongs in source, fixtures, public documentation or commits.

Full-context agent threads, watch checks and root read current policy each turn. Policy errors do not imply expanded standing authority. Revocation, unknown inputs and exclusions remain real states; inferred preferences cannot enlarge delegation. Raw and sandbox execution deliberately carry no private standing authority or life tools. Changes to policy affect subsequent turns; an already executing irreversible action must be stopped through its own owner.

Authority guidance is not a new bypass around a tool's explicit confirmation, credential or ownership contract. Spending that depends on a fresh complete forecast remains unavailable when that forecast is missing: slice 1 does not silently fabricate the deferred financial engine. Precise light consent-override scope must be stated in the person's policy, not guessed from preference strength.

## Agent operations

- `life_read`: current own aggregate (goals, commitments, needs-you, preferences and source coverage).
- `life_write`: typed entity create/revise/retract and source-coverage reconciliation; writes require the observed revision. History retains superseded and retracted claims.
- `life_policy`: inspect current/history or replace policy with compare-and-swap revision.
- `life_steering`: query or record steering, including policy revision, rationale, evidence, visibility, effect state and outcome/receipt.

`POST /v1/life` uses the same verified session/supervisor identity as memory. Ordinary tools use `target:{scope:"self"}`. Root must choose `target:{scope:"root"}` for its own aggregate or explicit `target:{scope:"person",person:...}` for a subject's private policy. Room and journal-publisher credentials cannot become personal life authority.

Provenance separates stated, revealed, derived and hypothesis claims, nullable confidence, evidence/counterevidence, observation/validity times and supersession. Unknown deadlines and recommendations are null, not inferred values. Following an agent recommendation is agent-exposed evidence, not independent confirmation of a preference.

A reconciliation records which sources were actually inspected, their checked/reconciled time, freshness boundary and complete/partial/inaccessible/excluded state. Reading the aggregate, scheduling a watch or ending a turn does not advance reconciliation. If supporting evidence is removed or stopped, dependent projections must not present it as current authority.

## Attention projection

Open [**Attention**](../apps/remote/docs/attention.md) from Remote's main navigation (`#/attention`). Its [personal projection](../apps/remote/docs/needs-you.md) combines open person-only life items and waiting personal commitments with pending questions from the existing question owner. Undated/due items appear in Now; future deadlines interleave with calendar events in Upcoming. Active updates join Now and resolved notifications remain in History. Linked question notifications appear once; answers stay in the original question owner's conversation and store.

Personal items show consequence, deadline and timezone, recommendation and honest unknowns. Sources load independently and retain last data with visible errors/staleness. Coverage and delegation expands source reconciliation receipts, watch coverage and the read-only standing policy; watch state is not a list of human tasks. Refreshing the surface does not reconcile sources or grant authority. `#/needs-you`, `#/notifications` and `#/calendar` resolve to Attention.

The projection is local to the authenticated account/host. It does not merge a work account and a personal account merely because the Unix names match. Source owners still decide when work is complete; a draft, a scheduled check and an accepted decision are different things.

## Read-only one-time import

The importer reads a chosen Markdown todo source, takes unchecked open items into commitments and a nominated `Needs NAME` section into linked person-only items. It records file/line provenance and a content fingerprint, leaves the file unchanged, and retains a one-time import receipt so rerunning cannot reopen subsequently corrected or resolved work. This is migration, not ongoing bidirectional synchronization. A legacy unchecked box is source-backed outstanding work, not proof that its deadline or current circumstances were reconciled.

Run `bun scripts/life-import.ts --source /absolute/file --needs-heading 'Needs NAME'` using the current memory-session capability or verified local supervisor identity; there is no identity override flag. The nominated level-two heading must match exactly, including any parenthetical text; a missing heading returns an error and does not seal an empty import. The generic CLI and fixture tests live in `scripts/life-import.ts` and its accompanying test. Hosts run imports only within their own authorized encrypted personal context. A work-only host must not receive a personal source file or calibration.

## Release and host activation

Ordinary publication delivers Remote/runtime source to the configured hosts. Memory and root are separately activated consumers: follow [One-Kenan consumer activation](one-kenan-deployment.md#explicit-consumer-release-activation) after source publication, and use its live revision proof. Do not infer activation from selected symlinks. A host without `oneKenan:true` or unlocked encrypted custody reports the life service unavailable rather than showing an empty healthy model. For slice 1, a work-only deployment may deliberately keep the feature disabled until its owning person-network ingress and boot configuration support the existing encrypted root/memory substrate; staged source is not an enabled feature.

For first deployment, seed the person's private calibration and root's shared-resource policy into the encrypted owner before replacing any older host prompt containing standing grants. Remove those grants from the host prompt after custody is established; source guidance must point to policy, not duplicate it. Keep host-specific work scope and machine boundaries in host configuration. The host handbook records the activation and migration receipt, never private policy values.

## Next slice

Add an event/deadline-driven reconciliation owner using existing questions, watch scheduling and durable execution; propagate source corrections and revocations to dependent claims. Add bounded calendar/source adapters with explicit coverage and an inspectable financial snapshot/forecast completeness contract. Significant model-based financial discretion becomes usable only when those inputs exist. Automatic preference learning and protected-skill options remain separately authorized work.
