# Shared Remote client

Browser and native clients authenticate at the bootstrap router before discovering endpoints. The web client owns person selection, folder keys, router sessions, and endpoint selection.

## Browser mount path

The same built frontend works at `/` or a directory such as `/pi-stack/`. [`app-path.ts`](src/app-path.ts) derives the mount from the document URL. Vite emits relative chunk and public-asset URLs. Pages, artwork, API bootstrap, downloads, Meet navigation and invitations stay under that mount. The manifest uses a relative start URL and scope. There is no Pi Remote service worker to register or a root worker to replace.

The ingress redirects `/pi-stack` to `/pi-stack/`, preserving the query string, then strips `/pi-stack` from every forwarded request. The router and supervisors continue to serve their normal root-relative routes. Do not add root API or asset aliases. There is no per-host build or browser base-path environment variable. HTML pages live directly under the mount, not at arbitrary SPA routes. See [deployment](../../../docs/deployment.md#browser-prefix-hosting).

Browser person selection, folder keys, sessions, endpoint selection, drafts, context caches and notification coordination are scoped by mount. Root installs retain their existing storage names. A different path starts with separate browser state and needs its own authentication. This separates deployments' state, not same-origin security authority.

Android still loads its bundled root-relative pages and uses its configured bootstrap URL, which may itself include a mount prefix. API URLs returned by the router remain relative to that bootstrap. Meet invitations use the bootstrap frontend, not the selected remote API prefix.

## Native bridge

`KenanRemote.getState()` returns `{ routerUrl: string }`, the credential-free bootstrap URL. There is no native endpoint selection, preparation, or SSH setup.

`syncSession({ user, session })` replaces the native notification monitor's authorization. `session` is the opaque router token. Clearing auth sends `{ user: "", session: "" }` and stops monitoring. The monitor discovers allowed endpoints at bootstrap using this session. Every poll carries `x-pi-remote-session`; `x-pi-remote-user` is only a hint. A 423 response stops monitoring until the web client supplies renewed authorization. `notifications({ request })` checks or requests notification permission.

The haptic, keepAwake, notificationTarget, notificationThread, checkAppUpdate and installAppUpdate methods retain their existing roles. Notification targets contain person, endpoint ID and thread ID, never a credential.

## Router contract

Unauthenticated bootstrap `GET /v1/environment` supplies the person chooser. `fetchPersonChooser()` explicitly uses that route without a session, even while signed in. Ordinary authenticated environment requests use the selected endpoint. `POST /v1/unlock` sends `x-pi-remote-user` and `{ key }`; success supplies `{ ok: true, user, session }`. Persons without encrypted folders submit `{}` to mint a session. `GET /v1/environments` requires that session and supplies the authorized endpoint list. Endpoint `baseUrl` values are same-origin prefixes, with an empty prefix for local. Icons are asset names from `public/`, such as `house` and `cloud`.

Unlock, lock, lock-status and endpoint discovery always use bootstrap, regardless of the selected endpoint. API calls carry `x-pi-remote-session`. Download URLs may carry `session` only on router API URLs, never external links. Keys are stored under the selected person; router sessions live in tab storage. Changing person clears session and endpoint state. A lock or router restart requires reauthentication, using the stored folder key when available. Endpoint selection checks `health.environmentId` before committing the selection; a misrouted upstream reports an error rather than opening the wrong host.

API fetches reject redirects so custom session headers cannot follow a router response to an external origin. Meet invitations contain no router session; the router does not authorize a guest by accepting the host's person name.

## Environment and person picker

[`EnvironmentControl`](src/EnvironmentControl.tsx) renders one full-width dropdown containing the current person's authorized environments and every other person from the bootstrap chooser. It has an accessible name but no visible label, icon, or separate person button. People load independently of authenticated environment discovery and remain selectable during environment failures or switching. Choosing an environment uses `KenanRemote.select` to verify its identity before reloading; choosing a person uses `PiRemotePerson.set` to clear the previous session and endpoint selection, leaving authentication to the existing unlock flow. Auth and person events refresh the environment list and invalidate stale results. Each error can be dismissed through the shared [`DismissibleError`](src/dismissible-error.tsx) without clearing the failure or removing the dropdown's Reconnect option. Reconnect retries discovery and shows any renewed failure.

## Dismissible errors

[`DismissibleError`](src/dismissible-error.tsx) imports its own [CSS](src/dismissible-error.css). Pass `message` as a string, or an empty/null/undefined value to remove feedback. Optional props are `dismissLabel`, `className`, `role`, `resetKey` for a new attempt with the same message, and `onDismiss` for server-owned errors. The default role is `alert`; background feedback uses `status`.

Server-owned errors carry an occurrence ID. The client posts it to `POST /v1/errors/:errorId/dismiss` and hides the message after the server acknowledges it. While saving, the button is disabled. A failed save keeps the original error visible with a retryable dismissal error. Server synchronization removes dismissed errors from every client, including drawer and thread summaries. Browser reloads and supervisor restarts retain dismissal.

The supervisor's `error_feedback` table owns acknowledgements. Repeated reports of the same unresolved error keep their ID; recovery, changed messages and new naming attempts create a new occurrence. A stale dismissal cannot acknowledge a newer occurrence or an error from another thread. Dismissal does not change execution state, retry policy, native history or work outcomes.

Client-only errors, such as upload and connection failures, still dismiss locally. Keep failure state and retry actions in the caller. Changed messages, changed reset keys, or clearing the message reset local dismissal. The dismiss button has a 44px touch target and a visible keyboard focus outline.

## Thread settings

[`SettingsPanel`](src/thread-settings.tsx) owns the right-side tray. Model, thinking, speed and bash-timeout controls remain available while a thread runs or holds queued messages. Model changes select the next execution without interrupting current work. Archived threads must be restored before editing.

The selected option uses the server's saved model identity, not a pooled account alias from a running provider request. Each thread mounts its own panel state, so a late save response cannot replace another thread's settings. The open panel refreshes when the thread revision changes. Failed settings and child-list loads retain a Retry button even after dismissing the error; a failed save leaves the controls available.

## Focused checks

Run `bun test apps/remote/web/app-path.test.ts apps/remote/web/router-auth.test.ts apps/remote/web/router-client.test.ts apps/remote/web/meet-adapter.test.ts` from the repository root. The client test covers root and prefixed browser and Android bootstrap, initial authentication, token renewal, open-person sessions, endpoint identity checks, download round trips and external URL handling. The path test builds one frontend into a temporary directory and checks its pages, assets, fonts and manifest behind a prefix-stripping ingress.
