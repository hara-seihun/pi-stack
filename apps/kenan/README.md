# Kenan

Kenan is the Android client for Pi Remote. Its package id is `works.kenan.piremote.kenan`, so a deployment updates the installed app in place.

The browser and Android app have one React and TypeScript interface source in [`../remote/web/src`](../remote/web/src). `build.mjs` compiles it with Vite into Capacitor's generated assets. Do not edit `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer keeps the WebView below Android's system bars, translates touches into system haptics, remembers the selected environment, opens a pinned SSH forward for endpoints that need one, and tells the shared client which endpoint owns each API call. Synchronization, context rendering, the drawer, composer, uploads, voice, files, and settings run from the same compiled application and CSS as the browser. The shared client bounds native environment discovery and SSH preparation separately. Failed discovery is retryable, and a failed network request marks the tunnel for replacement on the next preparation instead of trusting JSch's stale connected flag. Cancelling a selection does not tear down a healthy tunnel. The launcher artwork comes from the native Kenan implementation this app replaced.

## Build configuration

Ignored [`android/local.properties`](android/local.properties) names the endpoint declaration, a JSON list of every host the app may switch among. The build requires Android SDK 36 and Java 21.

```properties
piRemoteEndpointsFile=/owner-only/path/to/endpoints.json
```

A direct endpoint is a URL. An SSH endpoint names a restricted forwarding identity; the build reads the private key file and embeds it, and the app pins the host key and opens only the declared forward. The first entry is the default. Add a host by adding an entry; nothing in the Java layer names a particular machine.

```json
[
  { "id": "local", "name": "Local", "auth": "direct", "url": "https://local-pi-remote.example.ts.net", "requiresUnlock": true },
  {
    "id": "converge", "name": "Converge", "auth": "ssh", "requiresUnlock": false,
    "ssh": {
      "host": "converge.example.net", "port": 22, "user": "pi-remote-android",
      "privateKeyFile": "/owner-only/path/to/android-converge-key",
      "hostKey": "ecdsa-sha2-nistp256 <base64-encoded host key>",
      "localPort": 8789, "remoteHost": "127.0.0.1", "remotePort": 8788
    }
  }
]
```

Build and test with:

```sh
npm run android:test --workspace=kenan
```

## Deploy

```sh
apps/kenan/deploy
```

The drawer footer shows the Git revision compiled into the shared client, so an installed app can be distinguished from a newer server release even when the Android package version is unchanged.

The deployment tests and builds the APK, verifies its package id, version, and label, updates Kenan in place, launches it, and removes the former side-by-side development package if it is installed.
