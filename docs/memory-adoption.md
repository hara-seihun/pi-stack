# Markdown memory cutover

The executable is `bun scripts/memory-adopt.ts --plan /absolute/root-owned/plan.json`. Run in the source owner's authorized private custody namespace, not an ordinary person's transparent thread. Plans are canonical regular files owned by root and not group/world writable. No credential values, decryption keys or policy text are printed.

Create **one plan per subject**; never combine biographies into a household owning note. Copy the actual registered principal, source/destination resource descriptors and their existing authorized policy into this shape. The empty policy below grants nothing; this template does not issue authority.

```json
{
  "source": {
    "path": "/ABSOLUTE/ADOPTED/SOURCE.sqlite3",
    "format": "memory",
    "selection": { "kind": "person", "person": "SUBJECT" },
    "resource": {
      "id": "EXISTING_SOURCE_RESOURCE",
      "kind": "data",
      "owner": "EXISTING_SOURCE_CUSTODIAN",
      "privacy": "confidential",
      "subjects": ["SUBJECT"],
      "consent": "not-required"
    }
  },
  "destination": {
    "path": "/ABSOLUTE/OWNER/memory",
    "resource": {
      "id": "EXISTING_FOLDER_RESOURCE",
      "kind": "memory",
      "owner": "SUBJECT",
      "privacy": "confidential",
      "subjects": ["SUBJECT"],
      "consent": "not-required"
    }
  },
  "principal": { "kind": "service", "id": "REGISTERED_ADOPTION_PRINCIPAL" },
  "policy": { "revision": 1, "grants": [], "consents": [] }
}
```

Resource privacy, subjects and consent above are structural placeholders, not permission to weaken or redefine the registered source. The actual policy must permit source read and destination write, including applicable consent. Destination owner equals selected subject. Retain original restricted databases, keys and all effect/disclosure/consent/session custody.

## Snapshot and final writer transfer

1. An optional preliminary run returns metadata `{fingerprint, records, created, receipt, currentHead}`. `currentHead` is null or `{source, subject, revision, sha256}`. Keep this receipt in migration custody; it contains no authority content.
2. Drain and detach the original source writer using its owning host transfer procedure. Keep it detached through final adoption and core activation. A preliminary snapshot taken while writes were possible is not a cutover receipt.
3. Run the same per-subject plan against the final source. If the current policy advanced since preliminary adoption, add `expectedAuthority` with **exactly the preliminary `currentHead` object**, then rerun. The command compares source/subject/revision/digest and exact rendered provenance, replacing only that prior adopted head with a newer actual source head. Unrelated notes, hand edits, revision regressions or missing expected heads fail without blessing a stale authority.
4. Return only the final folder path, source/resource/custody identifiers, fingerprint, receipt filename and current-head metadata to deployment. Register `PI_KENAN_MEMORY_FOLDER`, folder resources and `memory.markdownOwners` in the owning authenticated scopes. No private note contents cross back to ordinary workers.

Every selected encrypted life version is decrypted inside authorized custody and preserved as an exact provenance record, including policy/steering history, retractions, coverage and imports. Only the actual current selected policy becomes `authority.md`; expired/revoked/unavailable authority grants none. Person memory/disclosure selection is exclusively tagged; mixed/shared records and private consultation captures stay in their original restricted journal. Stopped/retracted/history records are not active work links. Adoption does not run calendar refresh, resume campaigns or replay actions.

## Runtime configuration

Each trusted `markdownOwners` entry is `{subject,custodyScopeId,folder,resource}` with exactly that subject in the private memory resource. `projectionMaintenancePrincipalId` names an explicitly registered service with exact folder `read` and `invalidate` grants; use null only with no owners. A custody mapping is not a disclosure grant. The existing root signing credential authenticates pending forget fences but is never copied to notes.

Locked personal scopes remain unavailable descriptors with no folder access. Available owners keep serving. Unlock and reload core configuration to adopt a newly available folder/dataset; pending native correction IDs and signed fences are reconciled before active use. The owning registered host configuration preserves the live shared-custody stop.

[Memory owner](../packages/kenan-memory/README.md) describes the folder contract, service, calendar data and forgetting. [Source implementation](../packages/kenan-memory/src/adoption.ts) defines the exact plan/result types.
