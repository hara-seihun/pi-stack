# Phone control

Pi Remote owns an unattended Android control connection. The Kenan Android app initiates an authenticated WebSocket through its existing router and permitted environment; Wi-Fi, ADB and Shizuku are not required. Tailscale remains the phone's VPN. Each Unix person's supervisor owns only phones connected with that person's session. CLI clients use the existing authenticated supervisor transport, not a publicly exposed phone listener.

## Wire contract

- Android connects `GET /v1/phones/connect` with existing `x-pi-remote-session` and `x-pi-remote-user` headers. Discover permitted environments using `RemoteEnvironment` and `RemoteTransport`; mirror the selected environment in phone settings. Do not put session credentials into the URL.
- First Android frame: `{type:"hello",device:{id,name,model,android,capabilities}}`. `id` is a persistent app-private UUID, `capabilities` is a JSON object of effective grants/state. Android refreshes that same hello only when the advertised device/grants actually change, checked on setup return, app resume, accessibility/notification-listener transitions and screen/unlock broadcasts. Server acknowledges `{type:"ready"}`.
- Android sends `{type:"heartbeat"}` every 25 seconds; server replies `{type:"ready"}` and refreshes `lastSeen` without rebuilding capabilities or invoking enrollment hooks. This application heartbeat reaches both router and supervisor (each has a 45-second WebSocket idle timeout); WebSocket control pings alone do not cross the proxy. No independent native ping schedule runs. An unacknowledged heartbeat terminates the native connection rather than renewing a dead lease.
- Server command: `{type:"command",id,command,args,deadline}`. `id` is a unique command identity; `deadline` is Unix milliseconds. Commands must not execute after expiry. Android deduplicates command IDs within a connection/reconnect window and never automatically replays unconfirmed mutations. Server does not retry uncertain commands.
- Android reply: `{type:"result",id,ok:true,result}` or `{type:"result",id,ok:false,error:{code,message}}`. Permission, unsupported, disconnected and unconfirmed are real outcomes, never success placeholders. The application heartbeat above owns ordinary connection liveness.
- `GET /v1/phones` returns `{phones:[{id,name,model,android,capabilities,connected,lastSeen}]}`.
- `POST /v1/phones/:id/commands` accepts `{command,args?,timeoutMs?}` and returns the exact result envelope. Default timeout 15 seconds, ceiling 60 seconds. Offline phones fail immediately; commands are not queued for later execution.
- `GET /v1/phones/commands` returns the supported command catalogue/help.

## Native bridge / setup UI contract

`KenanRemote.phoneStatus()` returns `{enabled,connected,deviceId,name,environment,error,capabilities}`, with `error:null` or `{code,message}`. `capabilities` uses booleans for `accessibility`, `installPackages`, `screenshots`, `notificationAccess`, `notifications`, `battery`, `allFiles`, `contacts`, `calendar`, `location`, `backgroundLocation`, `sms`, `callLog`, `phone`, `camera`, `microphone`, `usage`, `writeSettings`, `secureSettings`, `deviceOwner`, `deviceAdmin`, `overlay` (the Android display-over-apps grant, distinct from the top-level overlay visibility preference; plus other informational fields if needed).

`phoneConfigure({enabled,user,environment,name?})` persists the explicit local user's enable/disable choice and chosen permitted environment; enabling requires the mirrored identity to match `user`. Session logout/change terminates the connection and fences stale commands from the previous identity. Explicit enablement remains bound to the consenting owner user, not one token: reauthentication by that same owner resumes the saved choice and environment without setup again. A different person cannot inherit that choice and needs their own explicit enablement.

**Machine → Permissions → Grant all permissions** is the single setup for phone control, notifications and Android updates. `web/src/permissions-setup.tsx` shows binary **Ready** / **Not ready**, with no per-grant controls or checkmark inventory. `web/src/phone-access.ts` owns the complete ordinary-grant catalogue and sequence, including the phone-control accessibility service and install-source approval. Setup skips effective grants, awaits each Android return, and continues after declines. Every catalogue grant must be true before new phone-control enablement and notification activation; visiting every screen does not establish readiness. Retry uses the same button and re-read grants. Identity changes, unmount and Stop setup fence further requests; setup never tests a capability by executing a phone command. Existing capability-scoped commands do not acquire extra rights from this aggregate presentation.

