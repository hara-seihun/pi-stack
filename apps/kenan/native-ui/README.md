# Native Android fixture workbench

The workbench draws production Android Views using Robolectric's native Skia renderer. `NativeUiCatalogueTest` exercises the overlay's finite visual states, `NativeShells.SignIn` and the real `EditorActivity` lifecycle. The gallery displays captured PNGs rather than HTML replicas. [`catalogue.json`](catalogue.json) maps its source owners.

## Run on demand

Reuse the installed Android SDK, Java 21, Gradle/Robolectric cache, Capacitor dependency tree and generated Cordova plugin module:

```sh
apps/kenan/native-ui/render /absolute/output/native /absolute/existing/android/capacitor-cordova-android-plugins
```

The host's existing plugin directory is `/home/kenan/projects/pi-stack/apps/kenan/android/capacitor-cordova-android-plugins`. Both paths are explicit. The command supplies an ignored loopback-only `local.properties` and plugin symlink only when absent, preserving an existing router configuration. Gradle is offline with one worker and bounded JVM heaps; generated build/cache/render output belongs to the supplied output directory. Ordinary unit tests skip rendering unless its explicit output property is set.

The workbench uses synthetic identities and an ephemeral loopback editor fixture. It does not contact a person's phone, session or live router. Open the generated `index.html` to inspect the actual captures; deleting the output directory removes that run, not shared dependencies.

## Rendering owners

| Owner | States and boundary |
|---|---|
| `KenanOverlay.Dot` | Idle/thinking/working, press/drag, touchable chat or finite action scope; capture hides the owned window |
| `KenanOverlay.Scene` | Text bubble, target/pointer, tap/swipe trails and dismissal target; finite Canvas animation |
| `NativeShells.Conversation` | Shared overlay panel, transcript, empty/whitespace/draft/8000-character input and Send readiness; real production controls |
| `NativeShells.Setup` / `SetupGate` | Scrollable mandatory setup explanation, current grant instruction, Grant all and Stop; native admission owner |
| `NativeShells.Editor` / `EditorActivity` | Opening/ready/typed failures, validated handoff and cleanup on close, identity change, stop or screen-off |
| `NativeShells.SignIn` | Native email/code instruction, rejection or connection failure with Reload/Cancel; third-party HTML is isolated |
| `MainActivity` | Bundled/downloaded client, setup gate, lifecycle and system-bar insets |
| `NotificationDelivery` | Kenaznia priority messages, private system placement or foreground toast; Android owns the shade and interruption policy |

The overlay fixture captures the real shared conversation panel and gesture Views. Editor profiles cover portrait, compact, landscape and large-font layouts. `manifest.json` records each run's captured dimensions and its editor lifecycle assertions.

The new setup shell is a production view but is not yet in the bitmap-render fixture. Permission-state and revocation admission are covered by `PhoneSetupTest`; Android owns grant dialogs and special-access screens. Real WebView contents, IME, system insets/compositing, notification shade and installer consent are outside this offline renderer. Captures remain an interactive workbench, not a standing review programme.
