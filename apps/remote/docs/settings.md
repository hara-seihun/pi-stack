# Settings

Remote's `#/settings` is the settings area. Machine reports usage and measured host state. The thread inspector links to Settings rather than owning a second editor. Attention retains calendar events; subscriptions, feed access and timezone configuration live in Settings.

[`shared/settings.ts`](../shared/settings.ts) is the typed registry: stable ID, person/system scope, kind, validation, owning component, executable/location and activation semantics. The frontend and [`server/settings-store.ts`](../server/settings-store.ts) use those definitions. `GET /v1/settings` returns registered entries as set, unset or unavailable. `PUT /v1/settings/:id` accepts exactly `{value}`. Unknown IDs, wrong types, owner-managed writes and unauthorized administration return explicit error codes. There is no arbitrary JSON/configuration editor.

## Ownership and authority

The supervisor reads/writes only its own person's data. Ordinary accounts never receive system definitions or system owning adapters and cannot write system settings. The host's configured `fleetUser` is the administrator; unavailable host identity grants no administrator rights. API calls travel through the existing authenticated router/person-service boundary, not a second settings service.

Personal timezone and auto-collapse belong to `$PI_REMOTE_DATA/settings.json`, with schema version 1 and mode `0600` in the owner's state directory. Unset fields are explicit `null`. Existing per-device auto-collapse choices migrate only when the person preference is unset, then the previous local value is removed. Thread model/thinking/speed/timeout choices remain in ThreadService; Settings uses its existing GET/PUT API. Model availability remains in its existing policy file. Machine action switches reconcile through their configured status/on/off commands and report the confirmed result. No adapter copies an owner's value into another settings database.

The Android phone enabled state and overlay visibility remain in the native owning bridge. Android permission grants are separate observations/actions: enabling phone control does not grant permissions or require every grant. A permission request rechecks actual Android status after returning, and an identity change invalidates its result. Notifications, app updates, speech playback and account/environment selection use their existing client/native owners. Calendar subscriptions and feed access use the own-person CalendarStore API.

## Timezone

[`packages/orchestrator/src/person-settings.ts`](../../../packages/orchestrator/src/person-settings.ts) provides `readPersonTimezone(dataDir): SettingsResult<PersonTimezone | null>`. The browser-safe contract export is `pi-orchestrator/person-settings-contract`; the reader is exported by `pi-orchestrator/api`. A timezone record contains an IANA `zone`, `source: configured | client-observed`, and server-written `observedAt`. Fixed-offset labels are rejected. No timezone is inferred from host time or invented as UTC.

Authenticated app bootstrap observes the client's actual `Intl.DateTimeFormat().resolvedOptions().timeZone`. A configured selection always wins over observations. Observations remain valid until replaced by a later actual observation; there is no fabricated expiry fallback. Clearing a selection sets it to null; a later client observation can establish it again. Message-delivery consumers receive a trusted owning settings path from their launcher; a read failure is distinct from an unconfigured timezone.

CalendarStore migrates an existing explicit calendar timezone as `configured`, preserving it before removing the duplicate calendar settings row. The calendar timezone API writes this same person store. Failed migration retains its source row and becomes a supervisor owner error. Calendar responses expose timezone-read failures rather than silently inventing a zone. Individual events and subscriptions retain their own explicit zones.

## Host-managed inventory

The registry inventories account/grant/weekly-limit configuration, host topology, catalog/provider routing and capacity, destinations/workspaces, execution/lifecycle, router/login/private-network, phone/call/overlay services, voice/speech/external meeting services, memory/custody/rooms/journal, update artifacts, publication/build declarations and feature-service environment configuration. Per-person agent packages/models/instructions, own browser profiles and life policy are also indexed by owner.

Only adapters with an actual browser write/read path are editable. Other entries explicitly say browser editing is unavailable and display the owning file/API/tool and its activation action. They do not claim their values are unset, pretend to save, reveal secrets or create a competing configuration framework. Host-only configuration still needs the named owner operation/reconciliation; a Settings UI visit does not activate a host change.

## Activation and focused proof

This source activates with the combined Remote/Orchestrator/web/Android publication. `data-contract.json` requires a person-settings-aware consumer, so activation failure cannot select an older Remote that would recreate a separate calendar timezone owner. The parent publication owns both-host delivery; a source commit is not activation. Focused contracts cover ordinary-account system isolation, invalid/corrupt settings, configured-over-observed provenance, existing calendar migration, independent person stores, native grant return/recheck and confirmed owner actions. Full compiler/build checks belong to the publication worker.