`phoneSetup({step})` opens a one-time Android special-access settings page or requests runtime permissions. It resolves with fresh phone status after the activity/prompt returns, not when it opens, and rejects overlapping requests. Steps: `accessibility`, `installPackages`, `notificationAccess`, `notifications`, `battery`, `allFiles`, `contacts`, `calendar`, `location`, `backgroundLocation`, `sms`, `callLog`, `phone`, `camera`, `microphone`, `usage`, `overlay`, `writeSettings`, `deviceAdmin`. Background location follows foreground location and uses application permission settings on Android 11+. Permanently denied runtime grants use app settings on retry. Unavailable settings/restricted grants remain missing without stopping the sequence. Device Owner and secure-settings shell grants are separate provisioning powers, outside ordinary app permissions and aggregate readiness; setup never resets or enrolls the device.

## Command names

Core UI/notification operations: `status`, `overlay.show`, `overlay.hide`, `overlay.say`, `overlay.point`, `overlay.move`, `overlay.state`, `overlay.clear`, `ui.tree`, `ui.tap`, `ui.swipe`, `ui.text`, `ui.action`, `ui.global`, `screen.capture`, `app.launch`, `url.open`, `clipboard.set`, `notifications.list`, `notifications.dismiss`, `notifications.action`, `notifications.reply`.

Data/device operations: `device.info`, `apps.list`, `files.list`, `files.read`, `files.write`, `files.mkdir`, `files.delete`, `contacts.list`, `contacts.get`, `contacts.insert`, `calendar.list`, `calendar.events`, `calendar.instances`, `calendar.insert`, `location.get`, `sms.list`, `sms.send`, `calls.list`, `call.dial`, `usage.query`, `settings.get`, `settings.put`, `device.lock`, `device.reboot`, `device.wipe`, `apps.suspend`, `permissions.grant`.

Arguments and output shapes are documented by the implemented CLI catalogue. `screen.capture` returns `{mime:"image/png",base64,width,height}`; the CLI can save it to an exact requested path. `files.read`/`files.write` use base64 for binary data and explicit size ceilings. Destructive operations need an explicit `confirm:true` argument; they are available capabilities, never setup actions or acceptance probes.

## Kenan overlay

Phone control supplies one movable Kenan overlay dot. While its accessibility service runs, toggle the overlay with **Permissions → Overlay preferences → Show Kenan over other apps**, the phone-control notification's Show/Hide action, or `overlay.show`/`overlay.hide`. Tap Kenan to open the small chat panel; Send collapses it so the app underneath keeps focus. The dot remembers its saved edge and height and stays above the keyboard.

Dragging the dot exposes a labelled **Kenan** dismissal target above the keyboard. Release there to turn off the persistent `overlayVisible` preference, just like `overlay.hide`. Replies and `overlay.say` respect this hidden choice rather than showing Kenan again. Use `overlay.show`, the overlay-preferences toggle, or the notification's Show action to restore it explicitly.

A disabled overlay owns no windows, geometry-refresh work or animation timers. Phone control remains enabled and operational independently.

