# Private workspace editor

Files opens a person's workspace in code-server on a **separate, unique browser origin**. The Pi app and every person's editor must have different origins. This isolates editor browser storage and extension content from the app and from other editors.

## Host provisioning

Source owners:

- `apps/remote/server/pi-editor-launch`: fixed root namespace entry, Unix-account privilege drop, encrypted-state confinement and readiness.
- `deploy/systemd/pi-editor@.service`: on-demand lifecycle bound to `pi-remote@USER.service`.
- `deploy/editor`: installs the launcher/unit or updates nonsecret person editor configuration. Neither command starts an editor.

Prerequisites on each host: Python 3, util-linux (`nsenter`, `setpriv`), systemd, gocryptfs, code-server installed at `/usr/bin/code-server` with `--socket-mode` and `--disable-proxy`, and router Bun **>= 1.3.13** at `/usr/local/bin/bun` (Unix-socket WebSockets). Install the host-owned code-server package through its package manager; the source provisioner does not download executables.

From the committed checkout, or a deployed Remote release that carries `deploy/editor` and its reference unit:

```sh
sudo deploy/editor install
sudo deploy/editor person USER /home/USER/private/workspace \
  http://USER-editor.private.example --app-origin http://pi.private.example
```

Replace all example names with the host's actual Unix account, encrypted mount/workspace and origins. `person` requires an existing registry entry and Unix account. It atomically writes only `editor`, preserving other person fields, and rejects an unencrypted/outside-mount workspace, duplicate editor origin, or app/editor origin collision. The workspace must already exist when opened; provisioning does not unlock folders or create workspaces.

The resulting nonsecret registry `/var/lib/pi-remote/persons/USER.json` contains:

```json
{
  "unlock": {
    "cipherDir": "/home/USER/.private.crypt",
    "mountpoint": "/home/USER/private"
  },
  "editor": {
    "workspace": "/home/USER/private/workspace",
    "origin": "http://USER-editor.private.example"
  }
}
```

This is a fragment of an existing Person, not a complete registry file. Omit `editor` to leave editing unavailable. Use canonical absolute paths and an HTTP(S) origin without a trailing slash. Restart `pi-remote-router.service` after registry changes to load the editor host map. Installing an updated launcher does not restart an already open editor. Stop that person's editor after updating it if the new launcher must take effect immediately.

`install` copies the launcher to root-owned `/usr/local/libexec/pi-editor-launch`, renders `/etc/systemd/system/pi-editor@.service` with that fixed path and reloads systemd. Publication packs the launcher with the Remote server; installation remains an explicit host provisioning step. No editor unit is enabled at boot.

### Private gateway

Provision one private DNS hostname per configured editor origin. Route its Host to the same Pi Remote router at the **origin root**, preserving Host and forwarding both HTTP and WebSocket upgrades. Do not route it directly to code-server. The app origin stays on its existing router route. Private HTTP origins need no added TLS infrastructure; an existing HTTPS gateway may use HTTPS origins instead.

For an existing nginx HTTP gateway, the editor host's location has the following shape (substitute the actual router listener and maintain the gateway's existing WebSocket `map`):

```nginx
server {
    listen 80;
    server_name USER-editor.private.example;
    location / {
        proxy_pass http://127.0.0.1:ROUTER_PORT;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_http_version 1.1;
    }
}
```

Use the host's authorized ingress: private household origins stay private; a work host with an existing protected public HTTPS gateway may reuse that gateway for its isolated editor origins. Do not add TLS infrastructure to private HTTP routing. DNS alone does not grant editor access. Router/session authorization is mandatory: code-server deliberately has no independent login page.

## Open and shutdown

