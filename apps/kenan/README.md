# Kenan

Kenan is the Android client for Pi Remote. Its package id is `works.kenan.piremote.kenan`, so a deployment updates the installed app in place.

The browser and Android app have one React and TypeScript interface source in [`../remote/web/src`](../remote/web/src). `build.mjs` compiles it with Vite into Capacitor's generated assets. Do not edit `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer keeps the WebView below Android's system bars, translates touches into system haptics, supplies the bootstrap router URL, and handles Android updates and background notifications. Person selection, session persistence, permitted-environment discovery, and environment selection belong to the shared web client. The app contains no SSH implementation, private keys, endpoint inventory, or endpoint warmup.

Idle notifications use a native foreground service that discovers the current person's permitted environments through the router before each polling round. Enable them once in the drawer and allow Android's notification permission. Every discovery and notification request carries `x-pi-remote-session`; `x-pi-remote-user` is only a routing hint. An empty session never starts polling. Discovery failure prevents endpoint polling for that round, and rejected discovery credentials clear the native session mirror and stop monitoring.

Changing person or session clears notification cursors, visible thread notifications, selected-thread suppression, and pending notification navigation. In-flight responses from the previous identity cannot publish notifications or save cursors. The service keeps the current session mirror in Android private preferences so Android can restart monitoring while the WebView is absent. Web storage remains the session owner and synchronizes the mirror on restore, unlock, identity change, and logout. Android backup is disabled in the manifest.

Notifications show the launcher's Kenan head artwork, with a monochrome head for Android's status bar. Opening a thread clears its notifications, and the service suppresses new ones for that thread until the app is backgrounded or another thread is selected. The ongoing monitoring notification reports discovery and polling failures. [Pi Remote's notification contract](../remote/README.md#idle-notifications) describes replay, cursor storage, and delivery limits.

## Native bridge

- `KenanRemote.getState()` returns `{routerUrl}`. It performs no network requests.
- `KenanRemote.syncSession({user, session})` mirrors the web client's authenticated identity. Pass empty strings for both fields to clear it. A user hint without a session is rejected.
- `notifications`, `notificationThread`, and `notificationTarget` use the mirrored identity. Notification payloads and Android intents never contain the session credential.
- The web client discovers `GET /v1/environments` itself. Native notification discovery uses the same contract, resolving each returned `baseUrl` against the bootstrap origin. Empty prefixes address the local environment; nonempty prefixes must be same-origin absolute paths. Native environment selection and transport preparation methods do not exist.

## Build configuration

Ignored [`android/local.properties`](android/local.properties) supplies one credential-free bootstrap router origin. The build requires Android SDK 36, Java 21, and Bun for the connection tests.

```properties
piRemoteRouterUrl=https://pi-remote.example.ts.net/pi-stack
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

Kenan checks the bootstrap router's public `GET /v1/app-update` when the app opens or returns to the foreground. The drawer shows **Update app** only when the published `versionCode` is greater than the installed one. Browser clients do not show Android updates. Check failures offer a retry instead of implying that a new APK exists.

Tapping **Update app** fetches the current manifest again, downloads `/v1/app-update/<revision>.apk` from the same bootstrap origin without a person session, and opens Android's install confirmation. The first installation may open Android's "Allow from this source" setting for Kenan. Enable it and return to Kenan to continue. Cancelling or denying installation leaves the checked APK in private app storage, so retrying the same release does not download it again. A failed check or download reports the problem in the drawer. The app accepts at most 100 MiB and bounds the download to three minutes, with seven-second network read timeouts. It verifies the exact size, SHA-256, package ID, version code, and the installed app's signing certificate before opening the installer through FileProvider.

The publisher serves identical APK bytes on both hosts, without requiring a person selection or unlock. Future releases use this button, not APK links in chat. [`../../deploy/android-update`](../../deploy/android-update) owns publication and retention.

[`release-info.mjs`](release-info.mjs) is the build and publisher identity source. `node apps/kenan/release-info.mjs` prints `{ revision, versionCode, applicationId }` for the current checkout. It requires complete Git history and computes `versionCode` as `1000 + git rev-list --count HEAD`. Publish from integrated main so the count increases. Gradle embeds that identity in `BuildConfig` and `assets/app-release.json`. Keep the existing signing key; changing it prevents Android from updating the installed app in place.

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

The drawer footer shows the Git revision compiled into the shared client. Android's update comparison uses the native package version code, not the revision of a web page served by a newer host.

The deployment tests and builds the APK, verifies its package id, version, and label, updates Kenan in place, launches it, and removes the former side-by-side development package if it is installed.
