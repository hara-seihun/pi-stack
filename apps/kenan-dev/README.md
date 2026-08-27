# kenan-dev

`kenan-dev` is the side-by-side Android development channel for Pi Remote's shared client. Its package id is `works.kenan.piremote.kenan.dev`, so installing it never replaces the current `works.kenan.piremote.kenan` app.

The browser and this app have one interface source of truth: [`../remote/web`](../remote/web). `build.mjs` copies that client into Capacitor's generated asset directory. Do not edit files under `dist` or `android/app/src/main/assets/public`; both are generated.

The native layer is deliberately narrow. `KenanRemotePlugin` remembers the selected environment, opens the pinned Converge SSH forward, and tells the shared client which endpoint owns its API calls. Everything above transport, including synchronization, context rendering, the drawer, composer, uploads, voice, and settings, runs from the same JavaScript and CSS as the browser.

This channel does not yet replace the current app. Android-only background completion notifications and the native filesystem drawer still live only in the current client. Keeping both package ids installed makes those gaps safe while the shared client is exercised on the phone.

## Build

The ignored [`../remote/android/local.properties`](../remote/android/local.properties) supplies endpoint URLs and Converge SSH credentials to both Android clients. The build requires Android SDK 36 and Java 21.

```sh
npm run android:test --workspace=kenan-dev
```

## Deploy

Wireless ADB discovery is shared with the current app:

```sh
apps/kenan-dev/deploy
```

The script builds and tests the app, installs `kenan-dev`, and confirms that the current Kenan package is still installed beside it.
