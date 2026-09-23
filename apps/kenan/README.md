# Kenan

Kenan is the Android client for Pi Remote. Its package id is `works.kenan.piremote.kenan`, so a deployment updates the installed app in place.

The browser and Android app have one React and TypeScript interface source in [`../remote/web/src`](../remote/web/src). `build.mjs` compiles it with Vite into Capacitor's generated assets. Do not edit `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer keeps the WebView below Android's system bars, routes the system back gesture through the client's `window.PiRemoteBack()` and backgrounds the app only when the client had nothing left to close, translates touches into system haptics, supplies the bootstrap router URL, and handles Android updates and background notifications. Person selection, session persistence, permitted-environment discovery, and environment selection belong to the shared web client. The app contains no SSH implementation, private keys, endpoint inventory, or endpoint warmup.

Idle notifications use a native foreground service that polls every permitted environment every 30 seconds and refreshes the permitted-environment list through the router every five minutes, or sooner after a discovery failure. While the app is in the foreground, the web client's event stream delivers the selected environment's notifications immediately. Enable them once in the drawer and allow Android's notification permission. Every discovery and notification request carries `x-pi-remote-session`; `x-pi-remote-user` is only a routing hint. An empty session never starts polling. Discovery failure prevents endpoint polling for that round, and rejected discovery credentials clear the native session mirror and stop monitoring.

Changing person or session clears notification cursors, visible thread notifications, selected-thread suppression, and pending notification navigation. In-flight responses from the previous identity cannot publish notifications or save cursors. The service keeps the current session mirror in Android private preferences so Android can restart monitoring while the WebView is absent. Web storage remains the session owner and synchronizes the mirror on restore, unlock, identity change, and logout. Android backup is disabled in the manifest.

Notifications show the launcher's Kenan head artwork, with a monochrome head for Android's status bar. Opening a thread clears its notifications, and the service suppresses new ones for that thread until the app is backgrounded or another thread is selected. The ongoing monitoring notification reports discovery and polling failures. [Pi Remote's notification contract](../remote/README.md#idle-notifications) describes replay, cursor storage, and delivery limits.

## Native bridge

- `KenanRemote.getState()` returns `{routerUrl}`. It performs no network requests.
- `KenanRemote.checkAppUpdate()` returns `{installed, update}`; `installAppUpdate()` applies a web bundle (`{status:"reloading"}`) or opens Android's installer (`{status:"installer-opened"}`); `webReady()` confirms the running bundle. See [In-app updates](#in-app-updates).
- `KenanRemote.syncSession({user, session})` mirrors the web client's authenticated identity. Pass empty strings for both fields to clear it. A user hint without a session is rejected.
- `notifications`, `notificationThread`, and `notificationTarget` use the mirrored identity. Notification payloads and Android intents never contain the session credential.
- The web client discovers `GET /v1/environments` itself. Native notification discovery uses the same contract, resolving each returned `baseUrl` against the bootstrap origin. Empty prefixes address the local environment; nonempty prefixes must be same-origin absolute paths. Native environment selection and transport preparation methods do not exist.

## Build configuration

Copy [`android/local.properties.example`](android/local.properties.example) to ignored `android/local.properties` and set the router URL to an address the phone can reach. The build requires Android SDK 36, Java 21, and Bun for the connection tests. Android Studio may add `sdk.dir` to the same local file. Never put signing keys or passwords in it.

```properties
piRemoteRouterUrl=https://router.example.test/pi-stack
```

The field is required. HTTP is also accepted for private-LAN or loopback development, such as `http://127.0.0.1:8788`. Credentials, paths, query strings, and fragments are rejected. Endpoint declarations and SSH key files are not read by the build. The router owns person access policy and remote proxy routing; adding an environment does not require a new APK.

The bootstrap URL accepts an optional plain directory prefix and no credentials, query or fragment. A root-hosted router uses just its origin. The [browser hosting contract](../../docs/deployment.md#browser-prefix-hosting) describes prefix stripping; native API, notification and app-update requests retain this prefix. Android assets still load from the bundled app root.

The public `GET /v1/environment` supplies the identity chooser. `POST /v1/unlock` takes the person hint in `x-pi-remote-user` and a JSON key, then returns `{ok:true,user,session}`. Authenticated API requests carry `x-pi-remote-session`; navigations can carry `session=`. `GET /v1/environments` returns only the session's permitted `{id,name,baseUrl,icon?}` entries.

Focused native router tests cover permitted prefixes, session headers, redirects, and identity invalidation. Transport tests use the test-only MockWebServer dependency to exercise real HTTP requests. Android's Java compiler cannot resolve the JDK-only `com.sun.net.httpserver` API, even for local unit tests.

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

`release-info.mjs` derives a `shellId` from the tracked native inputs: `apps/kenan/android` without its unit tests, `capacitor.config.json` and `package.json`. Gradle embeds it in `BuildConfig.SHELL_ID`. Every publication produces two artifacts from one build: the APK, and a zip of the APK's own `assets/public` as the web bundle, both carrying the same revision, version code and shell identity. A web-only change keeps the shell identity; a native change produces a new one.

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