Authenticated `GET /v1/editor` returns `{ok:true, origin, environmentId}` for the configured local person, or `503 editor_unconfigured`. `POST /v1/editor` takes `{path:null|"/absolute/path", kind:"file"|"directory"}`; null opens the configured workspace. An explicit open starts `pi-editor@USER.service` and returns `{ok:true, url: "http://USER-editor.private.example/editor/open", ticket}`. The client submits the short-lived, one-use ticket as a **POST body** on that editor origin. The router consumes it, sets an editor-origin-scoped HttpOnly session cookie and redirects to the selected workspace/file. Tickets are not embedded in URLs. Only that editor session may reach its root HTTP/WebSocket routes. Editor origins reject all Pi Stack `/v1/` APIs. Mutation and WebSocket requests require that editor's Origin; app/router/upstream credentials are stripped before proxying. All editor HTTP responses are `no-store`. Grants expire after eight hours, are bound to the issuing router session and abort HTTP/WebSockets on revocation. `POST /v1/editor/close` invalidates that app session's grants and pending tickets on identity/session changes. Browsers embed the editor in a bare iframe and remove it on the same transition. Android uses the retained top-level non-Capacitor WebView without an app bridge or READY-state chrome; system Back returns to Files. Its local bundled app origin is `http://localhost`, so a private HTTP editor must be top-level to retain normal first-party cookie semantics. Separate origins keep editor storage isolated across persons. The local editor refuses a path selected on another remote environment; open that environment's own router instead.

The ticket and grant bind the browser parent to the authenticated app request URL's origin, or the configured OIDC `publicUrl` origin behind HTTPS ingress. Origin/forwarded headers cannot choose it. Every proxied CSP policy retains its other directives and replaces `frame-ancestors` with only `'self'` and that exact parent; contradictory `X-Frame-Options` is stripped. The provisioner's `--app-origin` checks separation; runtime ticket scope owns framing authority. HTTPS editor cookies use `SameSite=None; Secure` for same-site or cross-site embedding. Private HTTP uses `SameSite=Lax` with same-site browser hosts and the top-level native editor; no private TLS is introduced.

The router proxies `/run/pi-editor/USER/http.sock`. The runtime directory is person-owned `0700`; the socket is `0600`. There is no code-server TCP listener, and `--disable-proxy` removes code-server's ambient host/port proxy routes.

The root entry reads the registered Unix account and current `pi-remote@USER` MainPID, pins its mount namespace and enters only that namespace. It then immediately drops UID/GID/supplementary groups through `setpriv`, clears inherited environment, disables privilege escalation and executes code-server with the Unix account's HOME. It does not inherit router or supervisor credentials. The unprivileged entry requires the registered mountpoint to be an actual `fuse.gocryptfs` mount and rejects workspace/state symlinks escaping it or directories on another filesystem. No plaintext is mounted in the host namespace.

Editor-managed config, extensions, data, cache and temporary files live under the encrypted mount's `.pi-editor`. Its managed `config/code-server.yaml` is reset to `{}` at launch; service flags own listener/auth/proxy policy. The only editor runtime file outside the encrypted mount is its Unix socket. VS Code's terminal and extensions run as that Unix person, with that person's filesystem grants; the encrypted workspace is the initial folder, not a new Unix sandbox.

The unit waits for `/healthz` to report `alive`. Startup is bounded by 15 seconds, shutdown by 10 seconds; `KillMode=control-group` owns extension hosts and terminal children. `BindsTo` plus `After=pi-remote@USER.service` stops the editor when the person supervisor stops, including lock/logout that stops that unit. An editor is not automatically reopened after a supervisor restart.

## Diagnosis and deletion

```sh
systemctl status pi-editor@USER.service
journalctl -u pi-editor@USER.service -n 30 --no-pager
sudo -u USER curl --unix-socket /run/pi-editor/USER/http.sock http://localhost/healthz
sudo systemctl stop pi-editor@USER.service
```

The launcher prints JSON errors such as `not_configured`, `person_locked`, `outside_encrypted_mount`, `unsafe_socket` and `start_timeout`; failed readiness makes the unit fail, rather than reporting active before the editor is ready. Repair missing package/config/DNS/gateway prerequisites at their host owner. Do not use a plaintext workspace or TCP listener as a substitute.

To remove access, stop the editor, remove its `editor` registry field and remove that origin's gateway/DNS route. `.pi-editor` is encrypted personal state: preserve it unless that person requested deletion. Host-wide removal may delete `/usr/local/libexec/pi-editor-launch` and `/etc/systemd/system/pi-editor@.service` after stopping all editor instances and reloading systemd.

Focused source checks:

```sh
python3 deploy/editor_test.py
bun test apps/remote/server/editor-access.test.ts apps/remote/server/editor-proxy.test.ts apps/remote/server/files.test.ts apps/remote/server/path-info.test.ts
```
