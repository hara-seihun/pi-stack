# Kenan

Kenan is the Android client for Pi Remote. Its package id is `works.kenan.piremote.kenan`, so a deployment updates the installed app in place.

The browser and Android app have one React and TypeScript interface source in [`../remote/web/src`](../remote/web/src). `build.mjs` compiles it with Vite into Capacitor's generated assets. Do not edit `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer keeps the WebView below Android's system bars, routes the system back gesture through the client's `window.PiRemoteBack()` and backgrounds the app only when the client had nothing left to close, translates touches into system haptics, supplies the bootstrap router URL, and handles Android updates and background notifications. Person selection, session persistence, permitted-environment discovery, and environment selection belong to the shared web client. The app contains no SSH implementation, private keys, endpoint inventory, or endpoint warmup.

Agent completion and question notifications use a native foreground service that polls every permitted environment every 30 seconds and refreshes the permitted-environment list through the router every five minutes, or sooner after a discovery failure. While the app is in the foreground, the web client's event stream passes the selected environment's feed to native delivery immediately. The stream and poll share a native cursor per environment; streamed sequence numbers are retained until the poll catches up, so neither source duplicates the other or skips a polled completion. Enable them once in the drawer and allow Android's notification permission. Every discovery and notification request carries `x-pi-remote-session`; `x-pi-remote-user` is only a routing hint. An empty session never starts polling. Discovery failure prevents endpoint polling for that round, and rejected discovery credentials clear the native session mirror and stop monitoring.

Changing person or session clears notification cursors, visible thread notifications, selected-thread suppression, and pending notification navigation. In-flight responses from the previous identity cannot publish notifications or save cursors. The service keeps the current session mirror in Android private preferences so Android can restart monitoring while the WebView is absent. Web storage remains the session owner and synchronizes the mirror on restore, unlock, identity change, and logout. Android backup is disabled in the manifest.

