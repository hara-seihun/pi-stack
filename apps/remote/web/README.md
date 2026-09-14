# Shared Remote client

Browser and native clients authenticate at the bootstrap router before discovering endpoints. The web client owns person selection, folder keys, router sessions, and endpoint selection.

## Native bridge

`KenanRemote.getState()` returns `{ routerUrl: string }`, the credential-free bootstrap URL. There is no native endpoint selection, preparation, or SSH setup.

`syncSession({ user, session })` replaces the native notification monitor's authorization. `session` is the opaque router token. Clearing auth sends `{ user: "", session: "" }` and stops monitoring. The monitor discovers allowed endpoints at bootstrap using this session. Every poll carries `x-pi-remote-session`; `x-pi-remote-user` is only a hint. A 423 response stops monitoring until the web client supplies renewed authorization. `notifications({ request })` checks or requests notification permission.

The haptic, keepAwake, notificationTarget, notificationThread, checkAppUpdate and installAppUpdate methods retain their existing roles. Notification targets contain person, endpoint ID and thread ID, never a credential.

## Router contract

Unauthenticated bootstrap `GET /v1/environment` supplies the person chooser. `fetchPersonChooser()` explicitly uses that route without a session, even while signed in. Ordinary authenticated environment requests use the selected endpoint. `POST /v1/unlock` sends `x-pi-remote-user` and `{ key }`; success supplies `{ ok: true, user, session }`. Persons without encrypted folders submit `{}` to mint a session. `GET /v1/environments` requires that session and supplies the authorized endpoint list. Endpoint `baseUrl` values are same-origin prefixes, with an empty prefix for local. Icons are asset names from `public/`, such as `house` and `cloud`.

Unlock, lock, lock-status and endpoint discovery always use bootstrap, regardless of the selected endpoint. API calls carry `x-pi-remote-session`. Download URLs may carry `session` only on router API URLs, never external links. Keys are stored under the selected person; router sessions live in tab storage. Changing person clears session and endpoint state. A lock or router restart requires reauthentication, using the stored folder key when available. Endpoint selection checks `health.environmentId` before committing the selection; a misrouted upstream reports an error rather than opening the wrong host.

API fetches reject redirects so custom session headers cannot follow a router response to an external origin. Meet invitations contain no router session; the router does not authorize a guest by accepting the host's person name.

## Focused checks

Run `bun test apps/remote/web/router-auth.test.ts apps/remote/web/router-client.test.ts apps/remote/web/meet-adapter.test.ts` from the repository root. The client test covers the native session bridge, initial authentication, token renewal, open-person sessions, endpoint identity checks and external URL handling.
