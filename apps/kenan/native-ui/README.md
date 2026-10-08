# Native Android UI catalogue

The native fixture draws **the production Android Views** with Robolectric's native Android Skia renderer. `NativeUiCatalogueTest` owns a closed `OverlayCase` enum and renders every case; `NativeShells.SignInState` owns the sign-in message variants used by both the app and fixture. The editor fixture invokes the same `NativeShells.editor` constructor as `EditorActivity`. The HTML gallery displays PNGs, not HTML replicas of Android controls.

## Run

Reuse the installed Android SDK, Java 21, Gradle/Robolectric cache, Capacitor dependency tree and generated Cordova plugin module. No emulator or phone is touched, and no live session, router, editor or Access service is contacted.

```sh
apps/kenan/native-ui/render /absolute/evidence/native /absolute/existing/android/capacitor-cordova-android-plugins
```

The current host's existing plugin directory is `/home/kenan/projects/pi-stack/apps/kenan/android/capacitor-cordova-android-plugins`. The script requires both paths explicitly. It creates ignored `local.properties` with the installed SDK and a loopback synthetic router only if absent, and an ignored symlink to the existing generated plugin directory only if absent. It does not replace a checkout's configured router. Gradle is offline, one worker, 512 MiB heap; the render JVM is also 512 MiB. Build output and Gradle project cache live under the supplied evidence directory, outside the source checkout. Its normal unit-test invocation skips render work unless the explicit output property is supplied.

For work exceeding the shell ceiling, give the command to `kjob run NAME --owner-thread THREAD --cwd CHECKOUT -- ...`. The durable job owns its exit receipt. View `index.html` through native `agent_browser` with `--allow-file-access` and inspect screenshots. A successful build or generated PNG is not a visual judgment.

`manifest.json` lists each rendered state and its rendering boundary; `review.json` records the actually viewed states for a particular capture. Generated bitmaps, galleries, logs and build output are not checked in. Delete the supplied output directory to remove this fixture's generated state; never delete shared SDK/dependency caches.

## Finite native inventory

| Production owner | Valid visual variants | Content boundary | Fixture scope |
|---|---|---|---|
| `KenanOverlay.Dot` | idle, thinking, working; pressed; touchable chat or finite non-touchable action; hidden during capture; closed | 50 dp window, restored left/right edge and clamped height; working overrides state during gesture | Real Dot drawing, synthetic placement |
| `KenanOverlay.Scene` reply bubble | absent, empty, short, multiline, truncated long; left/right tail | `overlay.say` protocol maximum 2000 characters; six ellipsized lines; width 75% of screen minus padding | Real `StaticLayout` and Canvas |
| Scene target | absent, circular point, positive-size rounded rectangle, pointer line | Coordinates must be finite and inside display; stale node or invalid bounds returns typed failure | Real Canvas target drawing |
| Scene gestures | absent, tap ring, swipe progress/trail | Finite gesture scope, dot non-touchable while executing | Actual Android Canvas and timed state |
| Scene dismissal target | absent, dragging away, dragging over target | Active only during chat-dot drag; dropping hides chat persistently | Actual touch dispatch and Canvas |
| `KenanOverlay.Panel` | closed, open empty, transcript, editable draft; empty/short/maximum draft; large font; keyboard-visible geometry | Transcript retains last 20 entries; draft input max 8000 characters; 2–4 displayed input lines; scrollable history | Real Panel/controls/InputFilter; system IME **not rendered** |
| Overlay send feedback | accepted/thinking; unavailable, uncertain receipt, disconnect and remote error bubbles | No retransmission after uncertain receipt; message text uses bubble/history rendering | Same bubble primitive; send transport **not exercised** |
| `NativeShells.Editor` / `EditorActivity` | one secure close-button/WebView shell; consuming valid handoff, loaded document; error/revocation/lock closes shell with toast | One-use 30-second owner-bound ticket; navigation restricted to editor origin; session checks every 5 seconds; closes on stop | Actual shell; remote editor HTML, FLAG_SECURE, navigation/lock lifecycle **not viewed** |
| `NativeShells.SignIn` / `AccessSignIn` | email/code instruction, rejected sign-in, unreachable service; Reload/Cancel | Third-party email/code DOM lives in separate bridge-free WebView | Actual controls and typed messages; third-party HTML/Dialog compositor **not viewed** |
| `MainActivity` | built-in or downloaded fitting web bundle inside same shell; resumed/paused | Status/cutout margins, dark system bar icons; shared React UI owns visible update banners/navigation | Native inset/system-bar compositor **not viewed** |
| `AppUpdates` / plugin | no available update, web activation/reload, APK download/installer intent, transfer/identity/signature failures | Closed `NativeState.UpdateKind` WEB/APK; package/install consent belongs to Android | Update presentation belongs to shared web catalogue; Android installer/settings **not viewed** |
| Launcher and launch theme | adaptive foreground/background launcher; splash | Density-specific resources, launch-theme Android splash timing | System launcher/splash **not viewed** |
| `NotificationDelivery` | idle completion, question, attention; collapsed or expanded/private lockscreen | Title includes environment/thread and Question label; native body; large head/small monochrome icon | Notification shade/lockscreen/heads-up **not viewed** |
| `PhoneControlService` notification | ongoing status; Hide/Show Kenan action; Disable | Status text and actual overlay visibility choose actions | Android system notification compositor **not viewed** |
| `IdleNotificationService` notification | monitoring, no permitted environments, discovery/polling errors | Ongoing, only-alert-once; bounded latest detail | Android system notification compositor **not viewed** |
| Native toasts | permission instruction, invalid client Back result, editor session errors/navigation restriction | Android owns placement, duration and accessibility | System toast compositor **not viewed** |
| Permission/setup surfaces | runtime grant dialogs, special access settings, installer approval | Closed `NativeState.PhoneSetup`; only effective grants count | Android-owned screens **not viewed** |

Protocol/state variants with identical Views are grouped by their rendering fibre, not multiplied into fictional combinations. Capture hides all owned Views; closed removes them. Action-only cannot open chat or produce chat replies. Editor errors close rather than render a persistent native error screen. APK/web update selection is not an extra native banner.

## Coverage limits

The native Skia render is an actual-view visual review at API 28 and a specified synthetic viewport. It is **not** emulator instrumentation, a real WebView page capture, a device screenshot, or an Android 36 system-compositor review. The test window adapter preserves production dimensions, placement, visibility and View hierarchy, but does not own system insets, input methods, accessibility window tokens, shadow elevation, notification shade or installer UI. Those states remain explicitly unviewed until separately captured on an isolated emulator. Do not infer full native-state coverage from the PNG count.
