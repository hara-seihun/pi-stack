# Needs you

The main navigation's **Needs you** screen is a read-only, own-person projection at `GET /v1/needs-you`. It combines current open life decisions/person-only actions, person-owned waiting commitments and pending asynchronous questions from all of the person's authorized thread owners, including archived threads. It does not list Kenan-owned commitments, ordinary attention notices or watch conditions as human tasks.

The owning supervisor authenticates the caller through its existing router/local caller boundary. It uses `kenan-memory/life-client` with its own supervisor credential and a fixed `target: {scope: "self"}`; caller-supplied person/scope parameters are rejected. Rooms cannot read this projection. The endpoint creates no model calls or mutations.

Every item shows its consequence, required-by timestamp with timezone, and Kenan recommendation. Missing values are explicitly unknown. A life decision linked to a pending question enriches that question instead of making another inbox entry. Answers remain in the original question owner's durable store. Links identify both the conversation and question, and the existing question composer puts the selected question first. An answered question is not revived by a lagging open life decision.

Coverage is separate from items. Life sources retain their actual check/reconciliation receipts and freshness deadlines; a GET only records when the view was read. Empty coverage, partial questions, stale receipts and unavailable owners stay visible. Watch coverage shows condition count and next scheduled due, with last actual check explicitly unknown because watch scheduling does not record a life reconciliation receipt. A next wake is not evidence of completed work.

The policy section reads the current own-person version without granting or editing authority. Corrections and revocation go through the person's Kenan and existing life policy owner. No second policy/answer/task store lives in Remote.

Owners: `server/needs-you.ts` derives the view, `shared/needs-you.ts` owns its wire contract, `web/src/needs-you.tsx` renders it. The life aggregate and its source receipts remain owned by `packages/kenan-memory`; questions and watches remain with the existing thread/watch owners.
