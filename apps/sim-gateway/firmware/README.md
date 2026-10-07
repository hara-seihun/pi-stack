# Standalone ESP32 SIM audio bridge

This firmware makes an **original ESP32** a Bluetooth HFP Hands-Free accessory for a phone, and carries that phone's SIM-call audio over Wi-Fi to Pi Stack. It is not an Android app, audio loopback, GSM modem, or audio-output dongle. After provisioning/pairing, it needs USB **power**, not a nearby computer. Initial flashing and numeric pairing confirmation still need physical access and a USB serial host.

## Hardware and phone prerequisites

- ESP32-WROOM-32 / WROOM-32E / ESP32-DevKitC, dual-core original ESP32, at least 4 MB flash. **ESP32-S3, C3, C6 and S2 cannot substitute:** they lack Classic Bluetooth HFP support.
- Stable USB power and 2.4 GHz Wi-Fi Internet access. No microphone, speaker, DAC, ADC, I2S wiring or USB audio adapter is required; SCO uses HCI in both controller and host.
- A nearby phone with an active SIM, ordinary Bluetooth headset calling support and explicit pairing consent. The phone remains the cellular modem. Calls consume its plan and present its SIM caller identity; the firmware does not discover/configure that number.
- A device registration and **device-specific** gateway token from the Pi Stack owner; never an administrator credential. The default external route is `wss://calls.kenan.works/gateway/connect`.

The implementation has been cross-compiled and host-tested, **not flashed or tested against a phone**. No hardware was bought or delivered and no call was placed. RF coexistence, handset CLCC identity reporting, SCO negotiation, actual two-way audio and real call termination still need hardware acceptance.

## Reproducible build and owner provisioning

Pinned dependencies: **ESP-IDF v5.4.2**, target `esp32`, managed `espressif/esp_websocket_client` **1.4.0** (`dependencies.lock`). Install IDF outside this repository; do not commit its toolchain or generated dependencies.

```bash
# In a toolchain directory; fetch required submodules too.
git clone --branch v5.4.2 --depth 1 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32
. ./export.sh

# Return to apps/sim-gateway/firmware.
umask 077
cp sdkconfig.owner.example sdkconfig.owner
chmod 600 sdkconfig.owner
# Edit sdkconfig.owner privately: SSID/password, allowed phone Classic BT address,
# server URL, gateway ID and this device's token. Do not print/share that file.
idf.py -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.owner' build
```

Use a fresh generated `sdkconfig` when changing defaults, or update its values through `idf.py menuconfig`. Defaults do not overwrite values already saved in `sdkconfig`. The owner file, generated config, build directory and firmware images are gitignored. Config and binary **contain the Wi-Fi password and device token**; keep their files owner-only, and do not distribute provisioned images or build logs containing configuration dumps. The build refuses IDF versions other than 5.4.2. Without nonempty provisioning it boots inert and starts neither radio nor calls.

With explicit authorization and physical USB access, flash the owner's image with `idf.py -p /dev/ttyUSB0 flash monitor` (substitute the actual device port). Flashing is not part of the recorded build proof. Do not flash the compile-test image.

### Pairing

Configure the allowed phone's **Classic Bluetooth address** first. Open its Bluetooth settings and pair `Kenan SIM bridge` while the gateway serial console is attached at 115200 baud. Compare the phone's six-digit number against the serial prompt, then type `confirm 123456` with the actual matching number within 30 seconds; also accept the phone's own consent prompt. Unknown addresses are never numerically confirmed. Legacy PIN/passkey entry is rejected, not silently accepted. Bonds live in NVS and survive reboots; initialization failures do not erase them. Changing phones requires owner reprovisioning and deliberate bond removal, not auto-discovery.

Serial confirmation is only for pairing. Runtime control comes from the authenticated server, so an unattended powered bridge can work without keeping the serial host connected. If the phone fails to expose a usable Bluetooth address or numeric consent flow, stop and record the handset incompatibility rather than approving an unknown peer.

## Runtime contract