Notifications show the launcher's Kenan head artwork, with a monochrome head for Android's status bar. Questions include their prompt and a Question label, using the same permission/channel as completions. While the app is visible, a completion or question in another thread becomes a clickable web toast, not an Android alert. Tapping a question opens that thread with the answer/dismiss composer up ([questions](../remote/docs/questions.md)). Opening a thread clears its Android notifications and suppresses new alerts and toasts for that thread until another thread is selected. In the background completions and questions remain private system notifications. The ongoing monitoring notification reports discovery and polling failures. [Pi Remote's notification contract](../remote/README.md#idle-notifications) describes replay, cursor storage, and delivery limits.

## Email sign-in outside the private network

When the private router is unavailable, Kenan opens a separate full-screen WebView for Cloudflare Access. Enter the invited email and its code, then choose your person and unlock with your folder key as usual. The sign-in WebView has no Capacitor bridge and never receives folder keys. Cancel returns a visible retryable error; Reload sign-in retries a network failure.

Native reads the HttpOnly `CF_Authorization` cookie with Android's `CookieManager`, validates the signed token by requesting the public router's `/v1/environment`, and stores it with its router identity in private app preferences. The bundled client receives it in memory through `getState`; neither URLs nor web storage carry the Access token. Web HTTP, native notifications, native Write (including WebSockets and learning), phone control, and app-update transfers send `cf-access-token` only to that public router. Proxying removes Access headers before forwarding to supervisors. The folder session remains a separate credential and an Access login alone never unlocks a folder.

Browser WebSockets and embedded media cannot set custom headers. In this app's own cookie jar native sets the same signed JWT as a Secure, HttpOnly, SameSite=None cookie, preserving the token's expiry, and enables third-party cookies on the bundled WebView. Cloudflare's original cookie settings and edge JWT validation remain unchanged. Router CORS allows credentials only from the bundled `http://localhost` origin.

A rejected Access token is cleared natively. Background failures say to open Kenan; returning to the app validates/renews sign-in. Foreground HTTP detects Access redirects/rejections and renews once before replaying the request. A CORS/network failure is checked natively rather than automatically treated as an expired token. Folder sessions and notification cursors survive Access renewal; a rejected folder session still requires folder unlock.

For a focused live transport proof, log in through a browser, save its state privately, and run `python3 scripts/kenan-public-probe.py --origin https://public-router.example.test --state /private/browser-state.json`. Add `--user PERSON --key-stdin` and pipe that person's folder key to cover unlock, permitted notification endpoints and Write WebSocket handshakes. The probe emits only status/version receipts, not credentials. Delete the temporary browser state after acceptance. This proves live wire behavior; it does not substitute for Android device interaction acceptance.

## Pi Stack Write on Android

Open **Machine → Pi Stack Write** after unlocking Kenan and grant microphone, **Display over other apps**, the **Pi Stack Write accessibility service**, and notifications to see dictionary learning with Undo. The optional battery-optimization exemption helps keep the bubble available after extended background use. Android's settings pages return to Kenan; the card updates permission status on return. The keyboard requirement is on by default; turn it off in the card to display the bubble whenever an eligible editable field has focus. The app never enables accessibility for you.

Write and phone control share exactly one movable overlay dot, not separate bubbles. With Write available, an eligible focused editable field turns the dot into a microphone: password, number, and phone fields are excluded, and the keyboard must be visible unless the keyboard requirement is turned off. Otherwise the dot shows Kenan if his overlay is enabled. The accessibility services and their permissions remain separate; either service can use the dot without enabling the other.

The microphone is a 44dp translucent circle with a 50dp touch target. Tap once to record; it becomes an opaque live waveform. Tap again to finish and insert at the cursor; the idle dot returns to the appropriate mode. Drag from any point, including during dictation: the dot follows the finger, snaps to an edge, stays above the keyboard, and remembers one shared edge and height across both modes. Dragging the idle dot in either mode exposes labelled **Kenan**, **Mic**, and **Both** dismissal targets above the keyboard. Release on **Kenan** to persistently turn off Kenan's overlay (`overlayVisible`); this does not hide the microphone. **Mic** hides Write only for the current field, until another field gains focus or this field is left and refocused; this does not turn off Kenan. **Both** applies both dismissals. While connecting, recording, or finalizing, **Mic** and **Both** dismissal are unavailable; **Kenan** can still be hidden without interrupting dictation. Active dictation keeps its microphone control available so it can be finished. A dim waveform signals more than one second of buffered audio. Write encodes microphone audio on the phone as 16 kHz mono Opus at 24 kbps in 20 ms packets; each packet streams immediately to the selected permitted Pi Remote supervisor. A brief pulsing ring indicates finalization. Android's microphone foreground notification remains visible while recording. Empty transcripts, server errors, socket closure, and timeouts stop and reset the bubble to idle without inserting text or leaving a retry state. If an app rejects accessibility insertion, Write copies the text to the clipboard; the bubble becomes a clipboard icon that can be tapped to paste, and manual paste is still available. Protected or unusual app fields can refuse both actions. Write needs a valid mirrored session and a permitted environment. A logout clears the selection and stops capture.

On Android 8 and later, accessibility text marked as a displayed hint is treated as an empty field for dictation context, insertion, and correction learning. Real typed text is preserved even when it exactly matches the hint; hint strings are not compared to infer emptiness.

For 20 seconds after insertion, edits to a word inside the inserted span are sent to the supervisor's learning endpoint. A successful dictionary update shows an Android notification with **Undo**. Only a word edit in the inserted span is learned; field text is not sent on ordinary focus events. Write uses the existing mirrored `RemoteSession` and router environment discovery, and the selected environment comes from the shared web client. The wire contract is [Pi Remote Write](../remote/docs/write.md). The native protocol adapter is `WriteConnection.java`.

## Native crash diagnostics

The application retains the most recent uncaught Java stack in its private `files/diagnostics/last-crash.txt`, with build revision, version and failing thread. It still delegates to Android's crash handler; diagnostics do not mask defects or suppress the system crash dialog. Startup also captures the last eight Android process-exit records (`process-exits.json`) and up to 200 entries from this app UID's crash-only log buffer (`android-crashes.txt`). Nothing is uploaded automatically. With the person's enabled phone-control connection, read these through `pi-phone files read /data/user/0/works.kenan.piremote.kenan/files/diagnostics/FILE --output /private/local/FILE`. These files overwrite their previous bounded snapshot; no chat or audio logging is added.

Write attempt completion invalidates the audio sender before releasing its packet buffer. Microphone and codec cleanup completes before a terminal recorder callback; shutdown unblocks reads, connection terminal events close their transport once, and late callbacks cannot change the next attempt. Revoked overlay tokens and detached windows reset the overlay instead of escaping into Android's process crash handler. Service teardown cannot create a replacement window.

## Unattended phone control

Open **Machine → Phone control** in the updated Android app, enable it for the unlocked person and current environment, and approve the one-time access you want. Enable the separate **Kenan phone control** accessibility service for app interaction and screenshots; Pi Stack Write keeps its own service. Notification-listener access supplies notification actions and replies. The capability card reports effective grants, so a restricted/denied permission is not represented as usable.

The phone initiates an authenticated connection through its existing router and permitted environment. This works over Tailscale on mobile data without shared Wi-Fi, wireless debugging, ADB, a second VPN or accepting a new screen-projection session. The host-side `pi-phone` CLI lists connected phones and operates the phone registered with that environment. See the [phone-control contract and command interface](../remote/docs/phone-control.md).

The explicit enable choice, device UUID, display name and selected environment live in private `phone-control` preferences. Connection/commands belong to the mirrored person session; logout or identity replacement closes them and fences old commands. Saved enablement belongs to the consenting user: the same owner can reauthenticate and resume without re-enabling, while a different person cannot inherit control. The foreground service reconnects while enabled, and boot/package replacement restore it where Android permits. Force-stopping Kenan requires reopening it; first unlock after reboot and Android background restrictions remain real. Tailscale must remain connected. The status card separates enabled, connected and effective capability states.

With the phone-control accessibility service on and **Show Kenan over other apps** enabled, the shared overlay dot shows Kenan over other apps: tap it to type to Kenan, and his replies, pointing and every tap or swipe he makes appear on screen without opening Kenan. An eligible focused field switches the same dot to Write's microphone when Write is available; there is never a second dot. Both modes share the saved position and stay above the keyboard. Dragging the idle dot in either mode offers independent **Kenan**, **Mic**, and **Both** dismissal targets with the persistence and active-dictation rules described above. Phone control and Write still have independent accessibility services and permissions, and either works alone. The [phone-control contract](../remote/docs/phone-control.md#kenan-overlay) owns its protocol.

Accessibility capture supplies rate-limited ordinary screenshots, not unrestricted video or secure-window capture. Private app storage, protected credentials and authentication bypass remain inaccessible. Supplied credentials can be entered through ordinary permitted UI interaction; tree inspection redacts password text. Pass secret command arguments through CLI JSON stdin rather than process arguments. Camera/microphone grants belong to ordinary supported recording flows; this interface does not expose unattended capture. Optional `WRITE_SECURE_SETTINGS` can be granted once through authorized ADB. Device Owner requires fully-managed provisioning, often involving a reset, and is never enrolled automatically. Optional Device Admin supports screen locking but does not confer Device Owner powers. Setup never sends messages, places calls, deletes files, resets the phone or changes its default apps.


- `KenanRemote.getState()` returns `{routerUrl, accessToken}`. On the first call in a process it probes the private router with 1.5-second connection/read deadlines and selects the configured public router when the private router is unreachable. For public ingress it validates the saved Access token and opens email-code sign-in if it is absent or rejected. The promise waits for sign-in or cancellation; callers must not impose a short network deadline on this user interaction. Later calls validate/renew the public token without changing ingress.
- `KenanRemote.checkAppUpdate()` returns `{installed, update}`; `installAppUpdate()` applies a web bundle (`{status:"reloading"}`) or opens Android's installer (`{status:"installer-opened"}`); `webReady()` confirms the running bundle. See [In-app updates](#in-app-updates).
- `KenanRemote.syncSession({user, session})` mirrors the web client's authenticated identity. Pass empty strings for both fields to clear it. A user hint without a session is rejected.
- `notifications`, `notificationFeed`, `notificationThread`, and `notificationTarget` use the mirrored identity. Notification payloads and Android intents never contain the session credential. `notificationFeed({user,environment,name,feed:{cursor,notifications:[{seq,sessionId,name,...}]}})` accepts the current environment's stream batches. A mismatched person or disabled notifications are ignored. `notificationThread({user,environment,sessionId})` selects the visible thread (empty `sessionId` elsewhere) and acknowledges that the web toast listener is installed. Native emits `pi-notification-toast` with detail `{user,environment,sessionId,title,body,seq}` after that acknowledgement; a feed arriving earlier is queued until the listener is ready, and a pending toast becomes a system notification if the app backgrounds. Capacitor's page-start listener resets readiness and the selected thread on every WebView navigation, including environment-switch reloads, until the new page calls `notificationThread`. Identity changes discard pending toasts.
- The web client discovers `GET /v1/environments` itself. Native notification discovery uses the same contract, resolving each returned `baseUrl` against the bootstrap origin. Empty prefixes address the local environment; nonempty prefixes must be same-origin absolute paths. Write's `writeEnvironment({user,environment})` mirrors the verified web selection for background dictation; the native adapter rediscovers permitted endpoints before each dictation and learning request. Notification environment selection and transport preparation methods do not exist.
- `writeStatus()` reports accessibility, overlay, microphone and battery-exemption states and the keyboard requirement. `writeSetup({step,required?})` opens the appropriate Android settings or requests microphone permission; for `step:"keyboard"`, `required` changes the bubble visibility preference.
- `phoneStatus()` reports phone-control enablement, connection, device identity and effective capabilities. `phoneConfigure({enabled,user,environment,name?})` explicitly enables/disables control for a verified person/environment. `phoneSetup({step})` requests a one-time runtime permission or opens Android special-access settings; it cannot provision Device Owner. [Phone control](../remote/docs/phone-control.md) owns the steps, command wire format and CLI.

## Build configuration

Copy [`android/local.properties.example`](android/local.properties.example) to ignored `android/local.properties` and set the router URL to an address the phone can reach. The build requires Android SDK 36, Java 21, and Bun for the connection tests. Android Studio may add `sdk.dir` to the same local file. Never put signing keys or passwords in it.

```properties
piRemoteRouterUrl=https://router.example.test/pi-stack
# Optional Cloudflare Access entrance for phones without the private network:
piRemotePublicRouterUrl=https://public-router.example.test/pi-stack
```

The field is required. HTTP is also accepted for private-LAN or loopback development, such as `http://127.0.0.1:8788`. Credentials, query strings, fragments, and paths other than plain directory prefixes are rejected. Endpoint declarations and SSH key files are not read by the build. The router owns person access policy and remote proxy routing; adding an environment does not require a new APK.

The optional public URL must use HTTPS and the same router deployment, with Cloudflare Access email-code sign-in and preflight permission for `http://localhost`, all required methods/headers, and credentials. The private URL remains the preferred route on each cold start. If a network changes while the app is running, reopen Kenan to reselect its ingress.

The bootstrap URL accepts an optional plain directory prefix and no credentials, query or fragment. A root-hosted router uses just its origin. The [browser hosting contract](../../docs/deployment.md#browser-prefix-hosting) describes prefix stripping; native API, notification and app-update requests retain this prefix. Android assets still load from the bundled app root.

The public `GET /v1/environment` supplies the identity chooser. `POST /v1/unlock` takes the person hint in `x-pi-remote-user` and a JSON key, then returns `{ok:true,user,session}`. Authenticated API requests carry `x-pi-remote-session`; navigations can carry `session=`. `GET /v1/environments` returns only the session's permitted `{id,name,baseUrl,icon?}` entries.

Focused native router tests cover permitted prefixes, session headers, redirects, and identity invalidation. `NotificationSequenceTest` checks that streamed completions ahead of a polled cursor neither skip missing completions nor duplicate them after a restart. Transport tests use the test-only MockWebServer dependency to exercise real HTTP requests. Android's Java compiler cannot resolve the JDK-only `com.sun.net.httpserver` API, even for local unit tests.

```sh
cd apps/kenan/android
./gradlew testDebugUnitTest --tests '*RemoteEnvironmentTest' --tests '*RemoteTransportTest' --tests '*RemoteSessionTest'
```

Build and run all Android checks with:

```sh
npm run android:test --workspace=kenan
```

## In-app updates

Kenan is a thin shell: the APK carries a built-in copy of the shared web client, and a published web bundle for the same shell replaces that copy in place. Only changes to the native layer need a new APK.

`release-info.mjs` derives a `shellId` from the tracked native inputs: `apps/kenan/android` without its unit tests, `capacitor.config.json` and `package.json`. It also hashes the compiled `piRemoteRouterUrl` and `piRemotePublicRouterUrl` from ignored `android/local.properties`, because those are native fields: changing the bootstrap reaches installed apps as an APK, not as a web bundle that would leave the old URL compiled in. Gradle embeds it in `BuildConfig.SHELL_ID`. Every publication produces two artifacts from one build: the APK, and a zip of the APK's own `assets/public` as the web bundle, both carrying the same revision, version code and shell identity. A web-only change keeps the shell identity; a native change produces a new one.

Kenan checks the bootstrap router's public `GET /v1/app-update` when the app opens or returns to the foreground. The response carries `release` (the APK) and `web` (the bundle). The shell decides:

- A web bundle whose `shellId` matches the installed shell and whose version code is newer than the running client is offered as a web update. It is downloaded in the background right away, so it is usually ready by the time the drawer shows **Update app**. Tapping the button switches the WebView to the new bundle and reloads it; there is no Android installer. A downloaded bundle also takes effect on the next cold start without tapping anything.
- Otherwise a newer APK is offered as before, unless it only carries a web client this shell already runs or rejected. The drawer says which kind it is. Browser clients show neither.

Bundles live in private app storage under `web-bundles/<revision>/` with a `release.json` completion marker; `state.json` records launches and confirmations. `MainActivity` serves the newest fitting bundle through Capacitor's file hosting; the app origin stays `http://localhost`, so web storage and sessions carry across updates. Once the client renders it calls `KenanRemote.webReady`, which confirms the bundle. A bundle that is launched three times without confirming is marked bad, removed, never offered again, and the previous confirmed bundle or the built-in client serves instead. A new APK starts from its own built-in client and discards bundles that are older than it or belong to another shell.

Downloads are verified against the manifest's exact size and SHA-256 before extraction, which refuses paths that escape the bundle directory, more than 5000 files, or more than 200 MiB. The bundle download accepts at most 50 MiB and the APK at most 100 MiB; each is bounded to three minutes with seven-second read timeouts. The APK path additionally verifies package ID, version code and the installed signing certificate before opening the installer through FileProvider; the first installation may need "Allow from this source". Check failures offer a retry instead of implying that an update exists.

Both hosts serve identical bytes for both artifacts, without requiring a person selection or unlock. [`../../deploy/android-update`](../../deploy/android-update) owns publication and retention.

`node apps/kenan/release-info.mjs` prints `{ revision, versionCode, applicationId, shellId }` for the current checkout. It requires complete Git history and computes `versionCode` as `10000 + git rev-list --count HEAD`. The source-controlled base of 10000 keeps a fresh public Git root above the previously installed 2xxx-series APKs; subsequent integrated commits increase the count. Do not reset or lower this base without accounting for installed versions. Publish from integrated main so the count increases. Gradle embeds that identity in `BuildConfig` and `assets/app-release.json`. Keep the existing signing key; changing it prevents Android from updating the installed app in place.

## First install and ADB deployment

Routine releases use in-app updates. An authorized ADB connection can install the first update-capable APK or recover an installation:

```sh
apps/kenan/deploy
```

[`connect-adb`](connect-adb) uses an authorized attached phone, its last successful endpoint, or wireless-debugging mDNS. It accepts LAN endpoints as well as other reachable addresses. It no longer scans 35,000 tailnet ports when debugging is unavailable. If discovery cannot reach the phone, enable Wireless debugging and supply the endpoint explicitly before deploying:

```sh
apps/kenan/connect-adb HOST:PORT
apps/kenan/deploy
```

The selected endpoint lives in `${XDG_CACHE_HOME:-$HOME/.cache}/pi-remote/android-adb-endpoint`. ADB starts from that directory so its persistent daemon cannot keep a task checkout referenced. Automatic discovery selects `PI_REMOTE_ANDROID_MODEL`, defaulting to ADB's `Pixel_7` model name. An explicit endpoint takes precedence. Unpaired devices require Android's pairing flow, and discovery across networks requires an explicit reachable endpoint.

The drawer footer shows the Git revision compiled into the running web client, which after a web update is newer than the APK's revision. Update comparison uses version codes: the running web client's for bundles, the installed package's for APKs.

The deployment tests and builds the APK, verifies its package id, version, and label, updates Kenan in place, launches it, and removes the former side-by-side development package if it is installed.
