# Kenan

Kenan is the Android client for Pi Remote. Its package id is `works.kenan.piremote.kenan`, so a deployment updates the installed app in place.

The browser and Android app have one interface source: [`../remote/web`](../remote/web). `build.mjs` copies those files into Capacitor's generated assets. Do not edit `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer keeps the WebView below Android's system bars, translates touches into system haptics, remembers the selected environment, opens the pinned Converge SSH forward, and tells the shared client which endpoint owns each API call. Synchronization, context rendering, the drawer, composer, uploads, voice, files, and settings run from the same JavaScript and CSS as the browser. The launcher artwork comes from the native Kenan implementation this app replaced.

## Build configuration

Ignored [`android/local.properties`](android/local.properties) supplies endpoint URLs and Converge SSH credentials. The build requires Android SDK 36 and Java 21.

```properties
piRemoteLocalUrl=https://local-pi-remote.example.ts.net
piRemoteConvergeAuth=ssh
piRemoteConvergeSshHost=converge.example.net
piRemoteConvergeSshPort=22
piRemoteConvergeSshUser=pi-remote-android
piRemoteConvergeSshPrivateKeyFile=/owner-only/path/to/android-converge-key
piRemoteConvergeSshHostKey=ecdsa-sha2-nistp256 <base64-encoded host key>
piRemoteConvergeSshLocalPort=8789
piRemoteConvergeSshRemoteHost=127.0.0.1
piRemoteConvergeSshRemotePort=8788
```

Build and test with:

```sh
npm run android:test --workspace=kenan
```

## Deploy

```sh
apps/kenan/deploy
```

The deployment tests and builds the APK, verifies its package id, version, and label, updates Kenan in place, launches it, and removes the former side-by-side development package if it is installed.