- Phone→server frame: `{type:"overlay.message",id,text,context:{package,label}}` (text 1..8000). The supervisor replies `{type:"overlay.ack",id,ok:true,threadId}` or `{type:"overlay.ack",id,ok:false,error}`. `server/phone-overlay.ts` owns the conversation: each phone has one thread (`Phone · NAME`, Home destination, default model), recorded in supervisor metadata `phone-overlay:DEVICE`; an archived or missing thread is replaced on the next message. The first message carries a briefing on using the overlay; later messages are steered into the running thread with a `[Phone overlay · in APP]` line.
- Thread events drive the dot: inserted message → `overlay.state thinking`, tool start → `working`, every assistant message's text (Remote tags removed, ≤2000 chars) → `overlay.say`, settlement → `idle`. A reply produced while the phone is offline is spoken once when it reconnects.
- Agent-facing commands: `overlay.say {text,x?,y?,nodeId?,durationMs?}`, `overlay.point` with exactly one of `x+y`, `left+top+right+bottom` or `nodeId` (optional `text`), `overlay.move {x,y}`, `overlay.state`, `overlay.clear`. CLI: `pi-phone say TEXT [X Y]`, `pi-phone point X Y [TEXT]`, `pi-phone overlay show|hide|clear`.
- `ui.tap`, `ui.swipe`, `ui.action` and `ui.text` are visualised: the dot flies to the target, then a ripple, trail or highlight shows the action. Touchable overlay windows become non-touchable while a gesture runs, and the animation is skipped when it would push a gesture past its deadline. `screen.capture` hides the overlay for the capture.

## CLI

The installed `pi-phone` executable uses the current Remote thread's `PI_REMOTE_SERVER_URL`, or discovers the current Unix person's own loopback supervisor from their registry. It never borrows another person's credentials. No device argument is needed when exactly one phone is online; use `--device ID` to select among several.

```sh
pi-phone list
pi-phone catalogue                    # command names, argument shapes, grant requirements
pi-phone catalogue contacts.get
pi-phone --device ID status
pi-phone --device ID tree
pi-phone --device ID tap 100 300
pi-phone --device ID screenshot --out /absolute/path/screen.png
pi-phone --device ID command contacts.get '{"contactId":42}'
pi-phone --device ID command calendar.instances '{"start":1790800000000,"end":1791400000000}'
pi-phone --device ID files read /sdcard/Download/example.txt --output /absolute/path/example.txt
pi-phone --device ID files write /sdcard/Download/example.txt --input /absolute/path/example.txt
```

`command COMMAND JSON` accepts the exact command arguments, or `-` for JSON on stdin. Explicit file overwrite requires `--overwrite --confirm`; irreversible/destructive commands, outgoing SMS and calls require `confirm:true`. Successful telephony submission is not proof of carrier delivery or an answered call. A timeout/disconnect after dispatch is an unconfirmed result; inspect the phone before deciding whether to repeat a mutation.

For a router endpoint on another environment, set `PI_PHONE_URL` to the authorized router origin plus its permitted environment prefix and supply the existing `PI_REMOTE_SESSION` through the environment, not a command-line argument. The phone is attached to the environment selected during native setup; it is not broadcast to every granted environment.

Read/list responses are bounded and carry pagination. File reads/writes are limited to 1 MiB per command; reads include `nextOffset` for further chunks, and the CLI rejects saving a partial read as a complete file. Contacts list supplies identities; `contacts.get` reads phone/email/address rows by MIME. `calendar.events` reads stored event records, while `calendar.instances` expands recurring occurrences in a requested range. The command catalogue is owned by `server/phone-commands.ts`; CLI and HTTP expose the same catalogue.

## Boundaries

Permissions and special access require initial approval on the phone. The service does not enable itself, reset a phone, enroll Device Owner, change default apps, or send messages during setup. Accessibility screenshots avoid per-session MediaProjection dialogs, but are rate-limited and exclude protected content. Other apps' private data, hardware-backed secrets and bypassing authentication remain outside this interface. Password text is redacted from automatic tree inspection, but the authorized owner can supply text/actions to password fields or the lock screen wherever Android permits ordinary Accessibility interaction. Use JSON stdin rather than CLI arguments for secrets; commands do not store their argument bodies in the replay ledger. Microphone/camera permission setup does not promise unrestricted unattended capture. Force stop prevents background work until the app opens; first unlock after reboot may be needed. A persistent foreground connection, reconnect and boot handling restore enabled operation where Android permits. Device Owner and one-time ADB secure-settings grants are optional additional powers, not prerequisites.