- `Authorization: Bearer <device token>` on the WebSocket upgrade; certificate chain/host validation via IDF's CA bundle. One `hello` immediately on each connection, with configured `id`, name `Kenan SIM bridge`, `sampleRate:16000`, `ready` and a short reason when unavailable. Refresh on HFP/readiness changes. `heartbeat` every 15 seconds.
- Readiness waits for an allowlisted HFP service-level connection and initial phone call/setup/held indicators. Another local or incoming phone call makes the gateway unavailable; no incoming call is auto-answered and no unsolicited audio is forwarded. An owned active call itself does not make `ready` false; the server owns its reservation. Closing a call does make it false.
- Accept exactly one explicit `dial` with UUID `callId`, E.164 `number` (7–15 digits) and integral `maxSeconds` (30–1800). No autonomous dial, redial, retry, or replay after reconnection. Duplicate IDs among the last 64 commands in this boot are rejected; this is not durable idempotency across reboot, and the server must not resend an old dial command.
- Report `dialing`, `ringing`, then `active` **only after** the cellular call is present, CLCC identifies an outgoing call to the requested number, and SCO is connected. CLCC accepts the same E.164 number with or without `+`; phones that omit/rewrite the number fail closed. Identity/SCO must become usable within eight seconds after the answer indication.
- `hangup` only matches the owned call ID. Its reservation is retained until physical HFP idle indicators arrive; then report `ended`, or `failed` when a local error prompted termination. The local deadline runs from accepted dial, not answer. If a hangup is unconfirmed after eight seconds, disconnect HFP and report `failed:hangup_unconfirmed`, not a fabricated `ended`.
- Transport loss, a new server session, queue overflow and the local deadline mute/clear both media rings and terminate the owned call. They never redial. Held/multiple calls, an incoming conflict or a CLCC identity mismatch mute and disconnect HFP **without AT+CHUP**, reporting `ownership_lost_hangup_unconfirmed`; hanging up a foreign phone call would be worse than leaving an unconfirmed call on the phone. An answered-but-unverified call uses the same fail-closed path. A dropped HFP link cannot guarantee cellular hangup; it reports that uncertainty.
- Unknown control types, malformed/trailing JSON, unknown transport/event IDs and invalid HFP state values fail closed. HFP states are checked before readiness, ownership or codec-rate mutation; invalid HFP input disconnects without hanging up a possibly foreign call. Known non-owning Bluetooth notifications and WebSocket startup notifications are explicitly enumerated. A non-owned `hangup` reports `failed:unknown_call`, without issuing AT+CHUP.
- Binary WebSocket messages are exactly **640 bytes / 20 ms**, mono signed little-endian PCM16 at **16 kHz**, both directions. Application messages must fit one RFC6455 frame; receive-buffer chunks within that frame are reassembled. Control JSON is limited to 1024 bytes. Unexpected binary sizes fail closed.
- HFP supplies PCM at 8 kHz CVSD or 16 kHz mSBC. CVSD is converted with streaming 2× linear interpolation toward the network, and a seven-tap low-pass FIR/2× decimation toward the phone. Two bounded 120-ms rings discard stale backlog on overflow. Phone transmit underruns produce silence; received phone audio is never fed back to the phone. Callback paths are nonblocking; network sending and call ownership live in the gateway task.
- Software Wi-Fi/Bluetooth coexistence is enabled, Bluetooth controller and Bluedroid run on core 1, and Wi-Fi/control on core 0. Hardware testing must still establish latency, drop rate and audio quality on the actual handset/network.

## Tests and build receipt

```bash
# Requires the IDF checkout's actual Bluetooth declarations and cJSON source.
IDF_PATH=/path/to/esp-idf ./tests/run-host.sh

# Proves the full Wi-Fi/HFP implementation links; all credentials here are fake.
# Empty production defaults alone allow the optimizer to remove inert radio code.
idf.py -B build/compile-proof -D SDKCONFIG=build/compile-proof.sdkconfig \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;tests/sdkconfig.compile' build
```

[Host regressions](tests/test_gateway.c) include unknown commands/events, invalid HFP
states, reserved frame opcodes, and accepted known notification no-ops. Host tests
compile the same lifecycle, framing, HFP callback, consent and DSP implementation with fake transport/radio effects, real v5.4.2 Bluetooth declarations and real cJSON. Address/undefined-behavior sanitizers cover the host run. They are not RF or handset tests. See [BUILD-RECEIPT.md](BUILD-RECEIPT.md) for exact compile/test proof and the hardware acceptance gap.

Primary references: [v5.4.2 HFP HF example](https://github.com/espressif/esp-idf/tree/v5.4.2/examples/bluetooth/bluedroid/classic_bt/hfp_hf), [HFP client API](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32/api-reference/bluetooth/esp_hf_client.html), [coexistence](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32/api-guides/coexist.html), [WebSocket client 1.4.0](https://components.espressif.com/components/espressif/esp_websocket_client/versions/1.4.0/readme).
